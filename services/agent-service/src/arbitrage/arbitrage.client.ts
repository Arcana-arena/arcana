import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** One agent's arbitrage switch, as the arbitrage service reports it. */
export type ArbitrageSetting = {
  agent_id: string;
  /** false when no row exists: "never asked for" and "switched off" are both off. */
  exists: boolean;
  enabled: boolean;
  enabled_at: string | null;
  disabled_at: string | null;
  updated_by?: string;
  updated_at: string | null;
};

/**
 * The arbitrage opt-in, seen from the owner's side.
 *
 * WHY THE WRITE GOES THROUGH HERE AND NOT THE BROWSER. Whether a caller may
 * decide something about an agent is ownership, and ownership lives in
 * agent-service (`assertOwnsAgent`, called in the controller before this runs).
 * The arbitrage service accepts the write only from the machine tier, with the
 * internal key, and records the creator's wallet as the actor — so every switch
 * about somebody's funds has a name against it and cannot be thrown from a
 * browser that has not proved who it is.
 *
 * THE FAILURE DIRECTION IS "DO NOT ACT". An unreachable arbitrage service
 * throws; it never answers with a default that could read as enabled. A read
 * that fails is reported as such and the page renders no switch state rather
 * than a false one.
 */
@Injectable()
export class ArbitrageClient {
  private readonly logger = new Logger(ArbitrageClient.name);
  private readonly url: string;
  private readonly internalKey: string;

  constructor(config: ConfigService) {
    this.url = config.get<string>('ARBITRAGE_URL') ?? 'http://127.0.0.1:8084';
    this.internalKey = config.get<string>('INTERNAL_API_KEY') ?? '';
  }

  async get(agentId: string): Promise<ArbitrageSetting> {
    const body = await this.call<{ setting: ArbitrageSetting }>('GET', `/v1/arbitrage/agents/${agentId}/settings`);
    return body.setting;
  }

  async set(agentId: string, enabled: boolean, actor: string): Promise<ArbitrageSetting> {
    const body = await this.call<{ setting: ArbitrageSetting }>(
      'POST',
      `/internal/v1/arbitrage/agents/${agentId}/settings`,
      { enabled, actor },
    );
    this.logger.log(`arbitrage ${enabled ? 'enabled' : 'disabled'} for agent ${agentId} by ${actor}`);
    return body.setting;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // The write is machine-tier and has to be keyed; the read is public, so it
    // works even when the key is missing (which is how a misconfigured
    // deployment still shows the truth instead of failing to render).
    if (method !== 'GET' || path.startsWith('/internal/')) {
      if (!this.internalKey) {
        throw new ServiceUnavailableException({
          code: 'arbitrage_unavailable',
          message:
            'INTERNAL_API_KEY is not configured, so agent-service cannot write arbitrage settings. Nothing was changed.',
        });
      }
      headers['X-Internal-Key'] = this.internalKey;
    }

    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      this.logger.error(`arbitrage unreachable at ${this.url}${path}: ${e}`);
      throw new ServiceUnavailableException({
        code: 'arbitrage_unavailable',
        message: 'The arbitrage service could not be reached. Nothing was changed — try again shortly.',
      });
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { message: text.slice(0, 200) };
    }

    if (!res.ok) {
      const p = parsed as { error?: { code?: string; message?: string }; message?: string };
      const code = p.error?.code ?? 'arbitrage_error';
      const message = p.error?.message ?? p.message ?? `the arbitrage service answered ${res.status}`;
      // 5xx is "we could not", 4xx is "that request is wrong" — kept apart so
      // the caller's next step differs, the same rule the signer client uses.
      if (res.status >= 500) {
        throw new ServiceUnavailableException({ code, message });
      }
      throw new BadRequestException({ code, message });
    }
    return parsed as T;
  }
}
