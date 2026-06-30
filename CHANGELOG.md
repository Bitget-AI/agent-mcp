# Changelog

All notable changes to `bitget-agent-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-06-22

Migration to the **Unified Trading Account (UTA / v3)** SDK. The MCP server is now
a thin stdio adapter over the v3 `ToolSpec[]`; all discovery, intent routing, write
safety, and response shaping live in `@bitget-ai/bitget-agent-sdk`.

### Changed
- **Now depends on `@bitget-ai/bitget-agent-sdk@^3.0.0`** — the spec-driven UTA v3 rewrite (generated from `openapi.yaml`). The previous multi-product-line model (spot/futures/margin/earn/…) is gone.
- **Progressive intent surface (default).** The server advertises ~16 curated intent verbs (`market`, `order`, `position`, `account_overview`, …) plus `raw` and `discover` — not one tool per endpoint. Agents start from `discover({})` → `discover({ tool })` → `discover({ tool, action })`, then call the verb. This decouples the tool list from the ~200 underlying v3 endpoints.
- **Modules are now v3 modules:** `account, trade, market, strategy, broker, cryptoloans, instloan, tax`. Default `account,trade,market`. `broker` and `instloan` are hidden (`"all"` excludes them; name them explicitly to expose).
- **MCP tool annotations derive from the SDK `riskLevel`** (read / write / high), not from `isWrite` — so composite verbs whose per-action safety gate decides (e.g. `order`) are correctly advertised as writes.
- **Capability posture moved into the MCP `initialize` instructions** (surface, modules, readOnly, paperTrading, authenticated) — a one-time, zero-cost briefing.

### Added
- **`--surface <intent|full>`** (default `intent`). `full` ALSO emits one 1:1 tool per underlying v3 endpoint for power/debug use; capability is otherwise preserved via the intent verbs' `fronts` and the `raw` escape hatch.
- **Write safety gate (via the SDK):** ordinary writes execute immediately; high-risk/irreversible operations (e.g. `cancelAll`, `withdraw`) return `{ confirmationRequired: true }` unless `confirm: true` is passed. Any write accepts `dryRun: true` to preview the would-send request.
- **`logging` capability.** The SDK client's lifecycle hooks (request/response/retry/error) are forwarded to the host as MCP log notifications, gated by the level the host selects via `logging/setLevel` (default `info`, so routine debug chatter stays off until requested).
- **`prompts` capability.** Two read-only workflow starters — `account_snapshot` (balances + open positions + working orders) and `pre_trade_check` (pre-order safety review for a symbol) — that steer the agent through the intent verbs without triggering an unconfirmed write.
- **Graceful shutdown.** `SIGINT`/`SIGTERM` close the server and transport cleanly so no orphaned stdio process is left behind.

### Changed
- **MCP wire identity is the package's own name/version** (`bitget-agent-mcp` / package `version`), not the SDK's `SERVER_NAME`/`SERVER_VERSION`. `--version` and the `--help` usage line report the same.
- **Tool results emit compact JSON** in the text channel (token economy); the full envelope is still available on `structuredContent` for successful results, which is omitted on the error path (reserved for schema-shaped success output).

### Removed
- **The hand-rolled `system_get_capabilities` tool** and its capability snapshot — superseded by the SDK's `discover` tool and the server `instructions`.
- **All earn-module warmup/probing machinery** — the v3 surface is static for the session (no runtime capability probing).

## [1.2.0] - 2026-05-29

### Added
- **Provenance attestations** on published artefacts (`publishConfig.provenance: true`) for supply-chain verification on npm.

### Changed
- **Renamed package: `bitget-mcp-server` → `bitget-agent-mcp`.** The new name aligns with the `bitget-agent-*` family naming convention and drops the redundant `-server` suffix (MCP servers are conventionally named without it). The previous `bitget-mcp-server` name is no longer maintained on npm.
- **Renamed binary: `bitget-mcp-server` → `bitget-agent-mcp`.** Update your AI host config accordingly:
  ```diff
  - "command": "npx", "args": ["-y", "bitget-mcp-server"]
  + "command": "npx", "args": ["-y", "bitget-agent-mcp"]
  ```
- **MCP server identity** (`serverInfo.name` over the wire) is now `"bitget-agent-mcp"`.
- **Now depends on `@bitget-ai/bitget-agent-sdk`** (was `bitget-core`). All 56+ Bitget API tools and the typed REST client come from the new SDK package.
- **Minimum Node.js version: 20.0.0** (was 18). Node 18 reached end-of-life in April 2025.
- **Pure ESM distribution.** Module format is ESM only; the binary is invoked via `npx -y bitget-agent-mcp` or as an installed bin in your AI host config.
- **Repository moved** from monorepo `agent_hub/packages/bitget-mcp/` to standalone repo [`Bitget-AI/agent-mcp`](https://github.com/Bitget-AI/agent-mcp).

### Unchanged
- All 56+ tool names, schemas, and behaviours — your AI assistant will see the same tool catalog.
- All CLI flags (`--modules`, `--read-only`, `--paper-trading`).
- Stdio transport via `@modelcontextprotocol/sdk`.

[3.0.0]: https://github.com/Bitget-AI/agent-mcp/releases/tag/v3.0.0
[1.2.0]: https://github.com/Bitget-AI/agent-mcp/releases/tag/v1.2.0
