# @bitget-ai/bitget-agent-mcp

[![npm](https://img.shields.io/npm/v/%40bitget-ai%2Fbitget-agent-mcp.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@bitget-ai/bitget-agent-mcp)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2?style=flat-square)](https://modelcontextprotocol.io)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-026e00?style=flat-square)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

The **MCP surface** of the [Bitget Agent Hub](https://github.com/Bitget-AI/agent-hub) for the **Unified Trading Account (UTA / v3)** API. It exposes a small, **progressively-discoverable intent surface** over the [Model Context Protocol](https://modelcontextprotocol.io) so Claude Desktop, Cursor, Continue, ChatGPT Desktop, Windsurf, or any other MCP-capable AI host can drive your Bitget account — without flooding the model with one tool per endpoint.

```bash
npx -y @bitget-ai/bitget-agent-mcp
```

> **Prerequisites:** Node.js ≥ 20. A Bitget API key, secret, and passphrase ([create one](https://www.bitget.com/api-doc/common/intro)). An MCP-capable AI host (see table below).

---

## What makes this surface different

Most exchange MCP servers advertise one tool per API endpoint — hundreds of tools that bloat the model's context and degrade tool-selection accuracy. This server instead exposes a **curated intent surface**:

- **~16 intent verbs** (`market`, `order`, `position`, `account_overview`, …) that each fan out to many underlying v3 endpoints.
- **`discover`** — a progressive introspection tool. The agent maps the surface on demand instead of reading every schema up front.
- **`raw`** — an escape hatch that reaches any of the ~200 underlying v3 operations by `operationId` for the long tail.

The default profile is **~14 tools**; the full set of intent verbs is **16** (plus `raw` and `discover`). All of the "smarts" — discovery, intent routing, write-safety gating, and response shaping — live in [`@bitget-ai/bitget-agent-sdk`](https://github.com/Bitget-AI/agent-sdk); this package is a thin stdio adapter on top of it.

---

## How an agent uses it

The intended workflow is **discover → (drill down) → execute**:

```
discover({})                          → list business domains (account, trade, market, …) + meta tools
discover({ domain: "trade" })         → that domain's verbs, one line each
discover({ tool: "order" })           → one verb's full input schema (+ its actions)
discover({ tool: "order", action: "place" })  → one action's exact required/optional contract
order({ action: "place", ... })       → execute
```

If the prompt already implies the verb and arguments, the agent can skip discovery and call directly. `discover({ search: "funding" })` keyword-searches the whole surface when the domain is unknown.

### Example call flows

| Intent | Call |
|---|---|
| "What's the BTC spot price?" | `market({ action: "tickers", category: "SPOT", symbol: "BTCUSDT" })` |
| "Show me my account" | `account_overview({})` |
| "Place a limit buy" | `order({ action: "place", category: "SPOT", symbol: "BTCUSDT", side: "buy", orderType: "limit", price: "60000", qty: "0.001" })` |
| "Cancel all my orders" (high-risk) | `order({ action: "cancelAll" })` → returns `{ confirmationRequired: true }` → re-call with `confirm: true` |
| A long-tail endpoint not covered by a verb | `raw({ operationId: "getAccountBills", args: { … } })` |

### Write safety

- **Ordinary writes execute immediately.**
- **High-risk / irreversible operations** (e.g. `cancelAll`, `withdraw`) return `{ confirmationRequired: true }` unless you pass `confirm: true`.
- **Any write** accepts `dryRun: true` to preview the would-send request without sending it.

MCP tool annotations are derived from the SDK's `riskLevel` (read / write / high), so hosts can flag destructive operations before the model invokes them.

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

> Cursor caps total MCP tools at 40. The intent surface (~14 tools by default, ≤18 with every module enabled) fits comfortably, leaving room for your other servers.

### Continue / Windsurf / ChatGPT Desktop / other MCP hosts

Use the same `npx -y @bitget-ai/bitget-agent-mcp` invocation; pass credentials via env vars. Refer to your host's MCP configuration docs for the exact JSON layout.

### Read-only, paper-trading, or full surface

Add CLI flags after the package name:

```json
"args": ["-y", "@bitget-ai/bitget-agent-mcp", "--read-only"]
```

```json
"args": ["-y", "@bitget-ai/bitget-agent-mcp", "--paper-trading", "--modules", "all"]
```

```json
"args": ["-y", "@bitget-ai/bitget-agent-mcp", "--surface", "full"]
```

---

## CLI options

```
bitget-agent-mcp [options]

  --modules <list>     account, trade, market, strategy,
                       broker, cryptoloans, instloan, tax
                       Special: "all" loads all generally-available modules.
                       broker and instloan are hidden — name them explicitly
                       to expose them ("all" excludes them).
                       Default: account,trade,market

  --surface <mode>     intent  curated verbs + raw + discover (default)
                       full    ALSO emit one tool per underlying v3 endpoint

  --read-only          Expose only read/query operations; block all writes.

  --paper-trading      Enable Demo Trading mode (requires a Demo API Key).
                       Signed (private) requests carry the paptrading: 1 header.
                       Mutually exclusive with --read-only.

  --help               Show help and exit
  --version            Show version and exit
```

Environment variables:

| Variable | Purpose |
|---|---|
| `BITGET_API_KEY` | Required for private endpoints |
| `BITGET_SECRET_KEY` | Required for private endpoints |
| `BITGET_PASSPHRASE` | Required for private endpoints |
| `BITGET_API_BASE_URL` | Optional API base URL (default `https://api.bitget.com`) |
| `BITGET_TIMEOUT_MS` | Optional request timeout in ms (default `15000`) |
| `BITGET_MAX_RETRIES` | Optional max transport retries (default: SDK policy) |

Without API credentials, only public/read operations succeed.

---

## Modules and intent verbs

Verbs are gated by their primary module. The default profile loads `account,trade,market`.

| Module | Default | Intent verbs |
|---|:---:|---|
| `market` | ✅ | `market` |
| `trade` | ✅ | `order`, `position`, `strategy_order` |
| `account` | ✅ | `account_overview`, `account_config`, `repayment`, `transfer_funds`, `deposit`, `withdraw`, `funds_records`, `subaccount` |
| `cryptoloans` | — | `loan` |
| `tax` | — | `tax` |
| `broker` | hidden | `broker` |
| `instloan` | hidden | `inst_loan` |

Always present regardless of module: **`discover`** (introspection) and **`raw`** (reach any v3 operation by `operationId`). Every verb's `fronts` collectively cover all underlying v3 endpoints, so the intent surface loses no capability versus the 1:1 generated tier (`--surface full`).

---

## Tested AI hosts

| Host | Status | Notes |
|---|:---:|---|
| Claude Desktop | ✅ | First-class. |
| Cursor | ✅ | Intent surface fits the 40-tool cap with room to spare. |
| Continue | ✅ | |
| ChatGPT Desktop | ✅ | |
| Windsurf | ✅ | |
| Any MCP-compliant host | ✅ | If it speaks MCP over stdio, it works. |

---

## Why MCP

If your AI assistant speaks **MCP**, this is the right surface for Bitget:

- The server runs **locally** over stdio. No proxy. No telemetry.
- Credentials live in your host's MCP config, never on Bitget's infrastructure.
- One process per AI session — clean shutdown, no orphaned daemons.

If your assistant lives **in your shell** instead (Claude Code, Codex CLI, OpenClaw), prefer [`@bitget-ai/bitget-agent-cli`](https://github.com/Bitget-AI/agent-cli) (`bgc`) — same intent surface, shell-native.

---

## How it's built

```
Your AI host  ──MCP/stdio──►  bitget-agent-mcp  (thin protocol adapter)
                                   │
                                   ▼
                  @bitget-ai/bitget-agent-sdk
                  intent verbs · discover · raw · write-safety gate ·
                  typed REST client · HMAC signing · retry/rate-limit
                                   │
                                   ▼
                       Bitget UTA (v3) REST API
```

The MCP server only handles MCP plumbing: stdio transport, CLI/env configuration, the wire-format mapping (`toMcpTool` + risk-derived annotations), a uniform error envelope (`safeInvoke`), and the workflow briefing carried in the MCP `initialize` instructions. Every tool definition, schema, signing detail, and safety rule comes from the SDK.

---

## Security

- Credentials are read from environment variables only — passed through your MCP host's config, never logged, never written to disk by this server.
- The server runs **locally over stdio** — no network listener, no remote endpoint to harden.
- All authenticated requests are signed with **HMAC-SHA256** in-process.
- Client-side retry/rate-limit policy protects against AI loops hitting Bitget's API limits.
- Write verbs are annotated by `riskLevel`; destructive/irreversible operations require an explicit `confirm: true`, and any write supports `dryRun: true` for a no-network preview.
- `--read-only` and `--paper-trading` provide layered safety nets — recommended for first-time setup.

---

## License

[MIT](LICENSE)

---

<sub>Part of the **[Bitget Agent Hub](https://github.com/Bitget-AI/agent-hub)** ecosystem · Trading Stack · Surface.<br/>
Foundation: [agent-sdk](https://github.com/Bitget-AI/agent-sdk) · Other surfaces: [agent-cli](https://github.com/Bitget-AI/agent-cli) · [agent-skill](https://github.com/Bitget-AI/agent-skill) · Market signals: [bitget-signal](https://github.com/Bitget-AI/bitget-signal)</sub>
