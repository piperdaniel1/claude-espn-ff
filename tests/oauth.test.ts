import { describe, expect, it } from "vitest";

import { sha256Base64url, signPayload, verifyPayload } from "../src/auth/crypto.ts";
import { CLAUDE_REDIRECT_URIS, isRegistrableRedirectUri, redirectUriMatches, STATIC_CLIENT_ID } from "../src/auth/oauth.ts";
import { ORIGIN, PersistentMemoryStore, TEST_ENV, createTestApp, jsonOf, req } from "./helpers.ts";

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
});

function mcpPost(token?: string, body = INIT_BODY): Request {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  return req("/mcp", { method: "POST", headers, body });
}

describe("crypto", () => {
  it("round-trips and rejects tampering", () => {
    const token = signPayload("secret", { a: 1, b: "x" });
    expect(verifyPayload("secret", token)).toEqual({ a: 1, b: "x" });
    expect(verifyPayload("other", token)).toBeNull();
    expect(verifyPayload("secret", token.slice(0, -2) + "zz")).toBeNull();
    expect(verifyPayload("secret", "garbage")).toBeNull();
    expect(verifyPayload("secret", "")).toBeNull();
  });
});

describe("redirect uri rules", () => {
  it("matches exact uris and loopback on any port", () => {
    expect(redirectUriMatches(CLAUDE_REDIRECT_URIS[0]!, CLAUDE_REDIRECT_URIS[0]!)).toBe(true);
    expect(redirectUriMatches("https://evil.example/api/mcp/auth_callback", CLAUDE_REDIRECT_URIS[0]!)).toBe(false);
    expect(redirectUriMatches("http://localhost:51234/callback", "http://localhost/callback")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1:8080/callback", "http://127.0.0.1/callback")).toBe(true);
    expect(redirectUriMatches("http://localhost:8080/other", "http://localhost/callback")).toBe(false);
    expect(redirectUriMatches("http://example.com:8080/callback", "http://example.com/callback")).toBe(false);
  });

  it("only registers Claude, Anthropic, loopback or allow-listed hosts", () => {
    expect(isRegistrableRedirectUri("https://claude.ai/api/mcp/auth_callback", [])).toBe(true);
    expect(isRegistrableRedirectUri("https://claude.com/api/mcp/auth_callback", [])).toBe(true);
    expect(isRegistrableRedirectUri("http://localhost:3000/callback", [])).toBe(true);
    expect(isRegistrableRedirectUri("http://127.0.0.1:3000/callback", [])).toBe(true);
    expect(isRegistrableRedirectUri("https://attacker.example/callback", [])).toBe(false);
    expect(isRegistrableRedirectUri("http://attacker.example/callback", [])).toBe(false);
    expect(isRegistrableRedirectUri("https://tools.attacker.example/callback", ["attacker.example"])).toBe(true);
  });
});

describe("OAuth discovery", () => {
  it("answers unauthenticated MCP calls with a 401 pointing at the resource metadata", async () => {
    const { app } = createTestApp();
    const res = await app(mcpPost());
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate")!;
    expect(www).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(www).toContain('scope="espn"');
  });

  it("serves protected resource metadata at both well-known paths", async () => {
    const { app } = createTestApp();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await app(req(path));
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      expect(body.resource).toBe(`${ORIGIN}/mcp`);
      expect(body.authorization_servers).toEqual([ORIGIN]);
    }
  });

  it("serves authorization server metadata with PKCE and DCR", async () => {
    const { app } = createTestApp();
    const body = await jsonOf(await app(req("/.well-known/oauth-authorization-server")));
    expect(body.issuer).toBe(ORIGIN);
    expect(body.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toContain("refresh_token");
    expect(body.token_endpoint_auth_methods_supported).toContain("none");
  });

  it("honours PUBLIC_URL for the advertised origin", async () => {
    const { app } = createTestApp({ env: { PUBLIC_URL: "https://custom.example.com" } });
    const body = await jsonOf(await app(req("/.well-known/oauth-protected-resource")));
    expect(body.resource).toBe("https://custom.example.com/mcp");
  });
});

async function register(app: (r: Request) => Promise<Response>, redirectUris = [CLAUDE_REDIRECT_URIS[0]!]) {
  const res = await app(
    req("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: redirectUris, grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" }),
    }),
  );
  return { status: res.status, body: await jsonOf(res) };
}

function authorizeParams(clientId: string, challenge: string, redirectUri = CLAUDE_REDIRECT_URIS[0]!, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz-state",
    scope: "espn",
    ...extra,
  });
}

describe("OAuth flow", () => {
  const verifier = "a-very-long-pkce-verifier-string-with-enough-entropy-0123456789";
  const challenge = sha256Base64url(verifier);

  it("completes register -> authorize -> token -> MCP -> refresh", async () => {
    const store = new PersistentMemoryStore();
    const { app } = createTestApp({ store });

    const reg = await register(app);
    expect(reg.status).toBe(201);
    const clientId: string = reg.body.client_id;
    expect(reg.body.token_endpoint_auth_method).toBe("none");

    // Login page renders with the redirect host.
    const page = await app(req(`/oauth/authorize?${authorizeParams(clientId, challenge)}`));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("claude.ai");
    expect(html).toContain('name="password"');

    // Wrong password re-renders with an error.
    const wrong = await app(
      req("/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams([...authorizeParams(clientId, challenge), ["password", "nope nope nope"]]).toString(),
      }),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("not correct");

    // Right password redirects with a code.
    const good = await app(
      req("/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams([...authorizeParams(clientId, challenge), ["password", TEST_ENV.CONNECTOR_PASSWORD]]).toString(),
      }),
    );
    expect(good.status).toBe(302);
    const location = new URL(good.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_REDIRECT_URIS[0]);
    expect(location.searchParams.get("state")).toBe("xyz-state");
    const code = location.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // Bad verifier fails.
    const bad = await app(
      req("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "wrong", redirect_uri: CLAUDE_REDIRECT_URIS[0]!, client_id: clientId }).toString(),
      }),
    );
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).error).toBe("invalid_grant");

    // Good exchange.
    const tok = await app(
      req("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE_REDIRECT_URIS[0]!, client_id: clientId }).toString(),
      }),
    );
    expect(tok.status).toBe(200);
    const tokens = await jsonOf(tok);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.expires_in).toBeGreaterThan(3600);

    // Replaying the code is rejected (persistent store).
    const replay = await app(
      req("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE_REDIRECT_URIS[0]!, client_id: clientId }).toString(),
      }),
    );
    expect(replay.status).toBe(400);

    // The access token works for MCP initialize.
    const mcp = await app(mcpPost(tokens.access_token));
    expect(mcp.status).toBe(200);
    const init = await jsonOf(mcp);
    expect(init.result.serverInfo.name).toBe("espn-fantasy-football");
    expect(init.result.protocolVersion).toBe("2025-06-18");

    // Refresh rotates; the old refresh token dies.
    const refreshed = await app(
      req("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }).toString(),
      }),
    );
    expect(refreshed.status).toBe(200);
    const next = await jsonOf(refreshed);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    const reuse = await app(
      req("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }).toString(),
      }),
    );
    expect(reuse.status).toBe(400);
    expect((await jsonOf(reuse)).error).toBe("invalid_grant");
  });

  it("rejects registration of foreign redirect uris and unknown clients", async () => {
    const { app } = createTestApp();
    const bad = await register(app, ["https://evil.example/callback"]);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_redirect_uri");

    const unknown = await app(req(`/oauth/authorize?${authorizeParams("not-a-client", challenge)}`));
    expect(unknown.status).toBe(400);
    expect((await jsonOf(unknown)).error).toBe("invalid_client");

    const reg = await register(app);
    const mismatch = await app(req(`/oauth/authorize?${authorizeParams(reg.body.client_id, challenge, "https://evil.example/callback")}`));
    expect(mismatch.status).toBe(400);
  });

  it("requires PKCE S256", async () => {
    const { app } = createTestApp();
    const reg = await register(app);
    const params = authorizeParams(reg.body.client_id, "");
    params.delete("code_challenge");
    const res = await app(req(`/oauth/authorize?${params}`));
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe("invalid_request");
  });

  it("accepts the static 'claude' client id and loopback redirects on any port", async () => {
    const { app } = createTestApp();
    const res = await app(
      req("/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams([...authorizeParams(STATIC_CLIENT_ID, challenge, "http://localhost:43123/callback"), ["password", TEST_ENV.CONNECTOR_PASSWORD]]).toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")!.startsWith("http://localhost:43123/callback?code=")).toBe(true);
  });

  it("rejects access tokens minted for a different origin or expired", async () => {
    const other = createTestApp({ env: { PUBLIC_URL: "https://other.example.com" } });
    const reg = await register(other.app, [CLAUDE_REDIRECT_URIS[0]!]);
    const auth = await other.app(
      req("/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams([...authorizeParams(reg.body.client_id, challenge), ["password", TEST_ENV.CONNECTOR_PASSWORD]]).toString(),
      }),
    );
    const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;
    const tok = await jsonOf(
      await other.app(
        req("/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.body.client_id }).toString(),
        }),
      ),
    );
    const here = createTestApp();
    expect((await here.app(mcpPost(tok.access_token))).status).toBe(401);

    // Expired: advance the clock on a fresh app sharing the same secret.
    const later = createTestApp({ env: { PUBLIC_URL: "https://other.example.com" }, now: () => new Date(Date.now() + 365 * 24 * 3600 * 1000) });
    expect((await later.app(mcpPost(tok.access_token))).status).toBe(401);
  });

  it("accepts the DEV_BEARER_TOKEN and rejects garbage", async () => {
    const { app } = createTestApp();
    expect((await app(mcpPost(TEST_ENV.DEV_BEARER_TOKEN))).status).toBe(200);
    expect((await app(mcpPost("nonsense"))).status).toBe(401);
  });

  it("reports configuration problems on /health and / without leaking secrets", async () => {
    const { app } = createTestApp();
    const health = await jsonOf(await app(req("/health")));
    expect(health.ok).toBe(true);
    expect(health.mcp_url).toBe(`${ORIGIN}/mcp`);
    const home = await app(req("/"));
    expect(home.status).toBe(200);
    const text = await home.text();
    expect(text).toContain(`${ORIGIN}/mcp`);
    expect(text).not.toContain(TEST_ENV.ESPN_S2);
    expect(text).not.toContain(TEST_ENV.CONNECTOR_PASSWORD);
  });

  it("returns 405 for GET/DELETE on /mcp (stateless) and 404 elsewhere", async () => {
    const { app } = createTestApp();
    expect((await app(req("/mcp", { headers: { authorization: `Bearer ${TEST_ENV.DEV_BEARER_TOKEN}` } }))).status).toBe(405);
    expect((await app(req("/mcp", { method: "DELETE", headers: { authorization: `Bearer ${TEST_ENV.DEV_BEARER_TOKEN}` } }))).status).toBe(405);
    expect((await app(req("/nope"))).status).toBe(404);
  });
});
