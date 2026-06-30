import { createRequire } from "node:module";

/**
 * Identity of THIS MCP adapter on the wire (serverInfo.name / --version output).
 *
 * Deliberately distinct from the SDK's `SERVER_NAME`/`SERVER_VERSION`
 * ("bitget-agent-sdk" / its own version): those identify the foundation library
 * this server is built on, not the server a host actually connects to. The wire
 * name matches the published bin (`bitget-agent-mcp`); the version is read from
 * package.json so it stays the single source of truth.
 *
 * `import.meta.url` resolves to src/meta.ts under vitest and to lib/index.js once
 * bundled — both are one level below the package root, so `../package.json`
 * resolves correctly in either context.
 */
const pkg = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export const MCP_SERVER_NAME = "bitget-agent-mcp";
export const MCP_SERVER_VERSION = pkg.version;
