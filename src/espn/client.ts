/**
 * Thin HTTP client for ESPN's (undocumented) fantasy v3 API.
 *
 * Reads go to lm-api-reads, writes to lm-api-writes. Authentication for private
 * leagues is cookie based (espn_s2 + SWID). Reads are retried once on transient
 * failures; writes are never retried because ESPN offers no idempotency key.
 */

import { READ_HOST, WRITE_HOST } from "./constants.ts";

export interface EspnCredentials {
  s2: string;
  swid: string;
}

export interface EspnClientOptions {
  season: number;
  leagueId: number;
  credentials: EspnCredentials;
  fetch?: typeof fetch;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
  logger?: (msg: string) => void;
}

export interface EspnErrorDetail {
  type?: string;
  message?: string;
  shortMessage?: string;
}

export class EspnHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly messages: string[],
    public readonly details: EspnErrorDetail[],
    public readonly body: unknown,
  ) {
    super(EspnHttpError.describe(status, messages, details));
    this.name = "EspnHttpError";
  }

  static describe(status: number, messages: string[], details: EspnErrorDetail[]): string {
    const parts: string[] = [];
    if (status === 401 || status === 403) {
      parts.push(
        "ESPN rejected the request as unauthorized. The espn_s2/SWID cookies are probably missing, expired, or belong to an account that is not in this league.",
      );
    } else if (status === 404) {
      parts.push("ESPN returned 404: the league id or season does not exist (or the league is not visible to this account).");
    } else if (status === 409) {
      parts.push("ESPN returned 409 Conflict.");
    } else if (status === 415) {
      parts.push("ESPN returned 415: a JSON content type is required.");
    } else {
      parts.push(`ESPN returned HTTP ${status}.`);
    }
    const detailText = details
      .map((d) => [d.type, d.shortMessage ?? d.message].filter(Boolean).join(": "))
      .filter(Boolean);
    if (detailText.length) parts.push(detailText.join(" | "));
    else if (messages.length) parts.push(messages.join(" | "));
    return parts.join(" ");
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Thrown when a write may or may not have been applied (timeout / network). */
export class EspnUnknownOutcomeError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "EspnUnknownOutcomeError";
  }
}

export interface LeagueGetParams {
  views: string[];
  scoringPeriodId?: number;
  /** Path appended to the league URL, e.g. "/communication/". */
  extend?: string;
  /** JSON object sent as the x-fantasy-filter header. */
  filter?: Record<string, unknown>;
  extraQuery?: Record<string, string>;
}

export interface WriteResult {
  status: number;
  body: unknown;
}

export class EspnClient {
  readonly season: number;
  readonly leagueId: number;
  private readonly creds: EspnCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly readTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly logger?: (msg: string) => void;

  constructor(opts: EspnClientOptions) {
    this.season = opts.season;
    this.leagueId = opts.leagueId;
    this.creds = opts.credentials;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.readTimeoutMs = opts.readTimeoutMs ?? 7000;
    this.writeTimeoutMs = opts.writeTimeoutMs ?? 9000;
    this.logger = opts.logger;
  }

  get leagueReadUrl(): string {
    return `${READ_HOST}/apis/v3/games/ffl/seasons/${this.season}/segments/0/leagues/${this.leagueId}`;
  }

  get leagueWriteUrl(): string {
    return `${WRITE_HOST}/apis/v3/games/ffl/seasons/${this.season}/segments/0/leagues/${this.leagueId}`;
  }

  get seasonReadUrl(): string {
    return `${READ_HOST}/apis/v3/games/ffl/seasons/${this.season}`;
  }

  cookieHeader(): string {
    return `espn_s2=${this.creds.s2}; SWID=${this.creds.swid}`;
  }

  private baseHeaders(): Record<string, string> {
    return {
      accept: "application/json",
      cookie: this.cookieHeader(),
      "x-fantasy-source": "kona",
      "x-fantasy-platform": "espn-fantasy-web",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    };
  }

  private buildUrl(base: string, views: string[], extra: Record<string, string> = {}): string {
    const url = new URL(base);
    for (const v of views) url.searchParams.append("view", v);
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    return url.toString();
  }

  /** GET on the league resource. */
  async leagueGet<T = unknown>(params: LeagueGetParams): Promise<T> {
    const extra: Record<string, string> = { ...(params.extraQuery ?? {}) };
    if (params.scoringPeriodId !== undefined) extra.scoringPeriodId = String(params.scoringPeriodId);
    const url = this.buildUrl(`${this.leagueReadUrl}${params.extend ?? ""}`, params.views, extra);
    const body = await this.getJson<unknown>(url, params.filter);
    // League endpoints sometimes wrap the object in a one-element array.
    return (Array.isArray(body) ? body[0] : body) as T;
  }

  /** GET on the season resource (pro schedules, player universe). */
  async seasonGet<T = unknown>(params: { views: string[]; extend?: string; filter?: Record<string, unknown>; extraQuery?: Record<string, string> }): Promise<T> {
    const url = this.buildUrl(`${this.seasonReadUrl}${params.extend ?? ""}`, params.views, params.extraQuery ?? {});
    return this.getJson<T>(url, params.filter);
  }

  private async getJson<T>(url: string, filter?: Record<string, unknown>): Promise<T> {
    const headers = this.baseHeaders();
    if (filter) headers["x-fantasy-filter"] = JSON.stringify(filter);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.logger?.(`GET ${url}${attempt ? " (retry)" : ""}`);
        const res = await this.fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(this.readTimeoutMs) });
        const body = await parseBody(res);
        if (res.ok) return body as T;
        const err = toHttpError(res.status, url, body);
        if (res.status >= 500 && attempt === 0) {
          lastErr = err;
          continue;
        }
        throw err;
      } catch (err) {
        if (err instanceof EspnHttpError) throw err;
        lastErr = err;
        if (attempt === 0) continue;
      }
    }
    throw new Error(`ESPN request failed: ${describeError(lastErr)}`);
  }

  /** POST a transaction to the write host. Never retried. */
  async postTransaction(payload: Record<string, unknown>): Promise<WriteResult> {
    const url = `${this.leagueWriteUrl}/transactions/`;
    const headers = { ...this.baseHeaders(), "content-type": "application/json" };
    this.logger?.(`POST ${url} ${JSON.stringify(payload)}`);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.writeTimeoutMs),
      });
    } catch (err) {
      throw new EspnUnknownOutcomeError(
        `The write request to ESPN did not complete (${describeError(err)}). ESPN may or may not have applied it. Re-read the roster and pending transactions before trying again.`,
        err,
      );
    }
    const body = await parseBody(res);
    if (!res.ok) throw toHttpError(res.status, url, body);
    return { status: res.status, body };
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toHttpError(status: number, url: string, body: unknown): EspnHttpError {
  const messages: string[] = [];
  const details: EspnErrorDetail[] = [];
  if (body && typeof body === "object") {
    const b = body as { messages?: unknown; details?: unknown; message?: unknown; error?: unknown };
    if (Array.isArray(b.messages)) messages.push(...b.messages.filter((m): m is string => typeof m === "string"));
    if (typeof b.message === "string") messages.push(b.message);
    if (typeof b.error === "string") messages.push(b.error);
    if (Array.isArray(b.details)) {
      for (const d of b.details) {
        if (d && typeof d === "object") {
          const dd = d as EspnErrorDetail;
          details.push({ type: dd.type, message: dd.message, shortMessage: dd.shortMessage });
        }
      }
    }
  } else if (typeof body === "string" && body.trim()) {
    messages.push(body.slice(0, 300));
  }
  return new EspnHttpError(status, url, messages, details, body);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
