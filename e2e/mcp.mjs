// e2e/mcp.mjs — resolve THIS package's built MCP server and drive it over a real
// stdio MCP session, exactly as an AI host (Claude Desktop / Cursor / Continue)
// would.
//
// The thing under test is the SHIPPED server: `node lib/index.js [flags]`. We do
// NOT reach inside the process; we spawn it and speak the Model Context Protocol
// to it over stdio with the official `@modelcontextprotocol/sdk` Client + the
// `StdioClientTransport` that an end-user host uses. Every exercise crosses a real
// process + protocol boundary — initialize handshake, tools/list, tools/call,
// prompts/*, logging/setLevel — so a wire-contract regression that unit tests
// (which use the in-memory transport) would miss is caught here.
//
// Resolution order for the server entry (first hit wins):
//   1. $MCP_BIN              — explicit override. A `*.js`/`*.mjs` path is run via
//                             `node <file>`; anything else is treated as an
//                             executable on $PATH / absolute path.
//   2. ./lib/index.js        — this package's tsup build (the published bin).
//   3. bitget-agent-mcp on $PATH — a globally-installed copy.
//
// Each distinct server configuration (modules / surface / readOnly / paperTrading)
// plus credential override gets ONE long-lived child + MCP session, cached and
// reused across calls (the MCP handshake is too costly to repeat per call). Call
// closeAll() at the end to tear every session + child down cleanly.
//
// Credentials are FORWARDED from the already-loaded process environment (populated
// by `source e2e/.env-*` in the shell) into the child — the harness never reads a
// .env file itself. A per-call `env` override is shallow-merged on top so a single
// probe can blank the keys (the no-creds ConfigError check) without disturbing the
// rest of the run.
//
// Each tool result's text channel is `JSON.stringify(SafeResult)` — the SDK's
// safeInvoke envelope — so parseToolResult() yields the SAME shape the agent-skill
// / agent-cli harnesses normalize to: `{ ok, data, endpoint, requestTime, error,
// latencyMs }`. That lets cases.mjs / report.mjs port over almost verbatim; the
// only swap from those harnesses is the transport here (MCP stdio vs CLI argv).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, accessSync, constants as FS_CONST, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..");

function isExecutableFile(p) {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, FS_CONST.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate an executable by name on $PATH, returning its absolute path or null. */
function findOnPath(bin) {
  const dirs = (process.env.PATH || "").split(":").filter(Boolean);
  for (const d of dirs) {
    const p = join(d, bin);
    if (isExecutableFile(p)) return p;
  }
  return null;
}

/**
 * Resolve how to spawn the MCP server into `{ command, baseArgs, label }`:
 *  - `node <jsFile> …`   (MCP_BIN=*.js, or this package's ./lib/index.js build)
 *  - `<bin> …`           (MCP_BIN executable, or `bitget-agent-mcp` on $PATH)
 * Returns null when nothing usable is found.
 */
function resolveServer() {
  const bin = process.env.MCP_BIN;
  if (bin) {
    if (/\.(c|m)?js$/.test(bin)) {
      const abs = resolve(bin);
      return { command: process.execPath, baseArgs: [abs], label: `node ${abs} (MCP_BIN)`, exists: existsSync(abs) };
    }
    const abs = bin.includes("/") ? resolve(bin) : findOnPath(bin) || bin;
    return { command: abs, baseArgs: [], label: `${abs} (MCP_BIN)`, exists: bin.includes("/") ? existsSync(abs) : Boolean(findOnPath(bin)) };
  }
  const built = resolve(REPO_ROOT, "lib/index.js");
  if (existsSync(built)) {
    return { command: process.execPath, baseArgs: [built], label: `node ${built} (local build)`, exists: true };
  }
  const onPath = findOnPath("bitget-agent-mcp");
  if (onPath) return { command: onPath, baseArgs: [], label: onPath, exists: true };
  return null;
}

const SERVER = resolveServer();

if (!SERVER || SERVER.exists === false) {
  console.error(
    [
      "[e2e] MCP server entry not found.",
      "Build it first (the normal path):",
      "  pnpm run build      # produces ./lib/index.js",
      "or point the harness at a build/binary:",
      "  MCP_BIN=/abs/path/to/lib/index.js   node e2e/run.mjs",
      "  MCP_BIN=bitget-agent-mcp            node e2e/run.mjs   (global install)",
      SERVER ? `  (MCP_BIN was set but the target does not exist: ${SERVER.label})` : "  looked for ./lib/index.js and `bitget-agent-mcp` on $PATH",
    ].join("\n"),
  );
  process.exit(1);
}

/** Human-readable description of the server entry the harness drives (for the report). */
export const MCP_ENTRY = SERVER.label;

// Hard ceiling per MCP request (mirrors the CLI harness's spawn timeout).
const REQUEST_TIMEOUT_MS = Number(process.env.E2E_CLI_TIMEOUT_MS || "30000");

/**
 * Translate globals `{ modules, surface, readOnly, paperTrading }` into the exact
 * server CLI flags the entry parses. `--read-only` and `--paper-trading` are
 * mutually exclusive (the server rejects both) — callers must not set both.
 */
function buildServerArgs(globals = {}) {
  const args = [...SERVER.baseArgs];
  if (globals.modules) args.push("--modules", String(globals.modules));
  if (globals.surface) args.push("--surface", String(globals.surface));
  if (globals.readOnly) args.push("--read-only");
  if (globals.paperTrading) args.push("--paper-trading");
  return args;
}

/** Build the child env: forward the loaded environment, then apply the override. */
function buildEnv(override) {
  const base = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") base[k] = v;
  }
  base.NODE_NO_WARNINGS = "1";
  return { ...base, ...(override || {}) };
}

// Cache: one connected MCP session per (server args × env override). The handshake
// is expensive, so the bulk run reuses a single session; only the no-creds probe,
// the read-only gate, the surface=full check, and the logging probe spin up their
// own.
const sessions = new Map();

function sessionKey(globals, override) {
  // `__probe` lets a caller force a SEPARATE child + session even when the server
  // args are identical (e.g. an isolated log-notification buffer) — it never
  // reaches buildServerArgs, only the cache key.
  return JSON.stringify({ args: buildServerArgs(globals), env: override || null, probe: globals.__probe || null });
}

/**
 * Get (or create) a connected MCP Client for the given server configuration.
 * The returned client carries a `__logs` array that accumulates every
 * `notifications/message` the server emits — used by the logging conformance
 * check. Use resetLogs(client) to clear it before a focused probe.
 */
export async function getClient(globals = {}, override) {
  const key = sessionKey(globals, override);
  const existing = sessions.get(key);
  if (existing) return existing;

  const transport = new StdioClientTransport({
    command: SERVER.command,
    args: buildServerArgs(globals),
    env: buildEnv(override),
    stderr: "inherit",
  });
  const client = new Client(
    { name: "bitget-agent-mcp-e2e", version: "3.0.0" },
    { capabilities: { logging: {} } },
  );
  client.__logs = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    client.__logs.push(n.params);
  });
  await client.connect(transport);
  sessions.set(key, client);
  return client;
}

/** Clear a client's captured log-notification buffer. */
export function resetLogs(client) {
  client.__logs = [];
}

/** Tear down every cached MCP session + child process. */
export async function closeAll() {
  for (const client of sessions.values()) {
    try {
      await client.close();
    } catch {
      /* best-effort */
    }
  }
  sessions.clear();
}

function truncate(s, n = 240) {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Normalize a raw MCP CallToolResult into a safeInvoke-shaped result.
 *
 * The server's text channel is `JSON.stringify(SafeResult)`:
 *   success → { ok: true, endpoint, requestTime, data }
 *   error   → { ok: false, error: { type, category, … }, timestamp }
 * dryRun previews and confirmationRequired gates are SUCCESS (ok:true) by the SDK
 * contract — their markers live under `data.dryRun` / `data.confirmationRequired`.
 *
 * `isError` on the wire mirrors `!ok`; we trust the parsed envelope as the source
 * of truth and fold `latencyMs` in so cases.mjs / report.mjs consume it unchanged.
 */
export function parseToolResult(res, latencyMs) {
  const content = Array.isArray(res?.content) ? res.content : [];
  const textPart = content.find((c) => c && c.type === "text");
  const text = textPart?.text;
  if (text == null) {
    return {
      ok: false,
      error: { type: "McpOutputError", category: "harness", message: "tool result carried no text content channel" },
      latencyMs,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: { type: "McpOutputError", category: "harness", message: `tool result text is not valid JSON: ${truncate(text)}` },
      latencyMs,
    };
  }
  if (parsed && parsed.ok) {
    return { ok: true, data: parsed.data, endpoint: parsed.endpoint, requestTime: parsed.requestTime, raw: parsed, latencyMs };
  }
  const e = (parsed && parsed.error) || { type: "UnknownError", category: "unknown", message: truncate(text) };
  return { ok: false, error: e, endpoint: e.endpoint, latencyMs, raw: parsed };
}

/**
 * High-level call: `{tool, args, globals, env}` → safeInvoke-shaped result (with
 * `latencyMs`). The drop-in for the CLI harness's `invoke(...)`, but every call
 * crosses a real MCP stdio boundary into the spawned server.
 *
 * A transport-level failure (timeout, crashed child, protocol error) is itself a
 * harness-visible failure, surfaced as `{ ok:false, error:{ type:"McpTransportError" }}`.
 */
export async function invoke(tool, args = {}, globals = {}, env) {
  let client;
  try {
    client = await getClient(globals, env);
  } catch (err) {
    return { ok: false, error: { type: "McpConnectError", category: "harness", message: String(err?.message || err) }, latencyMs: 0 };
  }
  const t0 = Date.now();
  try {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS });
    return parseToolResult(res, Date.now() - t0);
  } catch (err) {
    return { ok: false, error: { type: "McpTransportError", category: "harness", message: String(err?.message || err) }, latencyMs: Date.now() - t0 };
  }
}
