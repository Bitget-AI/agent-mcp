// Real-network E2E harness for the SHIPPED MCP server — orchestrator.
//
// This is the MCP-over-stdio counterpart of the agent-cli / agent-skill e2e
// runners. The shape is the same (same phases, same safety-by-construction, same
// 4-status report), but the thing under test is the SHIPPED server driven exactly
// as an AI host would drive it:
//
//  1. There is NO in-process call. The server is spawned as `node lib/index.js
//     [flags]` and driven over a real stdio MCP session via the official
//     `@modelcontextprotocol/sdk` Client (see ./mcp.mjs). Every exercise crosses a
//     real process + protocol boundary — initialize / tools/list / tools/call /
//     prompts/* / logging/setLevel — and its tool-result text channel
//     (JSON.stringify(SafeResult)) is normalized into the same
//     `{ ok, data, endpoint, error, latencyMs }` shape, so the orchestration below
//     ports almost verbatim from the CLI harness — the only swap is the transport.
//
//  2. Phase 0 (MCP PROTOCOL CONFORMANCE, ./protocol.mjs) runs FIRST on every
//     suite: the one phase unique to an MCP server. It verifies the wire contract
//     a host relies on the instant it connects (serverInfo identity, capabilities,
//     instructions, intent tool surface, riskLevel annotations, discover drill-
//     down + self-describing contract, prompts, logging notifications, unknown-
//     tool error envelope, surface=full tier) BEFORE any business call. A protocol
//     failure is a HARD ❌ (report.mjs never downgrades it): a broken wire contract
//     misleads every host that ever connects.
//
// The SDK package is imported ONLY for metadata (CATALOG / HIGH_RISK_OPERATIONS /
// SERVER_VERSION): the test ORACLE that decides *what* to probe, *what is safe to
// skip*, and how to label the run — never to make a call. Every API exercise goes
// through the spawned server.
//
//   build first (pnpm run build → ./lib/index.js), then:  node e2e/run.mjs
//   one-shot:                                              pnpm run e2e
//
// Safety: only reads, dryRun previews, confirm-gate verification, and a far-below-
// market BUY limit place→cancel ever hit the wire. High-risk + fund-moving writes
// are NEVER called (see e2e/cases.mjs skipRegistry). Writes require E2E_ALLOW_WRITES=1.

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { CATALOG, HIGH_RISK_OPERATIONS, SERVER_VERSION } from "@bitget-ai/bitget-agent-sdk";
import { MCP_ENTRY, invoke, closeAll } from "./mcp.mjs";
import {
  CHAINED_READS,
  DEFAULTS,
  extractLastPrice,
  farBuyPrice,
  readOps,
  safeStrategyArgs,
  sampleArgs,
  SCENARIOS,
  ScenarioSkip,
  sizeForMarket,
  skipRegistry,
  uniqueSubAccountName,
} from "./cases.mjs";
import { redactedConfig, writeReport } from "./report.mjs";
import { runProtocolConformance } from "./protocol.mjs";
import { resolveSuite } from "./suites.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../e2e-reports");
const pkg = createRequire(import.meta.url)("../package.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// THIS adapter's wire identity (asserted by Phase 0): the published bin name —
// deliberately NOT the package's scoped npm name and NOT the SDK's SERVER_NAME.
const MCP_WIRE_NAME = "bitget-agent-mcp";

// Blank credentials for the no-creds ConfigError probe — shallow-merged over the
// inherited env so this one call sees empty keys without disturbing the rest.
const NO_CREDS = { BITGET_API_KEY: "", BITGET_SECRET_KEY: "", BITGET_PASSPHRASE: "" };

const results = [];
const push = (rec) => results.push(rec);

/**
 * Normalize an MCP tool outcome (already safeInvoke-shaped, with `latencyMs`
 * folded in by ./mcp.mjs) into a result record.
 */
function record(phase, name, operationId, r, note) {
  if (r.ok) {
    push({ phase, name, operationId, endpoint: r.endpoint, status: "pass", latencyMs: r.latencyMs, note });
    return r;
  }
  const e = r.error || {};
  push({
    phase,
    name,
    operationId,
    endpoint: e.endpoint,
    status: "fail",
    latencyMs: r.latencyMs,
    errorType: e.type,
    errorCode: e.code,
    errorCategory: e.category,
    message: e.message,
    note,
  });
  return r;
}

/** Find our just-placed order in an open-orders payload across Bitget's shapes
 *  ({list:[...]} | array), matched by orderId OR clientOid. */
function findOpenOrder(data, orderId, clientOid) {
  const rows = Array.isArray(data?.list) ? data.list : Array.isArray(data) ? data : [];
  return (
    rows.find(
      (o) => o && (String(o.orderId) === String(orderId) || o.clientOid === clientOid),
    ) || null
  );
}

/**
 * Record an assertion step over a write-phase query (查单/消失校验). If the
 * underlying query call itself failed, record the API error (so a benign error
 * can still downgrade); otherwise pass/fail on the assertion with an
 * AssertionError message (a real ❌ that never downgrades to benign).
 */
function assertWrite(name, operationId, r, ok, passNote, failMsg) {
  if (!r.ok) {
    const e = r.error || {};
    push({ phase: "write", name, operationId, endpoint: e.endpoint, status: "fail", latencyMs: r.latencyMs, errorType: e.type, errorCode: e.code, errorCategory: e.category, message: e.message, note: "查询失败" });
    return false;
  }
  push({
    phase: "write",
    name,
    operationId,
    endpoint: r.endpoint,
    status: ok ? "pass" : "fail",
    latencyMs: r.latencyMs,
    ...(ok ? { note: passNote } : { errorType: "AssertionError", message: failMsg }),
  });
  return ok;
}

async function main() {
  const startedAt = new Date().toISOString();
  const hasKeys = Boolean(
    process.env.BITGET_API_KEY && process.env.BITGET_SECRET_KEY && process.env.BITGET_PASSPHRASE,
  );
  // Resolve the active suite (E2E_SUITE env → legacy E2E_LIVE=1 → default "paper").
  const suite = resolveSuite();
  const allowWrites = suite.allowWrites && DEFAULTS.allowWrites && hasKeys;

  // Drive the server exactly like a host: full module set. paperTrading is driven
  // by the active suite (paper=on, agent-sub/main=off) and forwarded as a server
  // flag (`--paper-trading`). These globals ride along on every invoke().
  const globals = { modules: "all", ...(suite.paperTrading ? { paperTrading: true } : {}) };

  console.log(`[e2e] MCP entry: ${MCP_ENTRY}`);
  console.log(`[e2e] suite: ${suite.key} | mode: ${suite.paperTrading ? "paper (demo)" : "🔴 LIVE (real funds)"} | keys: ${hasKeys ? "yes" : "no"} | writes: ${allowWrites ? "ON" : "off"}`);

  // ── Phase 0: MCP PROTOCOL CONFORMANCE (the one phase unique to an MCP server) ─
  // Runs FIRST on every suite. Deterministic wire-contract guarantees of the
  // shipped server (public reads at most) — a failure here is escalated to HIGH
  // and is NEVER downgraded to xfail. `expected` is THIS adapter's own identity so
  // the identity check asserts the wire name is ours (not the SDK foundation's).
  if (suite.phases.protocol) {
    const protoRecs = await runProtocolConformance({
      expected: { name: MCP_WIRE_NAME, version: pkg.version },
      globals,
    });
    for (const rec of protoRecs) push(rec);
  }

  // ── Phase 1: connectivity (public read, real network) ─────────────────────
  let connectivityOk = false;
  if (suite.phases.connectivity) {
    const out = await invoke("market", { action: "tickers", category: "SPOT", symbol: DEFAULTS.symbol }, globals);
    record("connectivity", "market.tickers(SPOT)", "getTickers", out, "公共行情连通性探针");
    connectivityOk = out.ok;
  }

  // ── Phase 2: read sweep (all read ops via `raw`) ──────────────────────────
  if (suite.phases.read) {
    for (const op of readOps(CATALOG)) {
      if (op.auth === "private" && !hasKeys) {
        push({ phase: "read", name: "raw", operationId: op.operationId, endpoint: `${op.method} ${op.path}`, status: "skip", note: "私有读：未配置凭据" });
        continue;
      }
      // Chained read: source a real id from a prior read, then GET (read-then-read).
      const chain = CHAINED_READS[op.operationId];
      if (chain) {
        let id = null;
        for (const src of chain.sources) {
          const probe = await invoke("raw", { operationId: src.operationId, args: src.args }, globals);
          if (probe.ok) {
            id = chain.pick(probe.data);
            if (id) break;
          }
        }
        if (!id) {
          push({ phase: "read", name: "raw(chained)", operationId: op.operationId, endpoint: `${op.method} ${op.path}`, status: "skip", note: chain.emptyNote });
        } else {
          const out = await invoke("raw", { operationId: op.operationId, args: { ...sampleArgs(op), ...chain.toArgs(id) } }, globals);
          record("read", "raw(chained)", op.operationId, out, `链式：用真实 id=${id} 查询`);
        }
        if (DEFAULTS.delayMs > 0) await sleep(DEFAULTS.delayMs);
        continue;
      }
      const out = await invoke("raw", { operationId: op.operationId, args: sampleArgs(op) }, globals);
      record("read", "raw", op.operationId, out);
      if (DEFAULTS.delayMs > 0) await sleep(DEFAULTS.delayMs);
    }
  }

  // ── Phase 3: scenario coverage (typical market/account/trade journeys) ────
  // The read sweep proves each endpoint *answers*; these prove the answers are
  // *usable* by asserting on the real payload an agent consumes. A wrong-shape
  // result that still returns 200 OK fails here (AssertionError → ❌); a benign
  // API error (no funds/position) on a scenario call downgrades to 🟡.
  if (suite.phases.scenario) {
    for (const sc of SCENARIOS) {
      const base = { phase: "scenario", name: sc.id, title: sc.title, domain: sc.domain };
      if (sc.auth === "private" && !hasKeys) {
        push({ ...base, status: "skip", note: "私有场景：未配置凭据" });
        continue;
      }
      if (sc.needsWrites && !allowWrites) {
        push({ ...base, status: "skip", note: "需要写权限：未开启 E2E_ALLOW_WRITES=1" });
        continue;
      }
      const t0 = Date.now();
      const r1 = await invoke(sc.tool, sc.args, globals);
      if (!r1.ok) {
        const e = r1.error || {};
        push({ ...base, status: "fail", endpoint: e.endpoint, latencyMs: Date.now() - t0, errorType: e.type, errorCode: e.code, errorCategory: e.category, message: e.message, note: "主调用失败" });
        if (DEFAULTS.delayMs > 0) await sleep(DEFAULTS.delayMs);
        continue;
      }
      let endpoint = r1.endpoint;
      let data2 = null;
      if (typeof sc.then === "function") {
        const spec = sc.then(r1.data);
        if (!spec) {
          push({ ...base, status: "skip", endpoint, latencyMs: Date.now() - t0, note: "前置数据不足，跳过(良性)" });
          if (DEFAULTS.delayMs > 0) await sleep(DEFAULTS.delayMs);
          continue;
        }
        const r2 = await invoke(spec.tool, spec.args, globals);
        if (!r2.ok) {
          const e = r2.error || {};
          push({ ...base, status: "fail", endpoint: e.endpoint || endpoint, latencyMs: Date.now() - t0, errorType: e.type, errorCode: e.code, errorCategory: e.category, message: e.message, note: "二次调用失败" });
          if (DEFAULTS.delayMs > 0) await sleep(DEFAULTS.delayMs);
          continue;
        }
        data2 = r2.data;
        endpoint = r2.endpoint || endpoint;
      }
      try {
        sc.assert(r1.data, data2);
        push({ ...base, status: "pass", endpoint, latencyMs: Date.now() - t0 });
      } catch (err) {
        if (err instanceof ScenarioSkip) {
          push({ ...base, status: "skip", endpoint, latencyMs: Date.now() - t0, note: err.message });
        } else {
          push({ ...base, status: "fail", endpoint, latencyMs: Date.now() - t0, errorType: "AssertionError", message: err?.message || String(err), note: "断言未通过" });
        }
      }
      if (DEFAULTS.delayMs > 0) await sleep(DEFAULTS.delayMs);
    }
  }

  // ── Phase 4: write cycle (opt-in, gated by suite) ──────────────────────────
  if (suite.phases.write && allowWrites) {
    for (const mkt of DEFAULTS.markets) {
      const tk = await invoke("market", { action: "tickers", category: mkt, symbol: DEFAULTS.symbol }, globals);
      const last = tk.ok ? extractLastPrice(tk.data) : null;
      if (!last) {
        push({ phase: "write", name: "order.place", operationId: `placeOrder(${mkt})`, status: "skip", note: `${mkt}: 无法获取市价，安全起见跳过下单` });
        continue;
      }
      const price = farBuyPrice(last);
      const qty = sizeForMarket(mkt);
      // Defense-in-depth for LIVE: never place an order whose notional exceeds the
      // cap (default 60 USDT). The far-below-market price already prevents a fill;
      // this guards against a misconfigured size/symbol burning real funds.
      const notional = Number(price) * Number(qty);
      if (!suite.paperTrading && Number.isFinite(notional) && notional > suite.maxNotional) {
        push({ phase: "write", name: "order.place", operationId: `placeOrder(${mkt})`, status: "skip", note: `${mkt}: 名义价值≈${notional.toFixed(2)} USDT 超过实盘上限 ${suite.maxNotional} USDT，安全起见跳过下单` });
        continue;
      }
      const clientOid = randomUUID();
      // Futures (hedge mode) require posSide to declare the open direction; a
      // BUY opens long. SPOT has no position side.
      const posSide = mkt === "SPOT" ? undefined : "long";
      const placeArgs = { action: "place", category: mkt, symbol: DEFAULTS.symbol, side: "buy", orderType: "limit", price, qty, ...(posSide ? { posSide } : {}), clientOid };
      const placed = await invoke("order", placeArgs, globals);
      const placeRes = record("write", "order.place", `placeOrder(${mkt})`, placed, `限价买 price=${price} (≈${Math.round(DEFAULTS.priceFactor * 100)}% of ${last}), qty=${qty}`);
      if (!placeRes.ok) continue; // nothing placed → nothing to cancel
      const orderId = placeRes.data?.orderId ?? placeRes.data?.data?.orderId;

      // 查单①：下单后该委托必须出现在「未成交委托」列表里，且状态为未成交。
      await sleep(400);
      {
        const q = await invoke("order", { action: "open", category: mkt, symbol: DEFAULTS.symbol }, globals);
        const mine = q.ok ? findOpenOrder(q.data, orderId, clientOid) : null;
        const st = String(mine?.orderStatus ?? mine?.status ?? "").toLowerCase();
        assertWrite("order.queryOpen", `unfilledOrders(${mkt})`, q,
          Boolean(mine) && !st.includes("fill"),
          mine ? `已在未成交列表查到本委托（orderStatus=${st || "?"}）` : "",
          mine ? `委托状态异常（疑似已成交）：orderStatus=${st}` : `下单后在未成交列表中找不到该委托（orderId=${orderId}）`);
      }

      const detail = await invoke("order", { action: "detail", category: mkt, symbol: DEFAULTS.symbol, orderId, clientOid }, globals);
      record("write", "order.detail", `getOrderDetails(${mkt})`, detail);
      // Always attempt cleanup by both ids.
      const cancel = await invoke("order", { action: "cancel", category: mkt, symbol: DEFAULTS.symbol, orderId, clientOid }, globals);
      record("write", "order.cancel", `cancelOrder(${mkt})`, cancel);

      // 查单②：撤单后该委托必须从「未成交委托」列表里消失——证明撤单真的生效。
      await sleep(400);
      {
        const q = await invoke("order", { action: "open", category: mkt, symbol: DEFAULTS.symbol }, globals);
        const still = q.ok ? findOpenOrder(q.data, orderId, clientOid) : null;
        assertWrite("order.verifyGone", `unfilledOrders(${mkt})`, q,
          q.ok && !still,
          "撤单后该委托已从未成交列表消失",
          still ? `撤单后委托仍在未成交列表（orderId=${orderId}）` : "撤单后查询未成交列表失败");
      }
      if (DEFAULTS.delayMs > 0) await sleep(DEFAULTS.delayMs);
    }
  }

  // ── Phase 4b: strategy (TP/SL) create→read→cancel (opt-in, futures only) ──
  // SAFETY: drives `strategy_order` with `type:"tpsl"` ONLY — a TP/SL attaches to
  // an existing position and has no side/triggerPrice, so it cannot open one
  // (zero exposure). Far-from-market triggers + immediate cancel; in a
  // position-less account the API rejects place ("no position") — benign.
  if (suite.phases.strategy && allowWrites) {
    const mkt = "USDT-FUTURES";
    const tk = await invoke("market", { action: "tickers", category: mkt, symbol: DEFAULTS.symbol }, globals);
    const last = tk.ok ? extractLastPrice(tk.data) : null;
    if (!last) {
      push({ phase: "write", name: "strategy.place", operationId: "placeStrategyOrder", status: "skip", note: `${mkt}: 无法获取市价，安全起见跳过策略单` });
    } else {
      const clientOid = randomUUID();
      const placeArgs = { action: "place", ...safeStrategyArgs(last, { symbol: DEFAULTS.symbol }), clientOid };
      const placed = await invoke("strategy_order", placeArgs, globals);
      const placeRes = record("write", "strategy.place", "placeStrategyOrder", placed, `TP/SL(type=tpsl,full) tp≈${Math.floor(last * 3)} sl≈${Math.floor(last * 0.3)}（远离市价·须持仓方可成单）`);
      if (placeRes.ok) {
        const sid = placeRes.data?.orderId ?? placeRes.data?.data?.orderId ?? clientOid;
        const open = await invoke("strategy_order", { action: "open", category: mkt }, globals);
        record("write", "strategy.open", "unfilledStrategyOrders", open, "创建后读取未成交策略单");
        const cancel = await invoke("strategy_order", { action: "cancel", category: mkt, orderId: sid, clientOid }, globals);
        record("write", "strategy.cancel", "cancelStrategyOrder", cancel);
      }
      if (DEFAULTS.delayMs > 0) await sleep(DEFAULTS.delayMs);
    }
  }

  // ── Phase 5: safety gates (server flags → SDK gate; no real write hits wire) ─
  // These exercise the write-safety gates the server exposes. Each gate fires
  // BEFORE any signed request, so they pass with or without credentials. These
  // are deterministic SDK guarantees — report.mjs never downgrades a gate failure.
  if (suite.phases.safety) {
    // Gate C — dryRun returns a preview, never sends.
    const dry = await invoke("order", { action: "place", category: "SPOT", symbol: DEFAULTS.symbol, side: "buy", orderType: "limit", price: "1", qty: DEFAULTS.size, dryRun: true }, globals);
    push({ phase: "gate", name: "dryRun-preview", status: dry.ok && dry.data?.dryRun === true ? "pass" : "fail", endpoint: dry.ok ? dry.endpoint : dry.error?.endpoint, latencyMs: dry.latencyMs, note: dry.ok && dry.data?.dryRun === true ? "dryRun 返回预览且未发送" : "dryRun 未按预期返回预览" });

    // Gate A — high-risk cancelAll without confirm is gated, not executed.
    const ca = await invoke("order", { action: "cancelAll", category: "SPOT", symbol: DEFAULTS.symbol }, globals);
    push({ phase: "gate", name: "cancelAll-confirm-gate", status: ca.ok && ca.data?.confirmationRequired === true ? "pass" : "fail", latencyMs: ca.latencyMs, note: ca.ok && ca.data?.confirmationRequired === true ? "高危 cancelAll 未执行，返回 confirmationRequired" : "⚠️ cancelAll 未被闸门拦截" });

    // Gate B — --read-only refuses writes (ValidationError, before network).
    // Use a clean globals set (NOT the suite's): --read-only and --paper-trading
    // are mutually exclusive, so the paper suite's paperTrading must be dropped
    // here — this spawns its own dedicated read-only server child.
    const ro = await invoke("raw", { operationId: "placeOrder", args: { symbol: DEFAULTS.symbol, category: "SPOT", side: "buy", orderType: "limit", price: "1", qty: DEFAULTS.size } }, { modules: "all", readOnly: true });
    push({ phase: "gate", name: "readOnly-blocks-write", status: !ro.ok && ro.error?.type === "ValidationError" ? "pass" : "fail", latencyMs: ro.latencyMs, note: !ro.ok && ro.error?.type === "ValidationError" ? "--read-only 下写操作被拒(ValidationError)" : "⚠️ --read-only 未阻止写" });

    // Gate D — a private verb with credentials blanked must fail with ConfigError
    // before any network — proving the server refuses to sign without creds. The
    // NO_CREDS override spawns its own dedicated child via the env-keyed session.
    const nc = await invoke("order", { action: "open", category: "SPOT" }, globals, NO_CREDS);
    push({ phase: "gate", name: "private-no-creds", status: !nc.ok && nc.error?.type === "ConfigError" ? "pass" : "fail", latencyMs: nc.latencyMs, errorType: nc.error?.type, note: !nc.ok && nc.error?.type === "ConfigError" ? "无凭据私有调用按预期 ConfigError" : `期望 ConfigError，实际：${nc.ok ? "成功(不应)" : (nc.error?.type || "?")}` });
  }

  // ── Phase 6: Agent sub-account lifecycle (main account only) ──────────────
  // createAgentSubAccount returns subUid + apiKey + secret in one call; lifecycle:
  // create → verify list → verify keys → cleanup (delete the auto-generated key).
  if (suite.phases.subAccountLifecycle && allowWrites && hasKeys) {
    const label = uniqueSubAccountName();
    let subUid = null;
    let agentApiKey = null;
    const TEST_PASSPHRASE = "Test1234";

    // Step 1: createAgentSubAccount → subUid + apiKey + secret
    {
      const r = await invoke("raw", { operationId: "createAgentSubAccount", args: { username: label, passphrase: TEST_PASSPHRASE, note: label } }, globals);
      if (r.ok) {
        subUid = r.data?.subUid ?? r.data?.data?.subUid;
        agentApiKey = r.data?.apiKey ?? r.data?.data?.apiKey;
      }
      record("subaccount", "raw", "createAgentSubAccount", r, subUid ? `创建 Agent 子账户 username=${label}, subUid=${subUid}` : `创建 Agent 子账户 username=${label}`);
      if (r.ok && subUid) await sleep(3000); // wait for propagation
    }

    // Step 2: getSubAccountList — verify the new agent sub-account appears
    if (subUid) {
      const r = await invoke("raw", { operationId: "getSubAccountList", args: {} }, globals);
      const found = r.ok && Array.isArray(r.data?.list) ? r.data.list.some((s) => s && String(s.subUid) === String(subUid)) : false;
      record("subaccount", "raw", "getSubAccountList", r, found ? `验证通过：subUid=${subUid} 出现在子账户列表中` : `子账户列表未找到 subUid=${subUid}`);
      if (DEFAULTS.delayMs > 0) await sleep(DEFAULTS.delayMs);
    }

    // Step 3: getSubAccountApiKeys — verify the auto-generated key exists
    if (subUid) {
      const r = await invoke("raw", { operationId: "getSubAccountApiKeys", args: { subUid } }, globals);
      const found = r.ok && Array.isArray(r.data?.list) ? r.data.list.some((k) => k && (k.apiKey === agentApiKey || k.note === label)) : false;
      record("subaccount", "raw", "getSubAccountApiKeys", r, found ? `验证通过：Agent 子账户的 API key 在列表中` : `Agent 子账户 API key 未在列表中确认（label=${label}）`);
      if (DEFAULTS.delayMs > 0) await sleep(DEFAULTS.delayMs);
    }

    // Step 4: deleteSubAccountApiKey — cleanup the auto-generated key
    if (subUid && agentApiKey) {
      const r = await invoke("raw", { operationId: "deleteSubAccountApiKey", args: { apikey: agentApiKey } }, globals);
      record("subaccount", "raw", "deleteSubAccountApiKey", r, `清理 Agent 自动生成的 API key（best-effort）`);
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const finishedAt = new Date().toISOString();
  const meta = {
    startedAt,
    finishedAt,
    mcpEntry: MCP_ENTRY,
    suite: suite.key,
    suiteLabel: suite.label,
    suiteDescription: suite.description,
    mode: suite.paperTrading ? "paper" : "live",
    hasKeys,
    allowWrites,
    markets: DEFAULTS.markets,
    connectivityOk,
    config: redactedConfig({
      baseUrl: process.env.BITGET_API_BASE_URL || "https://api.bitget.com (default)",
      paperTrading: suite.paperTrading,
      readOnly: false,
      surface: "intent",
      modules: ["all"],
      hasAuth: hasKeys,
      apiKey: process.env.BITGET_API_KEY || "",
      secretKey: process.env.BITGET_SECRET_KEY || "",
      passphrase: process.env.BITGET_PASSPHRASE || "",
      userAgent: `bitget-agent-mcp ${pkg.version} (via bitget-agent-sdk ${SERVER_VERSION})`,
      timeoutMs: Number(process.env.BITGET_TIMEOUT_MS || "15000"),
    }),
  };
  const skips = skipRegistry(CATALOG, HIGH_RISK_OPERATIONS, suite.exercisedWriteOps);
  const { mdPath, jsonPath, summary, findings } = writeReport({ meta, results, skips }, OUT_DIR);

  console.log(
    `\n[e2e] 完成：${summary.total} 用例 → ✅${summary.pass} 🟡${summary.xfail} ❌${summary.fail} ⏭️${summary.skip}`,
  );
  console.log(`[e2e] 报告：${mdPath}`);
  console.log(`[e2e] JSON：${jsonPath}`);
  const highs = findings.filter((f) => f.severity === "high");
  if (highs.length) {
    console.log(`[e2e] ⚠️ HIGH 级别发现 ${highs.length} 项：`);
    for (const f of highs) console.log(`   - ${f.text}`);
  }
  // Verdict: genuine defects only. xfail (expected env/sampling/permission limits)
  // is intercepted in the report and never blocks — so a green run is "0 真实缺陷
  // + 连通性 OK". Exit non-zero only on a genuine defect or connectivity failure.
  const passed = summary.fail === 0 && connectivityOk;
  console.log(
    passed
      ? `[e2e] ✅ 判定：通过 — 0 项真实缺陷${summary.xfail ? `（🟡 ${summary.xfail} 项预期内失败已自动截获）` : ""}`
      : `[e2e] ❌ 判定：失败 — ${summary.fail} 项真实缺陷待查${connectivityOk ? "" : "；且公共行情未连通"}`,
  );
  return passed ? 0 : 1;
}

main()
  .then(async (code) => {
    await closeAll();
    process.exit(code);
  })
  .catch(async (err) => {
    // Last-resort: never crash silently — still surface what broke + a partial report.
    console.error("[e2e] 运行器异常退出：", err?.stack || err);
    try {
      const finishedAt = new Date().toISOString();
      const { mdPath } = writeReport(
        {
          meta: { startedAt: finishedAt, finishedAt, mcpEntry: MCP_ENTRY, hasKeys: false, allowWrites: false, markets: [], connectivityOk: false, config: { note: "run aborted before config built" } },
          results,
          skips: [],
        },
        OUT_DIR,
      );
      console.error(`[e2e] 部分报告已写出：${mdPath}`);
    } catch {
      // ignore secondary failure
    }
    try {
      await closeAll();
    } catch {
      // ignore
    }
    process.exit(1);
  });
