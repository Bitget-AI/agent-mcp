# Changelog

All notable changes to `bitget-agent-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **Now depends on `bitget-agent-sdk`** (was `bitget-core`). All 56+ Bitget API tools and the typed REST client come from the new SDK package.
- **Minimum Node.js version: 20.0.0** (was 18). Node 18 reached end-of-life in April 2025.
- **Pure ESM distribution.** Module format is ESM only; the binary is invoked via `npx -y bitget-agent-mcp` or as an installed bin in your AI host config.
- **Repository moved** from monorepo `agent_hub/packages/bitget-mcp/` to standalone repo [`bitget/agent-mcp`](https://github.com/bitget/agent-mcp).

### Unchanged
- All 56+ tool names, schemas, and behaviours — your AI assistant will see the same tool catalog.
- All CLI flags (`--modules`, `--read-only`, `--paper-trading`).
- Stdio transport via `@modelcontextprotocol/sdk`.

[1.2.0]: https://github.com/bitget/agent-mcp/releases/tag/v1.2.0
