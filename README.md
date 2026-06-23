<p align="center">
  <img src="assets/logo.png" alt="Bitget Agent MCP - Official Bitget Crypto Trading MCP Server for Claude Desktop Cursor Windsurf ChatGPT" width="120" />
</p>

<h1 align="center">bitget-agent-mcp — Official Bitget MCP Trading Server</h1>

<p align="center">
  <strong>Connect Claude Desktop, Cursor, Continue, Windsurf &amp; ChatGPT to Bitget via the Model Context Protocol — trade crypto with natural language.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bitget-ai/bitget-agent-mcp"><img src="https://img.shields.io/npm/v/%40bitget-ai%2Fbitget-agent-mcp.svg?style=flat-square&color=cb3837&label=npm" alt="Bitget Agent MCP npm package version - latest release on npm registry" /></a>
  <a href="https://www.npmjs.com/package/@bitget-ai/bitget-agent-mcp"><img src="https://img.shields.io/npm/dm/%40bitget-ai%2Fbitget-agent-mcp.svg?style=flat-square&color=026e00&label=downloads" alt="Bitget Agent MCP monthly downloads count from npm" /></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-8A2BE2?style=flat-square" alt="Model Context Protocol MCP compatible AI integration standard" /></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A520-026e00?style=flat-square" alt="Requires Node.js version 20 or higher runtime environment" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey?style=flat-square" alt="Supports macOS Linux Windows operating systems" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="MIT open source license - free for commercial use" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#what-you-can-do">Capabilities</a> ·
  <a href="#how-an-agent-uses-it">How It Works</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#security">Security</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#faq">FAQ</a>
</p>

---

## Overview

`bitget-agent-mcp` is the **official Model Context Protocol (MCP) server** for Bitget, enabling desktop AI agents like **Claude Desktop**, **Cursor**, **Continue**, **Windsurf**, and **ChatGPT Desktop** to operate your Bitget account through natural-language commands.

It is built on the [Bitget Unified Trading Account (UTA / v3) API](https://www.bitget.com/api-doc/common/intro) and covers **109 trading operations** across market data, spot, futures, account & funds management, sub-accounts, loans, and tax. Crucially, it does **not** flood your model with one tool per endpoint. Instead it exposes a small, **progressively-discoverable intent surface** of **16 intent verbs** (12 active in the default profile) plus two meta-tools — `discover` and `raw` — so AI hosts get full capability without the context bloat and tool-selection errors that plague endpoint-per-tool servers.

> **Part of [Bitget Agent Hub](https://github.com/Bitget-AI/agent-hub)** — the official open-source AI ecosystem for Bitget, including the CLI, SDK, installer, and market-analysis skills.

---

## Quick Start

### Prerequisites

- **Node.js ≥ 20** ([download](https://nodejs.org/))
- **Bitget API Key** ([create here](https://www.bitget.com/en/api-management)) — enable **Read** + **Trade** permissions
- An MCP-capable AI host (Claude Desktop, Cursor, Continue, Windsurf, ChatGPT Desktop, or any stdio MCP client)

### One-Step Install (Recommended)

Paste this prompt into your AI agent (Claude Desktop / Cursor / etc.):

```text
Please configure the Bitget MCP Server for my AI tool (requires Node.js 20+):
first ask me which AI tool I use (Claude Desktop / Cursor / Windsurf / ChatGPT
Desktop), then add a server that runs `npx -y @bitget-ai/bitget-agent-mcp` to
that tool's MCP config, with BITGET_API_KEY, BITGET_SECRET_KEY, and
BITGET_PASSPHRASE filled in. Confirm once the Bitget tools have loaded.
```

The agent will detect your tool, add the `npx` server entry, wire up credentials, and verify the connection.

### Manual Install

Prefer to edit config files yourself? Jump to [Configuration](#configuration) for per-tool JSON snippets. The command is always:

```bash
npx -y @bitget-ai/bitget-agent-mcp
```

---

## What You Can Do

Once configured, your AI gains native access to Bitget's trading stack through natural language. A few examples (every one maps to a real operation in the surface):

| Ask your AI | What happens | Credentials |
|---|---|:---:|
| "What's the current BTC price?" | Live ticker via the `market` verb | ❌ No |
| "Pull the 4h BTC candles" | OHLCV / K-line history via `market` | ❌ No |
| "What's the BTC perp funding rate?" | Funding rate via `market` | ❌ No |
| "Show my USDT balance across accounts" | Account overview via `account_overview` | ✅ Yes |
| "Buy 0.1 BTC at market" | Spot market order via `order` | ✅ Yes |
| "Set leverage to 10x and open a BTC long" | `account_config` + `order` / `position` | ✅ Yes |
| "List my open orders" | `order` (open) | ✅ Yes |
| "Transfer 500 USDT from spot to futures" | Internal transfer via `transfer_funds` | ✅ Yes |
| "Cancel all my open orders" | `order` (cancelAll) — high-risk, asks to confirm | ✅ Yes |
| "Borrow USDT against my collateral" | Crypto loan via `loan` | ✅ Yes |

Market data (the `market` verb) is **public** and works without API credentials; everything that touches your account requires keys.

### Advanced Modes

- **`--read-only`** — Blocks every write operation for the session. The verbs stay visible, but any order, transfer, cancellation, or withdrawal is rejected before it reaches Bitget. Ideal for safe exploration. (Mutually exclusive with `--paper-trading`.)
- **`--paper-trading`** — Routes signed requests to Bitget's **Demo Trading** environment (adds the `paptrading: 1` header). Requires a separate [Demo API Key](https://www.bitget.com/en/api-management). Perfect for rehearsing strategies risk-free.
- **`--modules <list>`** — Load only the modules you need. Default: `account,trade,market`. On-demand: `strategy`, `cryptoloans`, `tax`. Hidden: `broker`, `instloan` (must be named explicitly; `all` excludes them).
- **`--surface <intent|full>`** — `intent` (default) exposes the curated verbs. `full` *additionally* emits one tool per underlying v3 endpoint (100+ tools) for power/debug use — this exceeds most hosts' tool caps.

---

## How an Agent Uses It

The intent surface is **progressively discoverable**. Rather than reading every schema up front, the agent follows **discover → drill down → execute**:

```
discover({})                                   → list business domains + meta-tools
discover({ domain: "trade" })                  → that domain's verbs, one line each
discover({ tool: "order" })                    → one verb's full input schema (+ its actions)
discover({ tool: "order", action: "place" })   → one action's exact required/optional contract
order({ action: "place", ... })                → execute
```

If the prompt already implies the verb and arguments, the agent skips discovery and calls directly. `discover({ search: "funding" })` keyword-searches the whole surface when the domain is unknown. The two meta-tools are always present:

- **`discover`** — progressive introspection of the surface.
- **`raw`** — an escape hatch that reaches any of the 109 underlying v3 operations by `operationId` for the long tail. (In practice every operation is also covered by a verb, so `raw` is rarely needed.)

### Write Safety

- **Ordinary writes execute immediately.**
- **High-risk / irreversible operations** (e.g. `cancelAll`, `withdraw`) return `{ confirmationRequired: true }` unless you pass `confirm: true`.
- **Any write** accepts `dryRun: true` to preview the would-send request without sending it.

MCP tool annotations are derived from the SDK's `riskLevel` (read / write / high), so hosts can flag destructive operations before the model invokes them.

---

## Architecture

```mermaid
graph TD
    A[AI Host<br/>Claude Desktop / Cursor / …] -->|MCP over stdio| B[bitget-agent-mcp<br/>thin protocol adapter]
    B --> S[@bitget-ai/bitget-agent-sdk<br/>intent verbs · discover · raw<br/>write-safety gate · HMAC signing · retry]
    S -->|HMAC-SHA256 signed| C[Bitget UTA v3 REST API<br/>api.bitget.com]
    D[Environment Variables<br/>BITGET_API_KEY etc.] --> B
    style B fill:#f9f,stroke:#333,stroke-width:2px
    style C fill:#bbf,stroke:#333,stroke-width:2px
```

**How it works:**

1. Your AI host launches the MCP server locally via `npx` over stdio — no network listener, no proxy.
2. Credentials are passed as environment variables from your host's config; the server never stores, logs, or proxies them.
3. All authenticated requests are signed in-process with HMAC-SHA256 and sent directly to Bitget's official API.
4. Responses flow back through MCP to your AI conversation.

All the "smarts" — discovery, intent routing, the write-safety gate, signing, and response shaping — live in [`@bitget-ai/bitget-agent-sdk`](https://github.com/Bitget-AI/agent-sdk). This package is a thin stdio adapter on top of it.

---

## Installation

### Supported AI Hosts

| AI Host | Status | Notes |
|---|:---:|---|
| **Claude Desktop** | ✅ | First-class, via `claude_desktop_config.json` |
| **Cursor** | ✅ | Default profile fits the 40-tool cap with room to spare |
| **Continue** | ✅ | VS Code / JetBrains extension |
| **ChatGPT Desktop** | ✅ | OpenAI's desktop client |
| **Windsurf** | ✅ | Codeium's AI IDE |
| **Any MCP client** | ✅ | Anything that speaks MCP over stdio |

### Step-by-Step Setup

#### 1. Get Your API Key

1. Log in to [bitget.com](https://www.bitget.com)
2. Go to **Profile → API Management**
3. Click **Create API Key**
4. Enable **Read** and **Trade** permissions
5. Copy the three values: `API Key`, `Secret Key`, `Passphrase`

> ⚠️ **Security note:** store these securely. Never share them or commit them to version control.

#### 2. Configure your host

Use the [one-step prompt](#one-step-install-recommended), or add the server to your host's MCP config manually (see [Configuration](#configuration)).

#### 3. Verify

Ask your AI: *"What Bitget tools are available?"* You should see verbs like `market`, `order`, `position`, `account_overview`, plus `discover` and `raw`.

---

## Configuration

### Claude Desktop

Edit `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bitget": {
      "command": "npx",
      "args": ["-y", "@bitget-ai/bitget-agent-mcp"],
      "env": {
        "BITGET_API_KEY": "your-api-key-here",
        "BITGET_SECRET_KEY": "your-secret-key-here",
        "BITGET_PASSPHRASE": "your-passphrase-here"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

### Cursor

**Settings → MCP → Add New Server:**

| Field | Value |
|---|---|
| **Command** | `npx` |
| **Args** | `-y @bitget-ai/bitget-agent-mcp` |
| **Env** | `BITGET_API_KEY`, `BITGET_SECRET_KEY`, `BITGET_PASSPHRASE` |

> ⚠️ **Cursor tool limit:** Cursor caps total MCP tools at **40** across all servers. The default Bitget profile loads **14 tools** (12 intent verbs + `discover` + `raw`), leaving 26 slots for other servers. Even with every module enabled the intent surface is just **18 tools**. Only `--surface full` (one tool per endpoint, 100+ tools) would exceed the cap.

### Continue / Windsurf / ChatGPT Desktop / other MCP hosts

Use the same `npx -y @bitget-ai/bitget-agent-mcp` command and pass credentials via environment variables, following your tool's MCP configuration docs. If the host speaks MCP over stdio, it works.

### Custom Configuration Examples

**Read-only mode (safe for exploration):**
```json
{ "args": ["-y", "@bitget-ai/bitget-agent-mcp", "--read-only"] }
```

**Paper trading (Demo environment — use Demo API keys):**
```json
{
  "args": ["-y", "@bitget-ai/bitget-agent-mcp", "--paper-trading"],
  "env": {
    "BITGET_API_KEY": "your-demo-api-key",
    "BITGET_SECRET_KEY": "your-demo-secret-key",
    "BITGET_PASSPHRASE": "your-demo-passphrase"
  }
}
```

**Load extra modules:**
```json
{ "args": ["-y", "@bitget-ai/bitget-agent-mcp", "--modules", "account,trade,market,cryptoloans,tax"] }
```

### CLI Options & Environment Variables

```
bitget-agent-mcp [options]

  --modules <list>     account, trade, market, strategy,
                       broker, cryptoloans, instloan, tax
                       "all" loads all generally-available modules.
                       broker and instloan are hidden — name them explicitly
                       to expose them ("all" excludes them).
                       Default: account,trade,market

  --surface <mode>     intent  curated verbs + discover + raw (default)
                       full    ALSO emit one tool per underlying v3 endpoint

  --read-only          Expose only read/query operations; block all writes.
  --paper-trading      Enable Demo Trading mode (requires a Demo API Key).
                       Mutually exclusive with --read-only.
  --help               Show help and exit
  --version            Show version and exit
```

| Variable | Purpose |
|---|---|
| `BITGET_API_KEY` | Required for private endpoints |
| `BITGET_SECRET_KEY` | Required for private endpoints |
| `BITGET_PASSPHRASE` | Required for private endpoints |
| `BITGET_API_BASE_URL` | Optional API base URL (default `https://api.bitget.com`) |
| `BITGET_TIMEOUT_MS` | Optional request timeout in ms (default `15000`) |
| `BITGET_MAX_RETRIES` | Optional max transport retries (default: SDK policy) |

Without API credentials, only public/read (market data) operations succeed.

### Modules & Intent Verbs

The default profile loads `account,trade,market`. The full set spans **8 modules**, **16 intent verbs**, and **109 operations**:

| Module | Default | Intent verbs | Operations |
|---|:---:|---|:---:|
| `market` | ✅ | `market` | 16 |
| `trade` | ✅ | `order`, `position`, `strategy_order` | 17 |
| `account` | ✅ | `account_overview`, `account_config`, `repayment`, `transfer_funds`, `deposit`, `withdraw`, `funds_records`, `subaccount` | 39 |
| `strategy` | on-demand | extends `strategy_order` (plan / TP-SL orders) | 5 |
| `cryptoloans` | on-demand | `loan` | 11 |
| `tax` | on-demand | `tax` | 1 |
| `broker` | hidden | `broker` | 11 |
| `instloan` | hidden | `inst_loan` | 9 |

Always present regardless of module: **`discover`** (introspection) and **`raw`** (reach any v3 operation by `operationId`). Every verb's underlying operations collectively cover all 109 endpoints, so the intent surface loses no capability versus `--surface full`.

---

## Security

### Credential Protection

- ✅ **Never leaves your machine** — API keys are read from environment variables only, never logged, written to disk, or proxied through any server.
- ✅ **Local signing** — all authenticated requests are signed in-process with HMAC-SHA256 before connecting directly to Bitget's official API.
- ✅ **Runs locally over stdio** — no network listener, no remote endpoint to harden, no telemetry.

### Safety Modes

- **`--read-only`** — blocks all write operations for the session; the AI can query but cannot place orders, transfer funds, cancel, or withdraw.
- **`--paper-trading`** — routes signed requests to Bitget's Demo environment. No real funds involved. Requires a separate Demo API Key.
- **Write-safety gate** — high-risk/irreversible operations require an explicit `confirm: true`, and any write supports `dryRun: true` for a no-network preview.

### Rate Limiting

The SDK applies a client-side retry/rate-limit policy that protects against AI loops hammering Bitget's API. If Bitget returns a `429`, it backs off and retries automatically.

---

## Troubleshooting

#### "Command not found: npx"

**Cause:** Node.js not installed or not on PATH.
**Fix:** install Node.js ≥ 20 from [nodejs.org](https://nodejs.org/) and restart your terminal/host.

#### "Authentication failed" or "Invalid API key"

**Likely causes & fixes:**
1. API key lacks permissions → enable **Read** + **Trade** at [API Management](https://www.bitget.com/en/api-management).
2. Passphrase is wrong → copy all three values exactly as shown.
3. Live keys used with `--paper-trading` (or vice versa) → use a **Demo API Key** for paper trading.

#### "Tool not recognized by AI"

**Cause:** MCP server not configured correctly, or the host wasn't restarted.
**Fix:** validate the config file is valid JSON, restart the host completely, then ask *"List available MCP tools."*

#### Cursor shows fewer Bitget tools than expected

**Cause:** other MCP servers consuming Cursor's 40-tool cap. The Bitget default profile is **14 tools**.
**Fix:** remove unused MCP servers, or use `--modules` to load only what you need. Avoid `--surface full` in Cursor.

#### "Rate limit exceeded"

**Cause:** too many rapid calls.
**Fix:** the SDK auto-throttles, but if you hit Bitget's server-side limit, wait ~60s before retrying. Avoid asking the AI to place hundreds of orders in quick succession.

#### MCP server won't start

**Check:** Node.js version (`node --version` ≥ 20), network reachability to `api.bitget.com`, and that outbound HTTPS isn't blocked by a firewall.

---

## Updates

Because installation uses `npx -y`, the latest version is pulled automatically each time your AI host starts — **no manual updates needed.**

To force-refresh the npm cache:
```bash
npx @bitget-ai/bitget-agent-mcp@latest --version
```

To upgrade the whole Bitget AI toolkit at once, use the installer in [agent-hub](https://github.com/Bitget-AI/agent-hub).

---

## Related Projects

| Package | Purpose | Best for |
|---|---|---|
| **[agent-cli](https://github.com/Bitget-AI/agent-cli)** | Terminal AI trading tool (`bgc`) | Claude Code, Codex CLI, shell-native agents |
| **[agent-skill](https://github.com/Bitget-AI/agent-skill)** | AI reasoning guide for the CLI | Teaching agents how to use `bgc` correctly |
| **[agent-sdk](https://github.com/Bitget-AI/agent-sdk)** | TypeScript foundation SDK | Developers building custom integrations |
| **[bitget-signal](https://github.com/Bitget-AI/bitget-signal)** | Market-analysis skills (no API key) | Macro, on-chain, sentiment, technical, news |
| **[agent-hub](https://github.com/Bitget-AI/agent-hub)** | Central ecosystem entry + installer | Overview of all Bitget AI tools |

---

## FAQ

### What is bitget-agent-mcp?

It's the **official MCP (Model Context Protocol) server** for Bitget. It exposes **109 Bitget UTA v3 operations** to desktop AI clients (Claude Desktop, Cursor, Windsurf, ChatGPT Desktop, …) through **16 curated intent verbs** plus a `discover` introspection tool and a `raw` escape hatch — over the MCP standard.

### How is this different from agent-cli?

- **`bitget-agent-mcp`** — for **desktop AI hosts** that speak MCP (Claude Desktop, Cursor, …).
- **`agent-cli`** (`bgc`) — for **terminal AI** (Claude Code, Codex CLI) that runs commands in your shell.

Both sit on the same SDK and expose the same intent surface — pick the one that matches your AI tool.

### Why intent verbs instead of one tool per endpoint?

Endpoint-per-tool servers advertise 100+ tools, which bloats the model's context and degrades tool-selection accuracy. The intent surface keeps the default tool list at **14 tools** while still covering all 109 operations — the agent uses `discover` to drill into detail only when it needs to.

### Which modules are loaded by default?

Default: `account` (39 ops), `trade` (17 ops), `market` (16 ops) = **72 operations**, exposed through **12 intent verbs** plus `discover` and `raw` (**14 tools** total). Load more with `--modules strategy,cryptoloans,tax` or `--modules all`; the full set of **16 verbs** covers all **109 operations**.

### Does Cursor have a tool limit?

Yes — Cursor caps total MCP tools at **40**. The default Bitget profile loads **14 tools**, well within the cap (26 slots free). Even with every module enabled the intent surface is **18 tools**. Only `--surface full` would exceed the limit.

### How do I prevent accidental orders?

Add `"--read-only"` to your config args. Every write operation is rejected for the session — the AI can query balances and markets but cannot place orders, transfer funds, cancel, or withdraw.

### Can I test without risking real funds?

Yes — use paper trading: create a [Demo API Key](https://www.bitget.com/en/api-management), set the Demo credentials as environment variables, and add `"--paper-trading"` to your args. Signed requests route to Bitget's Demo environment.

### Is my API key safe?

Yes. Credentials live only in your host's MCP config, are never proxied through any server, are signed locally with HMAC-SHA256 before reaching Bitget, and are never logged or written to disk by this server.

### Is it free?

Yes — MIT-licensed and free for personal and commercial use. The MCP server is maintained by Bitget at no cost.

### What AI tools are supported?

Claude Desktop, Cursor, Continue, ChatGPT Desktop, Windsurf, and any MCP client that communicates over stdio transport.

---

## Contributing

Issues and pull requests are welcome.

- **Report bugs / request features:** [GitHub Issues](https://github.com/Bitget-AI/agent-mcp/issues)
- **Security issues:** please report privately via GitHub's security advisory feature on the [repository](https://github.com/Bitget-AI/agent-mcp) — do not open a public issue.

---

## License

[MIT License](LICENSE) — free for personal and commercial use.

---

<sub>⚠️ <strong>Risk disclaimer:</strong> trading cryptocurrency carries substantial risk. You are solely responsible for any orders your AI agent places on your behalf. Use <code>--read-only</code> and <code>--paper-trading</code> to rehearse safely before going live. Past performance does not guarantee future results.</sub>

<sub>Official Bitget Agent Hub tool · Part of the Bitget open-source AI ecosystem · Foundation: <a href="https://github.com/Bitget-AI/agent-sdk">agent-sdk</a> · Other surfaces: <a href="https://github.com/Bitget-AI/agent-cli">agent-cli</a> · <a href="https://github.com/Bitget-AI/agent-skill">agent-skill</a> · Market signals: <a href="https://github.com/Bitget-AI/bitget-signal">bitget-signal</a></sub>
