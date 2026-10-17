import type { Config, Context } from "@netlify/functions";

import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/http/router.ts";
import { FallbackStore, NetlifyBlobStore } from "../../src/journal/store.ts";

const VERSION = process.env.npm_package_version ?? "0.1.0";

const app = createApp({
  loadConfig: () => loadConfig(process.env),
  store: new FallbackStore(new NetlifyBlobStore()),
  version: VERSION,
  logger: (msg) => console.log(msg),
});

export default async (request: Request, _context: Context): Promise<Response> => app(request);

export const config: Config = {
  path: ["/", "/health", "/mcp", "/oauth/*", "/.well-known/*"],
};
