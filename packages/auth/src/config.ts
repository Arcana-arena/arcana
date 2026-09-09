/** Minimum HS256 key length. Shorter keys are brute-forceable offline. */
const MIN_SIGNING_KEY_BYTES = 32;

/** Robinhood Chain: 4663 mainnet, 46630 testnet. Nothing else is accepted. */
export const DEFAULT_CHAIN_IDS = [4663, 46630];

export interface AuthConfig {
  /** HS256 secret. null when unset or too short — both mean "cannot verify". */
  signingKey: string | null;
  /** The only `Domain` a SIWE message may claim. null disables sign-in. */
  siweDomain: string | null;
  /** The only `URI` origin a SIWE message may claim. */
  siweUri: string | null;
  allowedChainIds: number[];
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  nonceTtlSeconds: number;
  /** Clock skew tolerated on a SIWE `Issued At`. */
  issuedAtSkewSeconds: number;
  /** Lowercased wallets allowed to perform 👑 operator actions. */
  adminWallets: string[];
  /** Shared secret for the ⚙️ machine tier (X-Internal-Key). */
  internalKey: string | null;
  issuer: string;
  audience: string;
  /** Why the signing key was rejected, when it was. */
  signingKeyProblem: string | null;
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const rawKey = env.AUTH_JWT_SIGNING_KEY?.trim() || null;

  // A key that is present but too weak is NOT silently accepted, and is not
  // silently treated as absent either — the reason is carried so the boot log
  // can say which of the two happened.
  let signingKey: string | null = null;
  let signingKeyProblem: string | null = null;
  if (!rawKey) {
    signingKeyProblem = 'AUTH_JWT_SIGNING_KEY is not set';
  } else if (Buffer.byteLength(rawKey, 'utf8') < MIN_SIGNING_KEY_BYTES) {
    signingKeyProblem =
      `AUTH_JWT_SIGNING_KEY is shorter than ${MIN_SIGNING_KEY_BYTES} bytes ` +
      '— refusing to sign with a guessable key';
  } else {
    signingKey = rawKey;
  }

  const chainIds = (env.AUTH_ALLOWED_CHAIN_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  return {
    signingKey,
    signingKeyProblem,
    siweDomain: env.AUTH_SIWE_DOMAIN?.trim() || null,
    siweUri: env.AUTH_SIWE_URI?.trim() || null,
    allowedChainIds: chainIds.length > 0 ? chainIds : DEFAULT_CHAIN_IDS,
    accessTtlSeconds: intFromEnv(env.AUTH_ACCESS_TTL_SECONDS, 15 * 60),
    refreshTtlSeconds: intFromEnv(env.AUTH_REFRESH_TTL_SECONDS, 30 * 24 * 3600),
    nonceTtlSeconds: intFromEnv(env.AUTH_NONCE_TTL_SECONDS, 5 * 60),
    issuedAtSkewSeconds: intFromEnv(env.AUTH_ISSUED_AT_SKEW_SECONDS, 5 * 60),
    adminWallets: (env.AUTH_ADMIN_WALLETS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
    internalKey: env.INTERNAL_API_KEY?.trim() || null,
    issuer: env.AUTH_ISSUER?.trim() || 'arcana',
    audience: env.AUTH_AUDIENCE?.trim() || 'arcana-api',
  };
}

export interface AuthStatus {
  /** True only when tokens can actually be verified. */
  tokensActive: boolean;
  /** True only when a wallet can complete a full sign-in here. */
  siweActive: boolean;
  internalTierActive: boolean;
  problems: string[];
}

export function describeAuth(cfg: AuthConfig): AuthStatus {
  const problems: string[] = [];
  if (cfg.signingKeyProblem) problems.push(cfg.signingKeyProblem);
  if (!cfg.siweDomain) problems.push('AUTH_SIWE_DOMAIN is not set');
  if (!cfg.siweUri) problems.push('AUTH_SIWE_URI is not set');
  if (!cfg.internalKey) problems.push('INTERNAL_API_KEY is not set');
  if (cfg.adminWallets.length === 0) {
    problems.push('AUTH_ADMIN_WALLETS is empty — no wallet can perform admin actions');
  }

  return {
    tokensActive: cfg.signingKey !== null,
    siweActive: cfg.signingKey !== null && !!cfg.siweDomain && !!cfg.siweUri,
    internalTierActive: cfg.internalKey !== null,
    problems,
  };
}
