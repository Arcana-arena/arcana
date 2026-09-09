import { Global, Logger, Module } from '@nestjs/common';
import { AUTH_CONFIG } from './auth-context';
import { describeAuth, loadAuthConfig, type AuthConfig } from './config';
import { AdminGuard, InternalKeyGuard, JwtAuthGuard } from './guards';

/**
 * Provides the process-wide AuthConfig plus the three guards, and states the
 * auth posture in the boot log.
 *
 * The log line is the point of `logStatus`. It sits alongside arca-service's
 * five boot warnings and market-data's vendor warning, and it obeys the same
 * rule those established: INACTIVE never means open. When auth cannot run, the
 * protected surface returns 503 and the log says exactly that, so nobody
 * reading the journal six months from now has to guess whether a warning meant
 * "unguarded" or "closed".
 */
@Global()
@Module({})
export class ArcanaAuthModule {
  static forRoot(serviceName: string) {
    const cfg = loadAuthConfig();
    ArcanaAuthModule.logStatus(serviceName, cfg);

    return {
      module: ArcanaAuthModule,
      providers: [
        { provide: AUTH_CONFIG, useValue: cfg },
        JwtAuthGuard,
        AdminGuard,
        InternalKeyGuard,
      ],
      exports: [AUTH_CONFIG, JwtAuthGuard, AdminGuard, InternalKeyGuard],
    };
  }

  private static logStatus(serviceName: string, cfg: AuthConfig): void {
    const logger = new Logger(`${serviceName}:auth`);
    const status = describeAuth(cfg);

    if (status.tokensActive) {
      logger.log(
        `auth ACTIVE: HS256 access tokens enforced, ttl=${cfg.accessTtlSeconds}s, ` +
          `refresh ttl=${cfg.refreshTtlSeconds}s, chains=[${cfg.allowedChainIds.join(',')}], ` +
          `admin wallets=${cfg.adminWallets.length}`,
      );
    } else {
      logger.warn(
        `WARN: auth INACTIVE: ${cfg.signingKeyProblem}. ` +
          'Every protected endpoint will reject with 503 auth_unavailable — ' +
          'INACTIVE does NOT mean open. Public reads are unaffected.',
      );
    }

    if (status.siweActive) {
      logger.log(
        `SIWE sign-in ACTIVE: domain=${cfg.siweDomain}, uri=${cfg.siweUri}, ` +
          `nonce ttl=${cfg.nonceTtlSeconds}s`,
      );
    } else {
      logger.warn(
        'WARN: SIWE sign-in INACTIVE: no wallet can obtain a session from this ' +
          'service. Existing tokens are unaffected.',
      );
    }

    if (status.internalTierActive) {
      logger.log('internal (machine) tier ACTIVE: X-Internal-Key required on /internal/*');
    } else {
      logger.warn(
        'WARN: internal tier INACTIVE: INTERNAL_API_KEY is not set. Machine ' +
          'endpoints will reject with 503 — the scheduler and batch jobs will ' +
          'NOT run until it is configured.',
      );
    }

    for (const problem of status.problems) {
      logger.warn(`WARN: auth configuration: ${problem}`);
    }
  }
}
