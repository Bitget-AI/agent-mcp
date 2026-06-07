# @bitget-ai/bitget-agent-mcp

[![npm](https://img.shields.io/npm/v/@bitget-ai/bitget-agent-mcp.svg)](https://www.npmjs.com/package/@bitget-ai/bitget-agent-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

The **MCP surface** of the [Bitget Agent Hub](https://github.com/Bitget-AI/agent-hub) — exposes 56+ Bitget API tools over the [Model Context Protocol](https://modelcontextprotocol.io) so any MCP-capable AI host (Claude Desktop, Cursor, Continue, …) can drive your Bitget account.

## Install / configure

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bitget": {
      "command": "npx",
      "args": ["-y", "@bitget-ai/bitget-agent-mcp"],
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

Use the same `npx -y @bitget-ai/bitget-agent-mcp` command — pass credentials via env vars.

## CLI options

```
bitget-agent-mcp [options]

  --modules <list>     spot,futures,account,margin,copytrading,convert,earn,p2p,broker
                       (or "all"; default: spot,futures,account)
  --read-only          Only read/query tools, no writes
  --paper-trading      Use Bitget Demo Trading (with a Demo API Key)
  --help / --version
```

## Why MCP

If your AI assistant speaks **MCP**, this is the right surface. The server runs locally over stdio, holds your credentials in env vars only, and never proxies traffic through Bitget infrastructure.

If your assistant lives **in your shell** instead (Claude Code, Codex CLI, OpenClaw), prefer [`bitget-agent-cli`](https://github.com/Bitget-AI/agent-cli) (`bgc`) — same tools, just shell-native.

## License

MIT

---

Part of the **[Bitget Agent Hub](https://github.com/Bitget-AI/agent-hub)** — Trading Stack · Surface.
Foundation: [agent-sdk](https://github.com/Bitget-AI/agent-sdk) · Other surfaces: [agent-cli](https://github.com/Bitget-AI/agent-cli) · [agent-skill](https://github.com/Bitget-AI/agent-skill)
