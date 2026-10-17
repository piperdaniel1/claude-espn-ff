/**
 * A deliberately small, stateless OAuth 2.1 authorization server.
 *
 * Claude's custom connectors sign in with OAuth: Claude discovers this server
 * through the well-known documents, registers itself (RFC 7591 dynamic client
 * registration), sends the user to /oauth/authorize, and exchanges the code at
 * /oauth/token with PKCE. There is exactly one "user" here: whoever knows the
 * connector password. Every artefact (client id, code, access token, refresh
 * token) is an HMAC-signed payload, so nothing has to be stored.
 *
 * Optional replay protection for codes and refresh tokens is provided through
 * a tiny key/value interface, backed by Netlify Blobs in production.
 */

import type { AuthConfig } from "../config.ts";
import { randomId, sha256Base64url, signPayload, timingSafeEqualString, verifyPayload } from "./crypto.ts";

export const MCP_PATH = "/mcp";
export const SCOPE = "espn";

export const CODE_TTL_SECONDS = 5 * 60;
export const ACCESS_TOKEN_TTL_SECONDS = 12 * 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 120 * 24 * 60 * 60;

/** Redirect URIs used by claude.ai (web, desktop, mobile, Cowork). */
export const CLAUDE_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

/** Loopback redirects used by Claude Code and MCP Inspector (any port). */
export const LOOPBACK_REDIRECT_URIS = [
  "http://localhost/callback",
  "http://127.0.0.1/callback",
  "http://localhost/oauth/callback",
  "http://127.0.0.1/oauth/callback",
  "http://localhost/oauth/callback/debug",
  "http://127.0.0.1/oauth/callback/debug",
];

/** A well-known public client id that can be entered manually in Claude. */
export const STATIC_CLIENT_ID = "claude";

export interface UsedTokenStore {
  /** Returns true if the id was already present (replay). Records it otherwise. */
  markUsed(id: string, expiresAtSeconds: number): Promise<boolean>;
}

export interface OAuthContext {
  auth: AuthConfig;
  /** Public origin of this deployment, e.g. https://my-site.netlify.app */
  origin: string;
  nowSeconds?: () => number;
  usedTokens?: UsedTokenStore;
}

export interface AuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  resource?: URL;
}

interface ClientPayload {
  t: "client";
  ru: string[];
  iat: number;
}

interface CodePayload {
  t: "code";
  cid: string;
  ru: string;
  cc: string;
  res?: string;
  scope: string;
  exp: number;
  jti: string;
}

interface TokenPayload {
  t: "access" | "refresh";
  cid: string;
  scope: string;
  aud: string;
  exp: number;
  jti: string;
}

export class OAuthHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthHttpError";
  }

  toResponse(): Response {
    return json({ error: this.code, error_description: this.message }, this.status);
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action *;",
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function resourceUrl(origin: string): string {
  return `${origin}${MCP_PATH}`;
}

// ---------------------------------------------------------------------------
// Discovery documents
// ---------------------------------------------------------------------------

export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "ESPN Fantasy Football connector",
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [SCOPE],
    service_documentation: `${origin}/`,
  };
}

export function protectedResourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

/** The 401 Claude needs in order to start the sign-in flow. */
export function unauthorizedResponse(origin: string, description = "Missing or invalid access token"): Response {
  return json(
    { error: "invalid_token", error_description: description },
    401,
    {
      "www-authenticate": `Bearer realm="espn-ff", error="invalid_token", error_description="${description}", resource_metadata="${protectedResourceMetadataUrl(origin)}", scope="${SCOPE}"`,
    },
  );
}

// ---------------------------------------------------------------------------
// Redirect URI rules
// ---------------------------------------------------------------------------

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** Exact match, or loopback match ignoring the port (RFC 8252 §7.3). */
export function redirectUriMatches(candidate: string, registered: string): boolean {
  if (candidate === registered) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(candidate);
    b = new URL(registered);
  } catch {
    return false;
  }
  if (a.protocol !== "http:" || b.protocol !== "http:") return false;
  if (!isLoopbackHost(a.hostname) || !isLoopbackHost(b.hostname)) return false;
  return a.pathname === b.pathname;
}

export function isRegistrableRedirectUri(uri: string, extraHosts: string[]): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "http:") return isLoopbackHost(u.hostname);
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "claude.ai" || host === "claude.com" || host.endsWith(".claude.ai") || host.endsWith(".claude.com")) return true;
  if (host.endsWith(".anthropic.com")) return true;
  return extraHosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`));
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export function registeredRedirectUris(ctx: OAuthContext, clientId: string): string[] | null {
  if (clientId === STATIC_CLIENT_ID) return [...CLAUDE_REDIRECT_URIS, ...LOOPBACK_REDIRECT_URIS];
  const payload = verifyPayload<ClientPayload>(ctx.auth.secret, clientId);
  if (!payload || payload.t !== "client" || !Array.isArray(payload.ru)) return null;
  return payload.ru;
}

async function handleRegister(request: Request, ctx: OAuthContext): Promise<Response> {
  if (request.method !== "POST") return json({ error: "invalid_request", error_description: "POST only" }, 405);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_client_metadata", error_description: "Body must be JSON" }, 400);
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((x): x is string => typeof x === "string") : [];
  if (redirectUris.length === 0) {
    return json({ error: "invalid_redirect_uri", error_description: "redirect_uris is required" }, 400);
  }
  const bad = redirectUris.filter((u) => !isRegistrableRedirectUri(u, ctx.auth.extraRedirectHosts));
  if (bad.length > 0) {
    return json(
      { error: "invalid_redirect_uri", error_description: `Redirect URI not allowed for this connector: ${bad.join(", ")}` },
      400,
    );
  }
  const now = (ctx.nowSeconds ?? defaultNow)();
  const clientId = signPayload(ctx.auth.secret, { t: "client", ru: redirectUris, iat: now } satisfies ClientPayload);
  return json(
    {
      client_id: clientId,
      client_id_issued_at: now,
      client_name: typeof body.client_name === "string" ? body.client_name : "Claude",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    },
    201,
  );
}

// ---------------------------------------------------------------------------
// Authorize
// ---------------------------------------------------------------------------

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope: string;
  resource?: string;
}

function readAuthorizeParams(params: URLSearchParams, ctx: OAuthContext): AuthorizeParams {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const responseType = params.get("response_type") ?? "code";
  const codeChallenge = params.get("code_challenge") ?? "";
  const method = params.get("code_challenge_method") ?? "S256";
  const state = params.get("state") ?? undefined;
  const scope = params.get("scope")?.trim() || SCOPE;
  const resource = params.get("resource") ?? undefined;

  if (!clientId) throw new OAuthHttpError(400, "invalid_request", "client_id is required");
  const registered = registeredRedirectUris(ctx, clientId);
  if (!registered) throw new OAuthHttpError(400, "invalid_client", "Unknown client_id. Remove the connector in Claude and add it again.");
  if (!redirectUri || !registered.some((r) => redirectUriMatches(redirectUri, r))) {
    throw new OAuthHttpError(400, "invalid_request", "redirect_uri does not match the registered client");
  }
  if (responseType !== "code") throw new OAuthHttpError(400, "unsupported_response_type", "Only response_type=code is supported");
  if (!codeChallenge || method !== "S256") {
    throw new OAuthHttpError(400, "invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  if (resource && resource.replace(/\/$/, "") !== resourceUrl(ctx.origin)) {
    throw new OAuthHttpError(400, "invalid_target", `resource must be ${resourceUrl(ctx.origin)}`);
  }
  return { clientId, redirectUri, codeChallenge, state, scope, resource };
}

function renderLoginPage(p: AuthorizeParams, error?: string): string {
  const host = (() => {
    try {
      return new URL(p.redirectUri).host;
    } catch {
      return p.redirectUri;
    }
  })();
  const hidden = (name: string, value: string | undefined) =>
    value === undefined ? "" : `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ESPN Fantasy Football</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:#111}
@media (prefers-color-scheme:dark){body{background:#101418;color:#e8eaed}.card{background:#1a2027!important;border-color:#2b3440!important}input{background:#0f141a;color:#e8eaed;border-color:#3a4552!important}}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:28px;max-width:380px;width:calc(100% - 32px);box-shadow:0 10px 30px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 18px;line-height:1.45;font-size:14px;opacity:.85}
label{display:block;font-size:13px;margin-bottom:6px;font-weight:600}
input[type=password]{width:100%;box-sizing:border-box;padding:12px;border:1px solid #cfd4da;border-radius:8px;font-size:16px}
button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:8px;background:#d4582b;color:#fff;font-size:16px;font-weight:600;cursor:pointer}
.err{background:#fde8e8;color:#8a1c1c;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:14px}
.meta{font-size:12px;opacity:.65;margin-top:16px}
code{font-size:12px}
</style></head><body><main class="card">
<h1>Connect ESPN Fantasy Football</h1>
<p>Enter the connector password to let <strong>${escapeHtml(host)}</strong> manage your team on your behalf.</p>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
<form method="post" autocomplete="off">
${hidden("client_id", p.clientId)}${hidden("redirect_uri", p.redirectUri)}${hidden("code_challenge", p.codeChallenge)}
${hidden("code_challenge_method", "S256")}${hidden("state", p.state)}${hidden("scope", p.scope)}${hidden("resource", p.resource)}${hidden("response_type", "code")}
<label for="password">Connector password</label>
<input id="password" name="password" type="password" required autofocus>
<button type="submit">Allow access</button>
</form>
<div class="meta">This grants access to read and change the ESPN team configured on the server. Set <code>CONNECTOR_PASSWORD</code> in the deployment to change the password.</div>
</main></body></html>`;
}

async function handleAuthorize(request: Request, ctx: OAuthContext): Promise<Response> {
  const url = new URL(request.url);
  let form: URLSearchParams | null = null;
  if (request.method === "POST") {
    const text = await request.text();
    form = new URLSearchParams(text);
  } else if (request.method !== "GET") {
    return json({ error: "invalid_request", error_description: "GET or POST only" }, 405);
  }
  const source = form ?? url.searchParams;

  let params: AuthorizeParams;
  try {
    params = readAuthorizeParams(source, ctx);
  } catch (err) {
    if (err instanceof OAuthHttpError) return err.toResponse();
    throw err;
  }

  if (!form) return html(renderLoginPage(params));

  const password = form.get("password") ?? "";
  if (!timingSafeEqualString(password, ctx.auth.password)) {
    // Slow down brute force a little; a serverless function cannot keep counters.
    await new Promise((r) => setTimeout(r, 600));
    return html(renderLoginPage(params, "That password is not correct."), 401);
  }

  const now = (ctx.nowSeconds ?? defaultNow)();
  const code = signPayload(ctx.auth.secret, {
    t: "code",
    cid: params.clientId,
    ru: params.redirectUri,
    cc: params.codeChallenge,
    res: params.resource,
    scope: params.scope,
    exp: now + CODE_TTL_SECONDS,
    jti: randomId(12),
  } satisfies CodePayload);

  const target = new URL(params.redirectUri);
  target.searchParams.set("code", code);
  if (params.state !== undefined) target.searchParams.set("state", params.state);
  return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store" } });
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

async function readFormOrJson(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (type.includes("application/json")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) p.set(k, String(v));
      return p;
    } catch {
      throw new OAuthHttpError(400, "invalid_request", "Malformed JSON body");
    }
  }
  return new URLSearchParams(text);
}

function issueTokens(ctx: OAuthContext, clientId: string, scope: string, now: number) {
  const aud = resourceUrl(ctx.origin);
  const access = signPayload(ctx.auth.secret, {
    t: "access",
    cid: clientId,
    scope,
    aud,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    jti: randomId(12),
  } satisfies TokenPayload);
  const refresh = signPayload(ctx.auth.secret, {
    t: "refresh",
    cid: clientId,
    scope,
    aud,
    exp: now + REFRESH_TOKEN_TTL_SECONDS,
    jti: randomId(12),
  } satisfies TokenPayload);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    scope,
  };
}

async function handleToken(request: Request, ctx: OAuthContext): Promise<Response> {
  if (request.method !== "POST") return json({ error: "invalid_request", error_description: "POST only" }, 405);
  let form: URLSearchParams;
  try {
    form = await readFormOrJson(request);
  } catch (err) {
    if (err instanceof OAuthHttpError) return err.toResponse();
    throw err;
  }
  const now = (ctx.nowSeconds ?? defaultNow)();
  const grantType = form.get("grant_type");
  const clientId = form.get("client_id") ?? "";

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const payload = verifyPayload<CodePayload>(ctx.auth.secret, code);
    if (!payload || payload.t !== "code") return json({ error: "invalid_grant", error_description: "Invalid authorization code" }, 400);
    if (payload.exp <= now) return json({ error: "invalid_grant", error_description: "Authorization code expired" }, 400);
    if (clientId && clientId !== payload.cid) return json({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
    if (redirectUri && redirectUri !== payload.ru) return json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    if (!verifier || sha256Base64url(verifier) !== payload.cc) {
      return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    }
    if (ctx.usedTokens && (await ctx.usedTokens.markUsed(`code:${payload.jti}`, payload.exp))) {
      return json({ error: "invalid_grant", error_description: "Authorization code already used" }, 400);
    }
    return json(issueTokens(ctx, payload.cid, payload.scope || SCOPE, now));
  }

  if (grantType === "refresh_token") {
    const token = form.get("refresh_token") ?? "";
    const payload = verifyPayload<TokenPayload>(ctx.auth.secret, token);
    if (!payload || payload.t !== "refresh") return json({ error: "invalid_grant", error_description: "Invalid refresh token" }, 400);
    if (payload.exp <= now) return json({ error: "invalid_grant", error_description: "Refresh token expired" }, 400);
    if (payload.aud !== resourceUrl(ctx.origin)) return json({ error: "invalid_grant", error_description: "Refresh token issued for another server" }, 400);
    if (clientId && clientId !== payload.cid) return json({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
    if (ctx.usedTokens && (await ctx.usedTokens.markUsed(`refresh:${payload.jti}`, payload.exp))) {
      return json({ error: "invalid_grant", error_description: "Refresh token already rotated" }, 400);
    }
    return json(issueTokens(ctx, payload.cid, payload.scope || SCOPE, now));
  }

  return json({ error: "unsupported_grant_type", error_description: "Use authorization_code or refresh_token" }, 400);
}

// ---------------------------------------------------------------------------
// Bearer verification for /mcp
// ---------------------------------------------------------------------------

export function verifyBearer(request: Request, ctx: OAuthContext): AuthInfo | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1]!.trim();
  const now = (ctx.nowSeconds ?? defaultNow)();

  if (ctx.auth.devBearerToken && timingSafeEqualString(token, ctx.auth.devBearerToken)) {
    return { token, clientId: "dev-bearer", scopes: [SCOPE], expiresAt: now + 3600, resource: new URL(resourceUrl(ctx.origin)) };
  }

  const payload = verifyPayload<TokenPayload>(ctx.auth.secret, token);
  if (!payload || payload.t !== "access") return null;
  if (payload.exp <= now) return null;
  if (payload.aud !== resourceUrl(ctx.origin)) return null;
  return {
    token,
    clientId: payload.cid,
    scopes: (payload.scope || SCOPE).split(" "),
    expiresAt: payload.exp,
    resource: new URL(payload.aud),
  };
}

/** Mint an access token directly (used by the local `npm run token` helper). */
export function mintAccessToken(ctx: OAuthContext, ttlSeconds = ACCESS_TOKEN_TTL_SECONDS): string {
  const now = (ctx.nowSeconds ?? defaultNow)();
  return signPayload(ctx.auth.secret, {
    t: "access",
    cid: "local-cli",
    scope: SCOPE,
    aud: resourceUrl(ctx.origin),
    exp: now + ttlSeconds,
    jti: randomId(12),
  } satisfies TokenPayload);
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Router entry
// ---------------------------------------------------------------------------

/**
 * Handle OAuth and discovery routes. Returns undefined for paths it does not own.
 */
export async function handleOAuthRequest(request: Request, ctx: OAuthContext): Promise<Response | undefined> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

  if (path === "/.well-known/oauth-protected-resource" || path === `/.well-known/oauth-protected-resource${MCP_PATH}`) {
    return json(protectedResourceMetadata(ctx.origin), 200, { "cache-control": "public, max-age=300" });
  }
  if (path === "/.well-known/oauth-authorization-server" || path.startsWith("/.well-known/oauth-authorization-server/")) {
    return json(authorizationServerMetadata(ctx.origin), 200, { "cache-control": "public, max-age=300" });
  }
  if (path === "/.well-known/openid-configuration" || path.startsWith("/.well-known/openid-configuration/")) {
    return json(authorizationServerMetadata(ctx.origin), 200, { "cache-control": "public, max-age=300" });
  }
  if (path === "/oauth/register") return handleRegister(request, ctx);
  if (path === "/oauth/authorize") return handleAuthorize(request, ctx);
  if (path === "/oauth/token") return handleToken(request, ctx);
  return undefined;
}
