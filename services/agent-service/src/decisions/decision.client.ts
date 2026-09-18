import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AUTH_CONFIG, authUnavailable, type AuthConfig } from '@arcana/auth';
import { Inject } from '@nestjs/common';

/**
 * Forwards a human's trade to the decision engine.
 *
 * The engine's `POST /internal/v1/decisions/manual` used to be the public door
 * for human submissions, which put a user action behind a prefix that means
 * "machines only". The user-facing door is now
 * `POST /v1/agents/:id/decisions` here — where sessions and ownership live —
 * and the engine keeps the internal endpoint it always had, reached with the
 * machine key.
 *
 * Auth is checked once, in agent-service, by the service that can check it.
 * The engine is not asked to learn about wallets.
 */
@Injectable()
export class DecisionClient {
  private readonly logger = new Logger(DecisionClient.name);
  private readonly engineUrl: string;

  constructor(
    config: ConfigService,
    @Inject(AUTH_CONFIG) private readonly authCfg: AuthConfig,
  ) {
    this.engineUrl =
      config.get<string>('DECISION_ENGINE_URL') ?? 'http://127.0.0.1:8081';
  }

  async submitManual(payload: Record<string, unknown>): Promise<unknown> {
    if (!this.authCfg.internalKey) {
      throw authUnavailable(
        'INTERNAL_API_KEY is not set, so agent-service cannot call the decision engine',
      );
    }

    let res: Response;
    try {
      res = await fetch(`${this.engineUrl}/internal/v1/decisions/manual`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': this.authCfg.internalKey,
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw this.upstream(`decision engine unreachable: ${String(e)}`, null);
    }

    if (!res.ok) {
      throw this.upstream(await res.text(), res.status);
    }
    return res.json();
  }

  /**
   * The engine's own code, when it named one.
   *
   * The engine emits `{error:{code,message}}` and, since the market-data client
   * started carrying codes, that code is the actual cause —
   * `snapshot_not_found`, `vendor_unavailable`, `invalid_request` — rather than
   * one word for everything. Replacing it here would undo the whole chain at
   * the last hop.
   */
  private parseUpstream(text: string): { code: string | null; message: string } {
    try {
      const body = JSON.parse(text) as { error?: { code?: string; message?: string } };
      const code = typeof body?.error?.code === 'string' ? body.error.code : null;
      return { code, message: body?.error?.message ?? text };
    } catch {
      return { code: null, message: text };
    }
  }

  /**
   * An engine failure is reported as an engine failure. It is not folded into a
   * 403, because the caller's ownership was already established — telling them
   * "forbidden" here would blame them for our outage.
   */
  private upstream(message: string, status: number | null): HttpException {
    const traceId = randomUUID();
    const parsed = status === null ? { code: null, message } : this.parseUpstream(message);
    this.logger.error(
      `manual decision submit failed (${status ?? 'no response'}) [trace ${traceId}]: ${message}`,
    );
    // THE CODE SURVIVES WHATEVER THE STATUS WAS. `vendor_unavailable` arrives
    // as a 503 and `snapshot_not_found` as a 422; both are the answer, and
    // keeping only the first would lose exactly the distinction this chain was
    // rebuilt to carry.
    //
    // The STATUS is mapped rather than echoed, because it means something
    // different once it crosses a boundary. A 4xx is a fact about the request
    // and passes through — an engine that refused a malformed payload used to
    // be reported as "the decision engine is unavailable", a diagnosis pointing
    // at the wrong machine and the opposite of what the engine said. A 503 is a
    // downstream outage and stays a 503. Any other 5xx is this platform
    // failing, which is a 502 to the caller — but it keeps its code.
    const code = parsed.code ?? 'decision_engine_unavailable';
    let out: number = HttpStatus.BAD_GATEWAY;
    if (status !== null && parsed.code !== null) {
      if (status >= 400 && status < 500) out = status;
      else if (status === HttpStatus.SERVICE_UNAVAILABLE) out = HttpStatus.SERVICE_UNAVAILABLE;
    }
    return new HttpException(
      {
        error: {
          code,
          message:
            out === HttpStatus.BAD_GATEWAY
              ? `Could not record the trade: ${parsed.message}`
              : parsed.message,
          trace_id: traceId,
        },
      },
      out,
    );
  }
}
