import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, toToolErrorPayload } from "@bitget-ai/bitget-agent-sdk";
import { createServer } from "./server.js";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./meta.js";

function printHelp(): void {
  const help = `
Usage: ${MCP_SERVER_NAME} [options]

Bitget Unified Trading Account (UTA / v3) MCP server. Exposes a curated,
progressively-discoverable intent surface over stdio. Agents start from the
\`discover\` tool rather than a tool-per-endpoint list.

Options:
  --modules <list>     Comma-separated list of modules to load
                       Available: account, trade, market, strategy,
                       broker, cryptoloans, instloan, tax
                       Special: "all" loads all generally-available modules
                       Note: broker and instloan are hidden — name them
                             explicitly to expose them ("all" excludes them)
                       Default: account,trade,market

  --surface <mode>     Tool surface to expose
                       intent  curated verbs + raw + discover (default)
                       full    ALSO emit one tool per underlying v3 endpoint

  --read-only          Expose only read/query operations; block all writes
  --paper-trading      Enable Demo Trading mode (requires Demo API Key)
                       Signed (private) requests carry the paptrading: 1 header
                       (mutually exclusive with --read-only)
  --help               Show this help message
  --version            Show version

Environment Variables:
  BITGET_API_KEY       Bitget API key (required for private endpoints)
  BITGET_SECRET_KEY    Bitget secret key (required for private endpoints)
  BITGET_PASSPHRASE    Bitget passphrase (required for private endpoints)
  BITGET_API_BASE_URL  Optional API base URL (default: https://api.bitget.com)
  BITGET_TIMEOUT_MS    Optional request timeout in milliseconds (default: 15000)
  BITGET_MAX_RETRIES   Optional max transport retries (default: SDK policy)
`;
  process.stdout.write(help);
}

function parseCli(): {
  modules?: string;
  surface?: string;
  readOnly: boolean;
  paperTrading?: boolean;
  help: boolean;
  version: boolean;
} {
  const parsed = parseArgs({
    options: {
      modules: { type: "string" },
      surface: { type: "string" },
      "read-only": { type: "boolean", default: false },
      "paper-trading": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  return {
    modules: parsed.values.modules,
    surface: parsed.values.surface,
    readOnly: parsed.values["read-only"],
    paperTrading: parsed.values["paper-trading"],
    help: parsed.values.help,
    version: parsed.values.version,
  };
}

export async function main(): Promise<void> {
  const cli = parseCli();
  if (cli.help) { printHelp(); return; }
  if (cli.version) { process.stdout.write(`${MCP_SERVER_VERSION}\n`); return; }
  const config = loadConfig({
    modules: cli.modules,
    surface: cli.surface,
    readOnly: cli.readOnly,
    paperTrading: cli.paperTrading ?? false,
  });
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Close the transport cleanly on host shutdown so we don't leave an orphaned
  // stdio process. Either signal resolves the same path; second signal is a
  // no-op once the server is already closing.
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const payload = toToolErrorPayload(error);
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
