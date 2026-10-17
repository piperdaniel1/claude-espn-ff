/**
 * Mint a short-lived access token for a deployment, for use with curl or MCP
 * Inspector without going through the browser login.
 *
 *   npm run token -- https://your-site.netlify.app [hours]
 *
 * Requires CONNECTOR_PASSWORD / CONNECTOR_SECRET in .env to match the deploy.
 */

import { mintAccessToken } from "../src/auth/oauth.ts";
import { loadConfig } from "../src/config.ts";

const [, , originArg, hoursArg] = process.argv;
if (!originArg) {
  console.error("usage: npm run token -- <origin> [hours]");
  process.exit(2);
}
const config = loadConfig(process.env);
const origin = (config.publicUrl ?? originArg).replace(/\/+$/, "");
const hours = Number(hoursArg ?? "12");
const token = mintAccessToken({ auth: config.auth, origin }, hours * 3600);
console.log(token);
console.error(`\nToken valid ${hours}h for ${origin}/mcp. Example:\n  curl -s ${origin}/mcp -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`);
