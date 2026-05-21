# bitget-mcp-server

[![npm](https://img.shields.io/npm/v/bitget-mcp-server.svg)](https://www.npmjs.com/package/bitget-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

The **MCP surface** of the [Bitget Agent Hub](https://github.com/bitget/agent-hub) — exposes 56+ Bitget API tools over the [Model Context Protocol](https://modelcontextprotocol.io) so any MCP-capable AI host (Claude Desktop, Cursor, Continue, …) can drive your Bitget account.

## Install / configure

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bitget": {
      "command": "npx",
      "args": ["-y", "bitget-mcp-server"],
      "env": {
        "BITGET_API_KEY": "...",
        "BITGET_SECRET_KEY": "...",
        "BITGET_PASSPHRASE": "..."
      }
    }
  }
}
```

### Cursor / Continue / other MCP hosts

Use the same `npx -y bitget-mcp-server` command — pass credentials via env vars.

## CLI options

```
bitget-mcp-server [options]

  --modules <list>     spot,futures,account,margin,copytrading,convert,earn,p2p,broker
                       (or "all"; default: spot,futures,account)
  --read-only          Only read/query tools, no writes
  --paper-trading      Use Bitget Demo Trading (with a Demo API Key)
  --help / --version
```

## Why MCP

If your AI assistant speaks **MCP**, this is the right surface. The server runs locally over stdio, holds your credentials in env vars only, and never proxies traffic through Bitget infrastructure.

If your assistant lives **in your shell** instead (Claude Code, Codex CLI, OpenClaw), prefer [`bitget-client`](https://github.com/bitget/agent-cli) (`bgc`) — same tools, just shell-native.

## License

MIT

---

Part of the **[Bitget Agent Hub](https://github.com/bitget/agent-hub)** — Trading Stack · Surface.
Foundation: [agent-sdk](https://github.com/bitget/agent-sdk) · Other surfaces: [agent-cli](https://github.com/bitget/agent-cli) · [agent-skill](https://github.com/bitget/agent-skill)
