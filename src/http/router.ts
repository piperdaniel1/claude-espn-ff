/**
 * Framework-agnostic HTTP entry point: (Request) => Promise<Response>.
 * Netlify Functions call it directly; tests run it in-process.
 */

import { createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import { handleOAuthRequest, MCP_PATH, unauthorizedResponse, verifyBearer, type OAuthContext } from "../auth/oauth.ts";
import { ConfigError, type AppConfig } from "../config.ts";
import { EspnClient } from "../espn/client.ts";
import { LeagueService } from "../espn/league.ts";
import { FallbackStore, Journal, KvUsedTokenStore, MemoryStore, type KeyValueStore } from "../journal/store.ts";
import { buildMcpServer, SERVER_NAME } from "../mcp/server.ts";

export interface AppOptions {
  /** Called on every request; may throw ConfigError. */
  loadConfig: () => AppConfig;
  store?: KeyValueStore;
  fetch?: typeof fetch;
  now?: () => Date;
  version?: string;
  logger?: (msg: string) => void;
}

export type FetchHandler = (request: Request) => Promise<Response>;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "mcp-session-id, www-authenticate",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function landingPage(origin: string, config: AppConfig | null, error: string | null, version: string): string {
  const status = error
    ? `<p class="bad"><strong>Configuration problem:</strong> ${escapeHtml(error)}</p>`
    : `<p class="good">Configured for ESPN league <strong>${config!.espn.leagueId}</strong>, season <strong>${config!.espn.season}</strong>, timezone <strong>${escapeHtml(config!.timezone)}</strong>.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESPN Fantasy Football connector</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:720px;margin:40px auto;padding:0 20px;line-height:1.5}
code{background:rgba(127,127,127,.15);padding:2px 6px;border-radius:4px}.good{color:#2d7a2d}.bad{color:#b3261e}li{margin:6px 0}</style></head>
<body><h1>ESPN Fantasy Football connector</h1>
<p>A remote MCP server that lets Claude view and manage one ESPN Fantasy Football team. Version ${escapeHtml(version)}.</p>
${status}
<h2>Add to Claude</h2>
<ol>
<li>In Claude, open <strong>Customize &rarr; Connectors &rarr; Add custom connector</strong>.</li>
<li>Name it (for example "ESPN Fantasy") and enter this URL: <code>${escapeHtml(origin)}${MCP_PATH}</code></li>
<li>Leave the OAuth client settings on their defaults and click <strong>Add</strong>, then <strong>Connect</strong>.</li>
<li>When the sign-in page opens, enter the connector password you set in <code>CONNECTOR_PASSWORD</code>.</li>
</ol>
<p>Discovery documents: <a href="/.well-known/oauth-protected-resource${MCP_PATH}">protected resource</a>, <a href="/.well-known/oauth-authorization-server">authorization server</a>. Health: <a href="/health">/health</a>.</p>
</body></html>`;
}

export function createApp(opts: AppOptions): FetchHandler {
  const version = opts.version ?? "0.1.0";
  const store = opts.store ?? new FallbackStore(new MemoryStore());
  const nowFn = opts.now ?? (() => new Date());
  const nowSeconds = () => Math.floor(nowFn().getTime() / 1000);

  function buildDeps(config: AppConfig) {
    const client = new EspnClient({
      season: config.espn.season,
      leagueId: config.espn.leagueId,
      credentials: { s2: config.espn.s2, swid: config.espn.swid },
      fetch: opts.fetch,
      logger: opts.logger,
    });
    const league = new LeagueService({ client, swid: config.espn.swid, teamIdOverride: config.espn.teamId, timezone: config.timezone, now: nowFn });
    const journal = new Journal(store, `journal:${config.espn.leagueId}:${config.espn.season}`);
    return { config, league, journal, version };
  }

  // Modern-protocol handler (2026-07-28 envelope). Legacy 2025-era traffic is
  // served below with a JSON-mode stateless transport, which is friendlier to
  // serverless platforms than the SSE default.
  let currentConfig: AppConfig | null = null;
  const modernHandler = createMcpHandler(
    () => {
      if (!currentConfig) throw new Error("configuration unavailable");
      return buildMcpServer(buildDeps(currentConfig));
    },
    { legacy: "reject", onerror: (err) => opts.logger?.(`mcp: ${err.message}`) },
  );

  async function serveMcp(request: Request, config: AppConfig, authInfo: ReturnType<typeof verifyBearer>): Promise<Response> {
    if (request.method === "GET" || request.method === "DELETE") {
      return json({ jsonrpc: "2.0", error: { code: -32000, message: "This server is stateless: open no SSE stream, send JSON-RPC via POST." }, id: null }, 405, { allow: "POST" });
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
    currentConfig = config;
    const auth = authInfo ?? undefined;
    if (await isLegacyRequest(request)) {
      const server = buildMcpServer(buildDeps(config));
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request, auth ? { authInfo: auth } : undefined);
      } finally {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      }
    }
    return modernHandler.fetch(request, auth ? { authInfo: auth } : undefined);
  }

  return async function app(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    let config: AppConfig | null = null;
    let configError: string | null = null;
    try {
      config = opts.loadConfig();
    } catch (err) {
      configError = err instanceof ConfigError ? err.message : `Configuration failed to load: ${err instanceof Error ? err.message : String(err)}`;
    }
    const origin = config?.publicUrl ?? url.origin;

    if (path === "/health") {
      return json({
        ok: configError === null,
        service: SERVER_NAME,
        version,
        config_error: configError,
        season: config?.espn.season ?? null,
        league_id: config?.espn.leagueId ?? null,
        timezone: config?.timezone ?? null,
        storage: store.description,
        mcp_url: `${origin}${MCP_PATH}`,
      });
    }

    if (path === "/" && request.method === "GET") {
      return new Response(landingPage(origin, config, configError, version), {
        status: configError ? 500 : 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    if (!config) {
      return json({ error: "server_misconfigured", error_description: configError }, 500);
    }

    const oauthCtx: OAuthContext = { auth: config.auth, origin, nowSeconds, usedTokens: new KvUsedTokenStore(store, nowSeconds) };
    const oauthResponse = await handleOAuthRequest(request, oauthCtx);
    if (oauthResponse) return oauthResponse;

    if (path === MCP_PATH) {
      const authInfo = verifyBearer(request, oauthCtx);
      if (!authInfo) return withCors(unauthorizedResponse(origin));
      try {
        return withCors(await serveMcp(request, config, authInfo));
      } catch (err) {
        opts.logger?.(`mcp failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        return withCors(json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error serving MCP request" }, id: null }, 500));
      }
    }

    return json({ error: "not_found", path }, 404);
  };
}
