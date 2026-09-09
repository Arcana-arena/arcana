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
   * An engine failure is reported as an engine failure. It is not folded into a
   * 403, because the caller's ownership was already established — telling them
   * "forbidden" here would blame them for our outage.
   */
  private upstream(message: string, status: number | null): HttpException {
    const traceId = randomUUID();
    this.logger.error(
      `manual decision submit failed (${status ?? 'no response'}) [trace ${traceId}]: ${message}`,
    );
    return new HttpException(
      {
        error: {
          code: 'decision_engine_unavailable',
          message: `Could not record the trade: ${message}`,
          trace_id: traceId,
        },
      },
      HttpStatus.BAD_GATEWAY,
    );
  }
}
