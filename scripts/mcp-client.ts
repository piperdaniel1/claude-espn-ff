/**
 * Exercise a running connector (local `netlify dev` or a deployment) as an MCP
 * client.
 *
 *   npm run mcp-client -- http://localhost:8888 tools
 *   npm run mcp-client -- https://your-site.netlify.app get_context
 *   npm run mcp-client -- https://your-site.netlify.app get_free_agents '{"positions":["RB"],"limit":5}'
 *
 * Authenticates with DEV_BEARER_TOKEN if set, otherwise mints a token from
 * CONNECTOR_SECRET (both read from .env).
 */

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { mintAccessToken } from "../src/auth/oauth.ts";
import { loadConfig } from "../src/config.ts";

const [, , originInput, tool = "tools", argsJson = "{}"] = process.argv;
if (!originInput) {
  console.error("usage: npm run mcp-client -- <origin> [tool_name|tools] [json_args]");
  process.exit(2);
}
const originArg: string = originInput;

async function main() {
  const config = loadConfig(process.env);
  const origin = originArg.replace(/\/+$/, "");
  const token = config.auth.devBearerToken ?? mintAccessToken({ auth: config.auth, origin: config.publicUrl ?? origin }, 3600);
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: { token: async () => token } });
  const client = new Client({ name: "espn-ff-cli", version: "0.1.0" });
  await client.connect(transport, { prior: { kind: "legacy" } });
  if (tool === "tools") {
    const tools = await client.listTools();
    for (const t of tools.tools) console.log(`- ${t.name}: ${t.description?.split(". ")[0]}`);
  } else {
    const result = await client.callTool({ name: tool, arguments: JSON.parse(argsJson) });
    for (const c of result.content as { type: string; text?: string }[]) console.log(c.text ?? JSON.stringify(c));
    if (result.isError) process.exitCode = 1;
  }
  await client.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
