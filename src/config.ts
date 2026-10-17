/**
 * Environment configuration for the connector.
 *
 * All settings come from environment variables (Netlify site settings in
 * production, a local .env file during development). See .env.example.
 */

export interface EspnConfig {
  /** espn_s2 cookie value. */
  s2: string;
  /** SWID cookie value, normalised to the `{UUID}` form ESPN expects. */
  swid: string;
  leagueId: number;
  /** Optional explicit team id; otherwise the team is detected from the SWID. */
  teamId?: number;
  season: number;
}

export interface AuthConfig {
  /** Password typed on the connector sign-in page. */
  password: string;
  /** HMAC key for OAuth codes/tokens. */
  secret: string;
  /** Optional static bearer token for local testing / request-header auth. */
  devBearerToken?: string;
  /** Additional redirect URI hosts allowed at dynamic client registration. */
  extraRedirectHosts: string[];
}

export interface AppConfig {
  espn: EspnConfig;
  auth: AuthConfig;
  timezone: string;
  /** Optional override for the public origin (custom domains behind proxies). */
  publicUrl?: string;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly missing: string[] = [],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

/**
 * The NFL season an ESPN league id refers to, for a given date.
 * July onwards is the upcoming/current season; January–June still belongs to
 * the season that started the previous calendar year.
 */
export function defaultSeason(now: Date = new Date()): number {
  const month = now.getUTCMonth() + 1;
  const year = now.getUTCFullYear();
  return month >= 7 ? year : year - 1;
}

export function normalizeSwid(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("{")) s = s.slice(1);
  if (s.endsWith("}")) s = s.slice(0, -1);
  return `{${s.toUpperCase()}}`;
}

function readInt(env: Env, key: string): number | undefined {
  const v = env[key]?.trim();
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ConfigError(`${key} must be an integer, got "${v}"`);
  return n;
}

function readList(env: Env, key: string): string[] {
  return (env[key] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validate and load configuration. Throws ConfigError listing every missing
 * required variable at once so a misconfigured deploy is easy to fix.
 */
export function loadConfig(env: Env = process.env, now: Date = new Date()): AppConfig {
  const required = ["ESPN_S2", "ESPN_SWID", "ESPN_LEAGUE_ID", "CONNECTOR_PASSWORD"] as const;
  const missing = required.filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variables: ${missing.join(", ")}`, [...missing]);
  }

  const password = env.CONNECTOR_PASSWORD!.trim();
  if (password.length < 8) {
    throw new ConfigError("CONNECTOR_PASSWORD must be at least 8 characters");
  }

  const secret = env.CONNECTOR_SECRET?.trim() || "";
  if (secret && secret.length < 24) {
    throw new ConfigError("CONNECTOR_SECRET must be at least 24 characters (try: openssl rand -base64 48)");
  }

  const leagueId = readInt(env, "ESPN_LEAGUE_ID")!;
  const teamId = readInt(env, "ESPN_TEAM_ID");
  const season = readInt(env, "ESPN_SEASON") ?? defaultSeason(now);

  const timezone = env.TIMEZONE?.trim() || "America/Denver";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ConfigError(`TIMEZONE "${timezone}" is not a valid IANA timezone`);
  }

  const publicUrl = env.PUBLIC_URL?.trim() || undefined;
  if (publicUrl) {
    try {
      new URL(publicUrl);
    } catch {
      throw new ConfigError(`PUBLIC_URL "${publicUrl}" is not a valid URL`);
    }
  }

  return {
    espn: {
      s2: env.ESPN_S2!.trim(),
      swid: normalizeSwid(env.ESPN_SWID!),
      leagueId,
      teamId,
      season,
    },
    auth: {
      password,
      // Fall back to a key derived from the password so the connector still
      // works if CONNECTOR_SECRET is unset; the README recommends setting it.
      secret: secret || `derived:${password}`,
      devBearerToken: env.DEV_BEARER_TOKEN?.trim() || undefined,
      extraRedirectHosts: readList(env, "ALLOWED_REDIRECT_HOSTS"),
    },
    timezone,
    publicUrl: publicUrl?.replace(/\/+$/, ""),
  };
}
