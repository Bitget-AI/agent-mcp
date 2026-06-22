// e2e/protocol.mjs — MCP PROTOCOL CONFORMANCE (Phase 0), the phase unique to an
// MCP server.
//
// The agent-skill harness opens with a "skill fidelity" phase and agent-cli with a
// "CLI contract" phase; the MCP equivalent is the wire contract a host relies on
// the instant it connects, BEFORE any business call:
//
//   • initialize     → serverInfo identity (our own name/version, never the SDK's)
//                       + advertised capabilities (tools / logging / prompts)
//                       + instructions (the discover→verb briefing)
//   • tools/list     → the curated INTENT surface (verbs + raw + discover), NOT one
//                       tool per endpoint; annotations derived from riskLevel
//   • discover       → the self-describing 4-level disclosure every agent drills
//                       (domains → tools → action enum → exact action contract)
//   • prompts/*      → the curated read-only workflow starters render correctly
//   • logging/setLevel → a level change actually gates server log notifications
//   • tools/call     → an unknown tool returns the structured error envelope
//   • surface=full   → a second server config ALSO exposes the 1:1 generated tier
//
// Every check here is a DETERMINISTIC guarantee of the shipped server, not a live
// market probe — so report.mjs never downgrades a `protocol` failure to xfail: a
// broken wire contract misleads every host that ever connects. A failure is a hard
// ❌ and is escalated to a HIGH finding.
//
// All checks share ONE base session (modules=all) except the two that need a
// different server config (surface=full, and a focused logging probe), which get
// their own child via getClient(...). The driver tears them all down at the end.

import { getClient, invoke, resetLogs } from "./mcp.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (a) => JSON.stringify([...a].sort());

/** Core enums an agent MUST see to drive order placement without guessing. */
const WANT_ENUM = {
  "order/place": {
    side: ["buy", "sell"],
    orderType: ["limit", "market"],
    category: ["SPOT", "MARGIN", "USDT-FUTURES", "COIN-FUTURES", "USDC-FUTURES"],
  },
};

/**
 * Run the full conformance sweep. `expected` carries this package's own identity
 * ({ name, version }) so the identity check asserts the wire name is OURS and not
 * the SDK foundation's. Returns an array of result records (phase:"protocol").
 */
export async function runProtocolConformance({ expected, globals }) {
  const out = [];
  const push = (rec) => out.push({ phase: "protocol", ...rec });

  let client;
  try {
    client = await getClient(globals);
  } catch (err) {
    push({ name: "initialize", status: "fail", message: `MCP 握手失败：${String(err?.message || err)}` });
    return out;
  }

  // ── 1. serverInfo identity ────────────────────────────────────────────────
  {
    const v = client.getServerVersion();
    const okName = v?.name === expected.name;
    const notSdk = v?.name !== "bitget-agent-sdk";
    const okVer = v?.version === expected.version;
    const ok = okName && notSdk && okVer;
    push({
      name: "serverInfo-identity",
      status: ok ? "pass" : "fail",
      note: ok
        ? `serverInfo=${v.name}@${v.version}（本包身份，未泄漏 SDK 身份）`
        : `serverInfo 身份不符：name=${v?.name} version=${v?.version}（期望 ${expected.name}@${expected.version}，且不得为 bitget-agent-sdk）`,
    });
  }

  // ── 2. advertised capabilities ────────────────────────────────────────────
  {
    const caps = client.getServerCapabilities() || {};
    const miss = ["tools", "logging", "prompts"].filter((c) => !caps[c]);
    push({
      name: "capabilities",
      status: miss.length ? "fail" : "pass",
      note: miss.length ? `initialize 未声明能力：${miss.join(", ")}` : "已声明 tools + logging + prompts",
    });
  }

  // ── 3. instructions (the discover→verb briefing) ──────────────────────────
  {
    const ins = client.getInstructions() || "";
    const wants = ["discover", "raw", "confirm"];
    const miss = wants.filter((w) => !ins.toLowerCase().includes(w.toLowerCase()));
    const ok = ins.length > 0 && miss.length === 0;
    push({
      name: "instructions-briefing",
      status: ok ? "pass" : "fail",
      note: ok
        ? "initialize.instructions 教授 discover→verb 工作流与写安全(confirm/raw)"
        : ins.length === 0
          ? "initialize 未携带 instructions（host 启动即缺少使用指引）"
          : `instructions 缺少关键指引：${miss.join(", ")}`,
    });
  }

  // ── 4. intent tool surface (verbs + raw + discover; NOT 1:1 endpoints) ─────
  let toolList = [];
  {
    const res = await client.listTools();
    toolList = res.tools || [];
    const names = toolList.map((t) => t.name);
    const wantVerbs = ["market", "order", "position", "account_overview", "raw", "discover"];
    const missVerbs = wantVerbs.filter((w) => !names.includes(w));
    const leaked = ["getTickers", "spot_get_ticker", "system_get_capabilities"].filter((w) => names.includes(w));
    const ok = missVerbs.length === 0 && leaked.length === 0;
    push({
      name: "intent-surface",
      status: ok ? "pass" : "fail",
      note: ok
        ? `intent 表面：${names.length} 个工具（含 ${wantVerbs.join("/")}），未泄漏 1:1 端点或遗留工具`
        : missVerbs.length
          ? `intent 表面缺少动词：${missVerbs.join(", ")}`
          : `intent 表面意外暴露：${leaked.join(", ")}（应仅在 --surface full 出现）`,
    });
  }

  // ── 5. annotations derived from riskLevel (NOT isWrite) ───────────────────
  {
    const find = (n) => toolList.find((t) => t.name === n);
    const order = find("order");
    const market = find("market");
    const acct = find("account_overview");
    const ok =
      order?.annotations?.readOnlyHint === false &&
      market?.annotations?.readOnlyHint === true &&
      acct?.annotations?.readOnlyHint === true;
    push({
      name: "riskLevel-annotations",
      status: ok ? "pass" : "fail",
      note: ok
        ? "注解由 riskLevel 推导：order=write(readOnly=false)、market/account_overview=read(readOnly=true)"
        : `注解未正确从 riskLevel 推导：order.readOnly=${order?.annotations?.readOnlyHint} market.readOnly=${market?.annotations?.readOnlyHint} account_overview.readOnly=${acct?.annotations?.readOnlyHint}`,
    });
  }

  // ── 6. discover 4-level drill-down + self-describing contract ──────────────
  // Black-box the full progressive disclosure:
  //   discover({}) → domains
  //   discover({domain}) → verbs
  //   discover({tool}) → inputSchema + action enum
  //   discover({tool, action}) → { operationId, required[], optional[], requiresConfirm }
  // sweeping EVERY action of EVERY action-routed verb, so a verb that cannot
  // project an action's exact contract (an agent flying blind) fails loudly.
  {
    let verbsSeen = 0;
    let drills = 0;
    const drillFails = [];
    let fieldsTotal = 0;
    let fieldsDescribed = 0;
    const untyped = [];
    const enumMiss = [];
    const confirmFlags = { sawBoolean: false, sawTrue: false };

    const d0 = await invoke("discover", {}, globals);
    const domains = d0.ok && Array.isArray(d0.data?.domains) ? d0.data.domains : [];
    push({
      name: "discover-domains",
      status: domains.length ? "pass" : "fail",
      note: domains.length ? `discover({}) 域：${domains.map((x) => x.domain).join(",")}` : "discover({}) 未返回 domains",
    });

    for (const dom of domains) {
      const dd = await invoke("discover", { domain: dom.domain }, globals);
      const verbTools = dd.ok && Array.isArray(dd.data?.tools) ? dd.data.tools : [];
      for (const vt of verbTools) {
        verbsSeen += 1;
        const dv = await invoke("discover", { tool: vt.name }, globals);
        const actionEnum = dv.ok ? dv.data?.inputSchema?.properties?.action?.enum : null;
        if (!Array.isArray(actionEnum) || actionEnum.length === 0) continue; // no-action verb
        for (const action of actionEnum) {
          drills += 1;
          const da = await invoke("discover", { tool: vt.name, action }, globals);
          const c = da.ok ? da.data : null;
          const okContract =
            c && Boolean(c.operationId) && Array.isArray(c.required) && Array.isArray(c.optional) && typeof c.requiresConfirm === "boolean";
          if (!okContract) {
            drillFails.push(`${vt.name}/${action}`);
            continue;
          }
          confirmFlags.sawBoolean = true;
          if (c.requiresConfirm === true) confirmFlags.sawTrue = true;
          const fields = [...c.required, ...c.optional];
          for (const f of fields) {
            fieldsTotal += 1;
            if (f && f.description) fieldsDescribed += 1;
            const typed = f && (f.type || Array.isArray(f.enum));
            if (!typed && f?.name !== "fields") untyped.push(`${vt.name}/${action}.${f?.name}`);
          }
          const want = WANT_ENUM[`${vt.name}/${action}`];
          if (want) {
            for (const [field, expectedEnum] of Object.entries(want)) {
              const got = fields.find((f) => f?.name === field)?.enum;
              if (!Array.isArray(got) || norm(got) !== norm(expectedEnum)) {
                enumMiss.push(`${vt.name}/${action}.${field}=${JSON.stringify(got ?? null)}`);
              }
            }
          }
        }
      }
    }

    push({
      name: "discover-drilldown",
      status: drillFails.length || drills === 0 ? "fail" : "pass",
      note: drills === 0
        ? "未能枚举任何 action 契约（discover 钻取失败）"
        : drillFails.length
          ? `${drillFails.length}/${drills} 个 action 契约投影失败：${drillFails.slice(0, 8).join(", ")}`
          : `${verbsSeen} 个动词 / ${drills} 个 action 均投影出精确契约（operationId + required/optional + requiresConfirm:boolean）`,
    });

    const cov = fieldsTotal ? (fieldsDescribed / fieldsTotal) * 100 : 0;
    const sdFail = enumMiss.length || untyped.length || cov < 100 || !confirmFlags.sawTrue;
    push({
      name: "self-describing-contract",
      status: sdFail ? "fail" : "pass",
      note: enumMiss.length
        ? `核心枚举缺失/不符：${enumMiss.join("; ")}`
        : untyped.length
          ? `字段缺 type（应仅 fields 视图控制可豁免）：${untyped.slice(0, 8).join(", ")}${untyped.length > 8 ? " …" : ""}`
          : !confirmFlags.sawTrue
            ? "未发现任何 requiresConfirm:true 的高危 action（写安全门元数据可疑）"
            : `核心枚举齐备；描述覆盖 ${fieldsDescribed}/${fieldsTotal}（${cov.toFixed(0)}%）；除 fields 外字段均带 type；高危 action 标注 requiresConfirm`,
    });
  }

  // ── 7. prompts: list returns curated workflows; get renders a user message ─
  {
    const listed = await client.listPrompts();
    const names = (listed.prompts || []).map((p) => p.name);
    const miss = ["account_snapshot", "pre_trade_check"].filter((n) => !names.includes(n));
    let getOk = false;
    let getNote = "";
    if (!miss.length) {
      const got = await client.getPrompt({ name: "pre_trade_check", arguments: { symbol: "BTCUSDT" } });
      const first = got.messages?.[0];
      const content = first?.content;
      getOk = first?.role === "user" && content?.type === "text" && String(content.text).includes("BTCUSDT");
      getNote = getOk ? "" : `pre_trade_check 渲染异常：role=${first?.role} 含BTCUSDT=${String(content?.text || "").includes("BTCUSDT")}`;
    }
    const ok = miss.length === 0 && getOk;
    push({
      name: "prompts",
      status: ok ? "pass" : "fail",
      note: ok
        ? "prompts/list 暴露 account_snapshot + pre_trade_check；getPrompt 渲染出含 symbol 的 user 消息"
        : miss.length
          ? `prompts/list 缺少：${miss.join(", ")}`
          : getNote,
    });
  }

  // ── 8. logging/setLevel actually gates server log notifications ────────────
  // Use a dedicated session so the level change + emitted notifications are
  // isolated from the shared base client's buffer.
  {
    const logClient = await getClient({ ...globals, __probe: "logging" });
    let ok = false;
    let note = "";
    try {
      await logClient.setLoggingLevel("debug");
      resetLogs(logClient);
      // A public read drives the SDK client's request/response lifecycle hooks,
      // which the server forwards as `debug` log notifications when the level allows.
      await logClient.callTool({ name: "market", arguments: { action: "tickers", category: "SPOT", symbol: "BTCUSDT" } });
      await sleep(120); // allow async notification delivery over stdio
      const logs = logClient.__logs || [];
      ok = logs.length > 0 && logs.some((l) => l.logger && l.level);
      note = ok
        ? `logging/setLevel(debug) 生效：收到 ${logs.length} 条 server 日志通知（含 logger/level）`
        : "设置 debug 级别后调用工具仍未收到任何 server 日志通知";
    } catch (err) {
      note = `logging 探测异常：${String(err?.message || err)}`;
    }
    push({ name: "logging-notification", status: ok ? "pass" : "fail", note });
  }

  // ── 9. unknown tool returns the structured error envelope ──────────────────
  {
    const r = await invoke("nonexistent_tool_xyz", {}, globals);
    const ok = !r.ok && r.error && /not available|discover/i.test(String(r.error.message || "") + String(r.error.hint || ""));
    push({
      name: "unknown-tool-error",
      status: ok ? "pass" : "fail",
      note: ok
        ? "未知工具返回 ok:false 错误信封并指向 discover"
        : `未知工具未被正确拒绝：ok=${r.ok} ${String(r.error?.message || "").slice(0, 80)}`,
    });
  }

  // ── 10. surface=full ALSO exposes the 1:1 generated tier ───────────────────
  {
    const full = await getClient({ modules: "market", surface: "full" });
    const res = await full.listTools();
    const names = (res.tools || []).map((t) => t.name);
    const ok = names.includes("getTickers") && names.includes("market");
    push({
      name: "surface-full-tier",
      status: ok ? "pass" : "fail",
      note: ok
        ? "--surface full 同时暴露 1:1 生成层（如 getTickers）与 intent 动词（market）"
        : `--surface full 未按预期暴露 1:1 层：getTickers=${names.includes("getTickers")} market=${names.includes("market")}`,
    });
  }

  return out;
}
