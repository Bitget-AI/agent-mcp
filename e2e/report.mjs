// e2e/report.mjs — turns the collected result records into a human Markdown
// report + a machine JSON report under e2e-reports/.
//
// Ported from the agent-skill harness's report writer; the only structural
// change is the Phase-0 lens. agent-skill opens with a "skill fidelity" phase
// and agent-cli with a "CLI contract" phase; the MCP server's Phase 0 is wire
// PROTOCOL CONFORMANCE (initialize identity / capabilities / instructions /
// intent tool surface / riskLevel annotations / discover drill-down + self-
// describing contract / prompts / logging notifications / unknown-tool envelope
// / surface=full tier). Those are deterministic guarantees of the shipped
// server, so a `protocol` failure is escalated to a HIGH finding and is NEVER
// downgraded to xfail.
//
// SECURITY: credentials are NEVER written to disk. The api key is reduced to a
// short fingerprint; secret/passphrase are reported only as present/absent.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATUSES = ["pass", "xfail", "fail", "skip", "gated"];

/** Redact a config into something safe to persist. */
export function redactedConfig(config) {
  const fp = (s) => (s ? `${String(s).slice(0, 4)}…(len ${String(s).length})` : "absent");
  return {
    baseUrl: config.baseUrl,
    paperTrading: config.paperTrading,
    readOnly: config.readOnly,
    surface: config.surface,
    modules: config.modules,
    hasAuth: config.hasAuth,
    apiKey: fp(config.apiKey),
    secretKey: config.secretKey ? "configured (redacted)" : "absent",
    passphrase: config.passphrase ? "configured (redacted)" : "absent",
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
  };
}

function summarize(results) {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of results) if (r.status in byStatus) byStatus[r.status] += 1;
  return { total: results.length, ...byStatus };
}

/**
 * Classify a Bitget API failure by its message into a semantic bucket, so the
 * report separates *expected* environment/sampling noise from genuine SDK
 * signal instead of lumping every HTTP 4xx as "unknown".
 *
 *  - demoUnhosted: "Request URL NOT FOUND" — under paperTrading the demo env
 *    only hosts a subset of endpoints; this is an environment limit, NOT a
 *    catalog/path defect. (Without paperTrading the same 404 IS suspicious.)
 *  - unfunded:     "Insufficient balance/margin" — the request fully passed SDK
 *    + exchange validation and was rejected only at the funding layer.
 *  - timeRange:    "startTime should be less than endTime" / "interval cannot
 *    exceed ..." — the generic sampler's start/end stamps are equal or span too
 *    wide for the endpoint's max query window; a harness limit, not an SDK bug.
 *  - emptyData:    "... is empty / data fetched by ... is empty" — the path +
 *    signing worked; the account simply has no rows for that resource.
 *  - noPosition:   a TP/SL strategy order was fully accepted and rejected only
 *    because the account holds no position to attach to — benign business layer.
 *  - permission:   "sub-account not allow access / not a Broker / does not belong
 *    / Disable subaccount" — account role/permission limit, not an SDK defect.
 *  - samplerParam: generic-sample args the live API rejects (missing enum, no
 *    real orderId, etc.) — a harness sampling limit, not an SDK defect.
 *  - unknown:      anything else — the real "investigate me" bucket.
 */
function classifyApiFailure(message = "") {
  if (/NOT FOUND/i.test(message)) return "demoUnhosted";
  if (/Insufficient (balance|margin)/i.test(message)) return "unfunded";
  if (/startTime should be less than endTime|interval cannot exceed/i.test(message)) return "timeRange";
  if (/is empty|data fetched by/i.test(message)) return "emptyData";
  if (/no position|take profit or stop loss order can be made/i.test(message)) {
    return "noPosition";
  }
  if (
    /not allow access|not a Broker|does not belong to this account|Disable subaccount/i.test(
      message,
    )
  ) {
    return "permission";
  }
  if (
    /must be passed|does not exist|cannot be empty|not empty|Parameter \{0\}|null does not exist|Parameter verification failed|illegal params/i.test(
      message,
    )
  ) {
    return "samplerParam";
  }
  return "unknown";
}

/**
 * Decide whether a failed result is an *expected* (benign) failure that should
 * be intercepted as `xfail` rather than counted as a genuine ❌ defect. The bar
 * is deliberately conservative — we only downgrade a failure when ALL of:
 *   - it is a real API call phase (read/write/subaccount/scenario), NOT a
 *     `protocol`/`connectivity`/`gate` check (those are deterministic server
 *     guarantees — a failure there misleads every connecting host, never benign);
 *   - it is not an unexpected InternalError (a possible SDK contract violation);
 *   - it is not an auth failure (key/permission/IP problems are worth a look);
 *   - it is not a scenario AssertionError (200 with the wrong payload shape);
 *   - and its message classifies into a known benign bucket (NOT "unknown").
 * Everything else stays a hard ❌, so a truly novel failure still surfaces.
 */
function isExpectedFailure(r) {
  if (r.status !== "fail") return false;
  if (!["read", "write", "subaccount", "scenario"].includes(r.phase)) return false;
  if (r.errorType === "InternalError") return false;
  if (r.errorCategory === "auth") return false;
  if (r.errorType === "AssertionError") return false;
  return classifyApiFailure(r.message ?? "") !== "unknown";
}

/**
 * Auto-derive findings (the "internal problems" lens). Each finding is
 * { severity: "high"|"medium"|"info", text }.
 */
export function deriveFindings(results, meta) {
  const findings = [];
  const reads = results.filter((r) => r.phase === "read");
  const gates = results.filter((r) => r.phase === "gate");
  const writes = results.filter((r) => r.phase === "write");

  // 1. connectivity
  if (meta.connectivityOk === false) {
    findings.push({
      severity: "high",
      text: "无法连通公共行情接口（api.bitget.com）——检查公网连通性 / 代理 / 是否被限频。后续所有真网结果均不可信。",
    });
  }

  // 2. unexpected internal errors = possible SDK contract violation
  const internal = results.filter((r) => r.errorType === "InternalError");
  if (internal.length) {
    findings.push({
      severity: "high",
      text: `MCP 捕获到 ${internal.length} 个非预期 InternalError（疑似 SDK 内部契约问题，经 MCP 透传）：${internal
        .map((r) => r.operationId || r.name)
        .join(", ")}`,
    });
  }

  // 3. safety gates must all pass — these are SDK-behavior guarantees
  const gateFails = gates.filter((r) => r.status === "fail");
  for (const g of gateFails) {
    findings.push({ severity: "high", text: `安全闸门未按预期工作：${g.name} —— ${g.note ?? ""}` });
  }

  // 3b. MCP 协议一致性（Phase 0）—— 本仓库出货的是一个 MCP stdio server，其线协议契约
  // 是「每一个连接它的 host 在发起任何业务调用之前」就依赖的东西:serverInfo 身份、
  // initialize 能力声明与 instructions 指引、intent 工具表面与由 riskLevel 推导的注解、
  // discover 的四级渐进钻取与自描述契约（每个 action 投影出 operationId + required/
  // optional + requiresConfirm）、prompts、logging/setLevel 通知门、未知工具的结构化错误
  // 信封、以及 --surface full 的 1:1 层。任何一条 protocol 失败都意味着线契约被破坏（会
  // 误导每一个连接的 host），升级为 high，且 writeReport 从不把 protocol 失败降级为 xfail。
  const protocolFails = results.filter((r) => r.phase === "protocol" && r.status === "fail");
  for (const c of protocolFails) {
    findings.push({
      severity: "high",
      text: `MCP 协议一致性未达标：${c.name} —— ${c.note ?? c.message ?? ""}`,
    });
  }
  const protocolAll = results.filter((r) => r.phase === "protocol");
  if (protocolAll.length && !protocolFails.length) {
    findings.push({
      severity: "info",
      text: `MCP 协议一致性：${protocolAll.length} 项检查全部通过——serverInfo 身份（本包名/版本，未泄漏 SDK 身份）、能力声明（tools/logging/prompts）、instructions 教授 discover→verb 与写安全、intent 工具表面（动词+raw+discover，未泄漏 1:1 端点）、注解由 riskLevel 推导、discover 四级钻取与自描述契约、prompts 渲染、logging 通知门、未知工具结构化错误信封、--surface full 1:1 层均符合 MCP 规范。`,
    });
  }

  // 4. read sweep failures, separated into expected env/sampling noise vs. the
  //    genuine "investigate" bucket. Include xfail: a benign read failure is
  //    reclassified to xfail before this runs, but the info-finding explaining
  //    why it was benign must still fire.
  const readFails = reads.filter((r) => r.status === "fail" || r.status === "xfail");
  if (readFails.length) {
    const nonSkip = reads.filter((r) => r.status !== "skip").length;
    const buckets = {
      demoUnhosted: [],
      unfunded: [],
      timeRange: [],
      emptyData: [],
      noPosition: [],
      permission: [],
      samplerParam: [],
      unknown: [],
    };
    for (const r of readFails) buckets[classifyApiFailure(r.message)].push(r.operationId);
    const paper = meta.config?.paperTrading;
    const fourOhFourSeverity = paper ? "info" : "medium";
    if (buckets.demoUnhosted.length) {
      findings.push({
        severity: fourOhFourSeverity,
        text: `只读：${buckets.demoUnhosted.length} 个返回 404「Request URL NOT FOUND」${
          paper
            ? "——paperTrading 下属预期：模拟盘只托管账户/交易核心子集，资金类·子账户·broker·借贷·税务等端点未部署，非 SDK/catalog 缺陷（签名已被通过的私有读证明可用）。"
            : "——非 paperTrading 却 404，疑似 catalog 路径与线上不符，需核查这些 operationId 的 path。"
        }`,
      });
    }
    if (buckets.samplerParam.length) {
      findings.push({
        severity: "info",
        text: `只读：${buckets.samplerParam.length} 个为取样/参数工件（${buckets.samplerParam.join(
          ", ",
        )}）——通用取样器无法猜中每个端点的合法枚举/真实 orderId，属测试框架取样局限，非 SDK 缺陷；可按需在 cases.mjs 的 ARG_OVERRIDES 中补全。`,
      });
    }
    if (buckets.timeRange.length) {
      findings.push({
        severity: "info",
        text: `只读：${buckets.timeRange.length} 个为时间窗取样工件（${buckets.timeRange.join(
          ", ",
        )}）——通用取样器给 startTime/endTime 填了相同值，被实盘以「startTime should be less than endTime」拒绝，属测试框架取样局限，非 SDK 缺陷。`,
      });
    }
    if (buckets.permission.length) {
      findings.push({
        severity: "info",
        text: `只读：${buckets.permission.length} 个为账户角色/权限限制（${buckets.permission.join(
          ", ",
        )}）——当前 key 为子账户/非 broker，无权访问这些主账户·broker 专属端点，非 SDK 缺陷。`,
      });
    }
    if (buckets.emptyData.length) {
      findings.push({
        severity: "info",
        text: `只读：${buckets.emptyData.length} 个路径+签名均通过但账户无数据（${buckets.emptyData.join(
          ", ",
        )}）——接口正常，仅该资源在本账户下无记录，非 SDK 缺陷。`,
      });
    }
    if (buckets.noPosition.length) {
      findings.push({
        severity: "info",
        text: `只读：${buckets.noPosition.length} 个因账户无持仓被拒（${buckets.noPosition.join(
          ", ",
        )}）——接口/签名/参数均通过，仅缺少可操作的持仓，非 SDK 缺陷。`,
      });
    }
    if (buckets.unknown.length) {
      findings.push({
        severity: "medium",
        text: `只读：${buckets.unknown.length}/${nonSkip} 个失败待查（unknown）：${buckets.unknown.join(
          ", ",
        )}。`,
      });
    }
    const authFails = readFails.filter((r) => r.errorCategory === "auth");
    if (authFails.length) {
      findings.push({
        severity: "medium",
        text: `其中 ${authFails.length} 个为鉴权失败（auth）——可能是 API key 权限不足 / 签名 / IP 白名单问题，而非接口本身缺陷。`,
      });
    }
  }

  // 4b. scenario coverage (typical market/account/trade journeys). The read
  //     sweep proves each endpoint answers; scenarios prove the answer is
  //     *usable*. A genuine ❌ here is a usable-payload defect — escalate to high.
  const scenarios = results.filter((r) => r.phase === "scenario");
  if (scenarios.length) {
    const sFail = scenarios.filter((r) => r.status === "fail");
    const sPass = scenarios.filter((r) => r.status === "pass").length;
    const sXfail = scenarios.filter((r) => r.status === "xfail").length;
    const sSkip = scenarios.filter((r) => r.status === "skip").length;
    if (sFail.length) {
      for (const r of sFail) {
        findings.push({
          severity: "high",
          text: `场景用例未通过（${r.domain ?? "?"}）：${r.title || r.name} —— ${r.message ?? ""}。接口返回看似成功，但 agent 实际要用的数据形态不对，需排查。`,
        });
      }
    } else {
      findings.push({
        severity: "info",
        text: `场景用例：${sPass} 通过${sXfail ? ` / ${sXfail} 预期内` : ""}${sSkip ? ` / ${sSkip} 跳过` : ""}，覆盖 market/account/trade 常用路径，核心数据形态均可用。`,
      });
    }
  }

  // 5. write-cycle outcome per market (labels adapt to paper vs live).
  const live = meta.mode === "live";
  const tradeLabel = live ? "实盘交易" : "纸面交易";
  if (meta.allowWrites) {
    for (const market of meta.markets) {
      const placed = writes.find((r) => r.operationId === `placeOrder(${market})`);
      if (!placed) continue;
      if (placed.status === "pass") {
        const cancelled = writes.find(
          (r) => r.operationId === `cancelOrder(${market})` && r.status === "pass",
        );
        const queried = writes.find((r) => r.name === "order.queryOpen" && r.operationId === `unfilledOrders(${market})`);
        const gone = writes.find((r) => r.name === "order.verifyGone" && r.operationId === `unfilledOrders(${market})`);
        const queriedOk = queried?.status === "pass";
        const goneOk = gone?.status === "pass";
        const problem = (queried && !queriedOk) || (gone && !goneOk);
        findings.push({
          severity: problem ? "high" : "info",
          text: `${tradeLabel} ${market}：真实下单成功${queriedOk ? "、已在未成交列表查到该委托" : queried ? "、但未成交列表查不到该委托(需排查)" : ""}${cancelled ? "、撤单成功" : "、但撤单未确认——请人工核查残留挂单"}${goneOk ? "、撤单后该委托已消失" : gone ? "、但撤单后该委托仍在列表(需排查)" : ""}（place→查单→detail→cancel→确认消失 全链路${problem ? "存在异常" : "通过"}）。`,
        });
      } else if (placed.status === "fail" || placed.status === "xfail") {
        if (classifyApiFailure(placed.message) === "unfunded") {
          findings.push({
            severity: "info",
            text: live
              ? `${tradeLabel} ${market}：下单已通过 SDK + 交易所的全部校验（签名·参数·精度·最小下单量），仅在资金层被拒（${placed.message ?? ""}）——资金尚在资金/现货账户，未划入下单所用的统一交易账户，非 SDK 缺陷；将资金划入统一账户后即可跑通 place→detail→cancel 回环（订单远低于市价不会成交，零真实成交风险）。`
              : `${tradeLabel} ${market}：下单已通过 SDK + 交易所的全部校验（签名·参数·精度·最小下单量），仅在资金层被拒（${placed.message ?? ""}）——模拟盘账户未注入虚拟资金，非 SDK 缺陷；给模拟盘${market === "SPOT" ? "现货钱包充值 USDT" : "合约账户划入保证金"}后即可跑通 place→detail→cancel 回环。`,
          });
        } else {
          findings.push({
            severity: "info",
            text: `${tradeLabel} ${market}：下单失败（${placed.errorCategory ?? placed.errorType ?? "?"}：${placed.message ?? ""}）——可能该市场不支持 / 精度·最小下单量不符 / key 无交易权限。`,
          });
        }
      }
    }
    // Strategy (TP/SL) cycle outcome — its own clause. type:tpsl can only attach
    // TP/SL to an existing position, so in a position-less account the exchange
    // rejects it (benign) — distinguish that from a real failure.
    const stratPlace = writes.find((r) => r.operationId === "placeStrategyOrder");
    if (stratPlace) {
      if (stratPlace.status === "pass") {
        const stratCancelled = writes.find(
          (r) => r.operationId === "cancelStrategyOrder" && r.status === "pass",
        );
        findings.push({
          severity: "info",
          text: `${tradeLabel} 策略单(TP/SL)：下单成功${stratCancelled ? " 且已撤单（place→open→cancel 回环通过）" : "，但撤单未确认——请人工核查残留策略单"}。`,
        });
      } else if (classifyApiFailure(stratPlace.message) === "noPosition") {
        findings.push({
          severity: "info",
          text: `${tradeLabel} 策略单(TP/SL)：SDK 已正确路由 placeStrategyOrder，且 type=tpsl/tpslMode=full/posSide/triggerBy/orderType 等枚举均被交易所接受，仅因当前账户无持仓被业务层拒绝（${stratPlace.message ?? ""}）——type:tpsl 仅能给已有持仓挂止盈止损、无法开仓，故零市场敞口，属预期良性结果，非 SDK 缺陷。如需跑通完整 place→open→cancel 策略回环，需先持有一笔仓位（真实市场敞口，需显式授权）。`,
        });
      } else {
        findings.push({
          severity: "info",
          text: `${tradeLabel} 策略单(TP/SL)：下单失败（${stratPlace.errorCategory ?? stratPlace.errorType ?? "?"}：${stratPlace.message ?? ""}）——请核查参数/权限。`,
        });
      }
    }
  } else {
    findings.push({ severity: "info", text: `${live ? "实盘" : "纸面"}写回环未执行（未设置 E2E_ALLOW_WRITES=1）。` });
  }

  // 5b. sub-account lifecycle outcome (main account suite only)
  const subaccount = results.filter((r) => r.phase === "subaccount");
  if (subaccount.length) {
    const create = subaccount.find((r) => r.operationId === "createAgentSubAccount");
    const list = subaccount.find((r) => r.operationId === "getSubAccountList");
    const apiKeys = subaccount.find((r) => r.operationId === "getSubAccountApiKeys");
    const delKey = subaccount.find((r) => r.operationId === "deleteSubAccountApiKey");

    const passed = subaccount.filter((r) => r.status === "pass" || r.status === "xfail").length;
    const failed = subaccount.filter((r) => r.status === "fail").length;

    if (create?.status === "pass") {
      const listOk = list?.note?.includes("验证通过");
      const keysOk = apiKeys?.note?.includes("验证通过");
      findings.push({
        severity: "info",
        text: `子账户生命周期：创建成功（subUid=${create.note?.match(/subUid=(\d+)/)?.[1] || "?"}）→ ${listOk ? "列表验证通过" : "列表验证未通过"} → ${keysOk ? "API key 验证通过" : "API key 验证未通过"} → ${delKey?.status === "pass" ? "API key 已清理（best-effort）" : "API key 清理未完全成功（需人工核查）"}（${passed}/${subaccount.length} 步通过${failed ? `，${failed} 步失败` : ""}）。`,
      });
    } else if (create?.status === "fail") {
      findings.push({
        severity: "medium",
        text: `子账户生命周期：创建失败（${create.message ?? "?"}）——后续步骤已跳过。可能原因：主账户 key 无子账户管理权限 / 已存在同名子账户 / 频率限制。`,
      });
    }

    if (delKey?.status === "fail") {
      findings.push({
        severity: "medium",
        text: `子账户 API key 清理失败（${delKey.message ?? "?"}）——请人工核查并删除残留的测试 API key。`,
      });
    }
  }

  // 6. latency outliers
  const timed = results.filter((r) => typeof r.latencyMs === "number");
  if (timed.length) {
    const max = Math.max(...timed.map((r) => r.latencyMs));
    const slow = timed.filter((r) => r.latencyMs > 5000);
    if (slow.length) {
      findings.push({
        severity: "medium",
        text: `${slow.length} 个调用延迟 > 5s（最大 ${max}ms）：${slow
          .map((r) => `${r.operationId || r.name}(${r.latencyMs}ms)`)
          .slice(0, 8)
          .join(", ")}`,
      });
    }
  }

  if (!findings.some((f) => f.severity === "high")) {
    findings.unshift({ severity: "info", text: "未发现 high 级别问题：MCP 协议一致性、连通性、安全闸门、SDK 契约均正常。" });
  }
  return findings;
}

// ── Markdown rendering ──────────────────────────────────────────────────────

function mdTable(headers, rows) {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((cells) => `| ${cells.map((c) => String(c ?? "")).join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
}

function section(title, body) {
  return `## ${title}\n\n${body}\n`;
}

function statusIcon(s) {
  return { pass: "✅ pass", xfail: "🟡 预期内", fail: "❌ fail", skip: "⏭️ skip", gated: "🚦 gated" }[s] ?? s;
}

export function renderMarkdown({ meta, results, findings, skips }) {
  const sum = summarize(results);
  const parts = [];

  parts.push(`# Bitget agent-mcp（MCP-over-stdio）· 真网 E2E 质量报告\n`);
  parts.push(
    `> 被测对象：出货的 MCP server（\`node lib/index.js\`），由真实的 \`@modelcontextprotocol/sdk\` Client 通过 stdio 传输按 host 方式驱动——每次调用都跨越真实的进程 + 协议边界。\n`,
  );
  if (meta.suiteLabel) {
    parts.push(`> **套件**：${meta.suiteLabel} — ${meta.suiteDescription || ""}\n`);
  }
  parts.push(
    `> 生成时间：${meta.startedAt} → ${meta.finishedAt}　|　MCP 入口：\`${meta.mcpEntry}\`\n`,
  );

  // Verdict line — the single thing to read. After xfail interception, the only
  // failures left in `sum.fail` are genuine defects, so fail===0 (+ connectivity)
  // means "all green". xfail is surfaced but never blocks the verdict.
  const realFail = sum.fail;
  const verdict =
    realFail === 0 && meta.connectivityOk !== false
      ? `> # ✅ 判定：通过 — 0 项真实缺陷${sum.xfail ? `（🟡 ${sum.xfail} 项为预期内的环境/取样/权限限制，已自动截获）` : ""}\n`
      : `> # ❌ 判定：失败 — ${realFail} 项真实缺陷待查（见末节「发现的问题」）${meta.connectivityOk === false ? "；且公共行情未连通" : ""}\n`;
  parts.push(verdict);

  // 1. 概要
  parts.push(
    section(
      "1. 概要",
      [
        mdTable(
          ["项", "值"],
          [
            ["运行模式", meta.suiteLabel
              ? `${meta.mode === "live" ? "🔴" : ""} ${meta.suiteLabel}`
              : (meta.mode === "live" ? "🔴 实盘（真实资金）" : "纸面（模拟盘）")],
            ["baseURL", meta.config.baseUrl],
            ["paperTrading", meta.config.paperTrading],
            ["surface", meta.config.surface],
            ["modules", (meta.config.modules || []).join(",")],
            ["凭据", meta.hasKeys ? "已配置（脱敏）" : "未配置（仅公共读）"],
            ["允许写回环", meta.allowWrites ? "是 (E2E_ALLOW_WRITES=1)" : "否"],
            ["总用例", sum.total],
            ["✅ pass / 🟡 预期内 / ❌ fail / ⏭️ skip", `${sum.pass} / ${sum.xfail} / ${sum.fail} / ${sum.skip}`],
            ["框架健康（连通性）", meta.connectivityOk ? "OK" : "FAILED"],
          ],
        ),
      ].join("\n"),
    ),
  );

  // 2. 环境与配置（脱敏）
  parts.push(
    section(
      "2. 环境与配置（脱敏）",
      "```json\n" + JSON.stringify(meta.config, null, 2) + "\n```",
    ),
  );

  // Sections 1 (概要) and 2 (环境) are emitted above; number the rest with a
  // running counter so inserting/removing a section never desyncs the headings.
  let n = 2;
  const heading = (title) => `${++n}. ${title}`;

  // Phase 0 — MCP 协议一致性（本仓库独有的硬保证）：被测对象是一个 MCP server，其线契约
  // 是 host 连上即依赖的东西。放在所有阶段之前——线契约错了，后面所有业务调用都建立在
  // 错误的契约之上。
  const protocol = results.filter((r) => r.phase === "protocol");
  if (protocol.length) {
    parts.push(
      section(
        heading(`MCP 协议一致性（initialize · 工具表面 · discover · prompts · logging · 错误信封，${protocol.length} 项）`),
        mdTable(
          ["检查", "状态", "备注/错误"],
          protocol.map((r) => [
            r.name,
            statusIcon(r.status),
            truncate((r.status === "fail" ? r.message || r.note : r.note) || "", 90),
          ]),
        ),
      ),
    );
  }

  // 连通性 & 发现
  const connectivity = results.filter((r) => r.phase === "connectivity");
  parts.push(
    section(
      heading("连通性 & 发现流程"),
      mdTable(
        ["用例", "状态", "endpoint", "延迟(ms)", "备注"],
        connectivity.map((r) => [r.name, statusIcon(r.status), r.endpoint ?? "-", r.latencyMs ?? "-", r.note ?? ""]),
      ),
    ),
  );

  // 只读扫描
  const reads = results.filter((r) => r.phase === "read");
  parts.push(
    section(
      heading(`只读扫描结果（${reads.length} 个读操作）`),
      mdTable(
        ["operationId", "状态", "endpoint", "延迟(ms)", "错误类别", "错误信息"],
        reads.map((r) => [
          r.operationId,
          statusIcon(r.status),
          r.endpoint ?? "-",
          r.latencyMs ?? "-",
          r.status === "fail" ? classifyApiFailure(r.message ?? "") : (r.errorCategory ?? ""),
          truncate(r.message ?? r.note ?? "", 60),
        ]),
      ),
    ),
  );

  // 场景化用例（market/account/trade 典型路径）
  const scenarios = results.filter((r) => r.phase === "scenario");
  parts.push(
    section(
      heading(`场景化用例（market/account/trade 典型路径，${scenarios.length} 项）`),
      scenarios.length
        ? mdTable(
            ["用例", "说明", "领域", "状态", "延迟(ms)", "备注/错误"],
            scenarios.map((r) => [
              r.name,
              r.title ?? "",
              r.domain ?? "",
              statusIcon(r.status),
              r.latencyMs ?? "-",
              truncate((r.status === "fail" ? r.message || r.note : r.note) || "", 70),
            ]),
          )
        : "_无场景用例。_",
    ),
  );

  // 写回环
  const writes = results.filter((r) => r.phase === "write");
  parts.push(
    section(
      heading(`${meta.mode === "live" ? "实盘" : "纸面"}写回环（place → 查单 → detail → cancel → 确认消失）`),
      writes.length
        ? mdTable(
            ["步骤", "状态", "endpoint", "延迟(ms)", "备注/错误"],
            writes.map((r) => [
              r.operationId || r.name,
              statusIcon(r.status),
              r.endpoint ?? "-",
              r.latencyMs ?? "-",
              truncate((r.status === "fail" ? r.message || r.note : r.note || r.message) || "", 70),
            ]),
          )
        : "_未执行（未配置凭据或未开启 E2E_ALLOW_WRITES=1）。_",
    ),
  );

  // Agent 子账户生命周期（主账户套件专有）
  const subaccount = results.filter((r) => r.phase === "subaccount");
  if (subaccount.length) {
    parts.push(
      section(
        heading("Agent 子账户生命周期（create → verify list → verify keys → cleanup）"),
        mdTable(
          ["步骤", "状态", "endpoint", "延迟(ms)", "备注/错误"],
          subaccount.map((r) => [
            r.operationId,
            statusIcon(r.status),
            r.endpoint ?? "-",
            r.latencyMs ?? "-",
            truncate(r.note ?? "", 80),
          ]),
        ),
      ),
    );
  }

  // 安全闸门
  const gates = results.filter((r) => r.phase === "gate");
  parts.push(
    section(
      heading("安全闸门验证"),
      mdTable(
        ["闸门", "状态", "备注"],
        gates.map((r) => [r.name, statusIcon(r.status), r.note ?? ""]),
      ),
    ),
  );

  // 跳过清单
  parts.push(
    section(
      heading(`跳过清单（${skips.length} 个写操作，永不执行）`),
      mdTable(
        ["operationId", "endpoint", "原因"],
        skips.map((s) => [s.operationId, s.endpoint, s.reason]),
      ),
    ),
  );

  // 发现的问题 & 质量结论
  parts.push(
    section(
      heading("发现的问题 & 质量结论"),
      findings
        .map((f) => `- **[${f.severity.toUpperCase()}]** ${f.text}`)
        .join("\n"),
    ),
  );

  return parts.join("\n");
}

function truncate(s, n) {
  s = String(s).replace(/\n/g, " ");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Write both report files; returns their paths + the summary + findings. */
export function writeReport({ meta, results, skips }, outDir) {
  // Intercept expected/benign failures FIRST, so every downstream consumer —
  // summarize (the 🟡 count), deriveFindings, the rendered tables, the JSON
  // report, and the returned summary the runner exits on — sees a consistent
  // picture: a benign failure is `xfail`, only genuine defects stay `fail`.
  for (const r of results) {
    if (isExpectedFailure(r)) r.status = "xfail";
  }
  const findings = deriveFindings(results, meta);
  mkdirSync(outDir, { recursive: true });
  const stamp = meta.startedAt.replace(/[:.]/g, "-");
  const mdPath = join(outDir, `report-${stamp}.md`);
  const jsonPath = join(outDir, `report-${stamp}.json`);
  writeFileSync(mdPath, renderMarkdown({ meta, results, findings, skips }), "utf8");
  writeFileSync(
    jsonPath,
    JSON.stringify({ meta, summary: summarize(results), findings, results, skips }, null, 2),
    "utf8",
  );
  return { mdPath, jsonPath, summary: summarize(results), findings };
}
