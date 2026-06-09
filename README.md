# @bitget-ai/bitget-agent-mcp

[![npm](https://img.shields.io/npm/v/%40bitget-ai%2Fbitget-agent-mcp.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@bitget-ai/bitget-agent-mcp)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2?style=flat-square)](https://modelcontextprotocol.io)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-026e00?style=flat-square)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

The **MCP surface** of the [Bitget Agent Hub](https://github.com/Bitget-AI/agent-hub) — exposes **59 Bitget API tools** over the [Model Context Protocol](https://modelcontextprotocol.io) so Claude Desktop, Cursor, Continue, ChatGPT Desktop, Windsurf, or any other MCP-capable AI host can drive your Bitget account.

```bash
npx -y @bitget-ai/bitget-agent-mcp
```

> **Prerequisites:** Node.js ≥ 20. A Bitget API key, secret, and passphrase ([create one](https://www.bitget.com/api-doc/common/intro)). An MCP-capable AI host (see table below).

---

## Configure your AI host

### Claude Desktop

Add to `claude_desktop_config.json`:

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

Restart Claude Desktop. Bitget tools appear automatically.

### Cursor

Settings → MCP → add a new server:

| Field | Value |
|---|---|
| Command | `npx` |
| Args | `-y @bitget-ai/bitget-agent-mcp` |
| Env | `BITGET_API_KEY`, `BITGET_SECRET_KEY`, `BITGET_PASSPHRASE` |

> Cursor caps total MCP tools at 40. The default profile (36 tools) fits with 4 slots free for your other servers.

### Continue / Windsurf / ChatGPT Desktop / other MCP hosts

Use the same `npx -y @bitget-ai/bitget-agent-mcp` invocation; pass credentials via env vars. Refer to your host's MCP configuration docs for the exact JSON layout.

### Read-only or paper-trading

Add CLI flags after the package name:

```json
"args": ["-y", "@bitget-ai/bitget-agent-mcp", "--read-only"]
```

```json
"args": ["-y", "@bitget-ai/bitget-agent-mcp", "--paper-trading", "--modules", "all"]
```

---

## CLI options

```
bitget-agent-mcp [options]

  --modules <list>     spot,futures,account,margin,copytrading,
                       convert,earn,p2p,broker
                       Special: "all" loads everything.
                       Default: spot,futures,account (36 tools).

  --read-only          Strip every write tool at load time. The AI
                       will not see place_order / transfer / withdraw
                       / cancel_* etc. — they cannot be invoked.

  --paper-trading      Route all calls to Bitget Demo Trading.
                       Requires a Demo API Key.

  --help               Show help and exit
  --version            Show version and exit
```

Environment variables:

| Variable | Purpose |
|---|---|
| `BITGET_API_KEY` | Required for private endpoints |
| `BITGET_SECRET_KEY` | Required for private endpoints |
| `BITGET_PASSPHRASE` | Required for private endpoints |

---

## Why MCP

If your AI assistant speaks **MCP**, this is the right surface for Bitget:

- The server runs **locally** over stdio. No proxy. No telemetry.
- Credentials live in your host's MCP config, never on Bitget's infrastructure.
- One process per AI session — clean shutdown, no orphaned daemons.

If your assistant lives **in your shell** instead (Claude Code, Codex CLI, OpenClaw), prefer [`@bitget-ai/bitget-agent-cli`](https://github.com/Bitget-AI/agent-cli) (`bgc`) — same 59 tools, shell-native.

---

## Modules and tools

| Module | Tools | Loaded by default | Requires API key |
|---|:---:|:---:|:---:|
| `spot` | 13 | ✅ | partial (writes only) |
| `futures` | 15 | ✅ | partial |
| `account` | 8 | ✅ | yes |
| `margin` | 7 | — | yes |
| `copytrading` | 5 | — | yes |
| `convert` | 3 | — | yes |
| `earn` | 3 | — | yes |
| `p2p` | 2 | — | yes |
| `broker` | 3 | — | yes |
| **Total** | **59** | **36** | |

The full tool catalog with every parameter lives at [agent-hub/docs/tools-reference.md](https://github.com/Bitget-AI/agent-hub/blob/main/docs/tools-reference.md).

---

## Tested AI hosts

| Host | Status | Notes |
|---|:---:|---|
| Claude Desktop | ✅ | First-class. |
| Cursor | ✅ | Default 36-tool profile fits the 40-tool cap. |
| Continue | ✅ | |
| ChatGPT Desktop | ✅ | |
| Windsurf | ✅ | |
| Any MCP-compliant host | ✅ | If it speaks MCP over stdio, it works. |

---

## How it's built

```
Your AI host  ──MCP/stdio──►  bitget-agent-mcp
                                   │
                                   ▼
                  @bitget-ai/bitget-agent-sdk  (59 tools, REST client, signing)
                                   │
                                   ▼
                            Bitget REST API
```

The MCP server is a thin protocol adapter on top of [`@bitget-ai/bitget-agent-sdk`](https://github.com/Bitget-AI/agent-sdk). All tool definitions, schemas, signing, and rate limiting come from the SDK; this package only handles MCP plumbing.

---

## Security

- Credentials are read from environment variables only — passed through your MCP host's config, never logged, never written to disk by this server.
- The server runs **locally over stdio** — no network listener, no remote endpoint to harden.
- All authenticated requests are signed with **HMAC-SHA256** in-process.
- Client-side rate limiting protects against AI loops hitting Bitget's API limits.
- Write tools (`place_order`, `transfer`, `withdraw`, …) carry an explicit `[CAUTION]` annotation so AI hosts can flag them before execution.
- `--read-only` and `--paper-trading` provide layered safety nets — recommended for first-time setup.

---

## License

[MIT](LICENSE)

---

<sub>Part of the **[Bitget Agent Hub](https://github.com/Bitget-AI/agent-hub)** ecosystem · Trading Stack · Surface.<br/>
Foundation: [agent-sdk](https://github.com/Bitget-AI/agent-sdk) · Other surfaces: [agent-cli](https://github.com/Bitget-AI/agent-cli) · [agent-skill](https://github.com/Bitget-AI/agent-skill) · Market signals: [bitget-signal](https://github.com/Bitget-AI/bitget-signal)</sub>
