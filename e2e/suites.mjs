// E2E suite definitions — single source of truth for multi-suite switching.
//
// Three suites, selectable via E2E_SUITE=paper|agent-sub|main (env), with
// backward-compatible fallback: E2E_LIVE=1 → "agent-sub", else → "paper".
//
// Each suite declares:
//  - label / description    → report title + subtitle
//  - paperTrading           → forwarded to the server as the --paper-trading flag
//  - allowWrites            → conceptually supports writes (actual gating combines
//                             with hasKeys + E2E_ALLOW_WRITES=1)
//  - maxNotional            → LIVE notional cap in USDT
//  - phases                 → which orchestration phases to run
//  - exercisedWriteOps      → write ops the harness actually puts on the wire
//                             (so the skip registry doesn't false-list them)
//
// `protocol` (Phase 0 — MCP wire conformance) runs on EVERY suite: it is fully
// deterministic (initialize / tools/list / discover / prompts / logging / unknown
// tool / surface=full — public reads at most), and it is the one phase unique to
// an MCP server. It verifies the shipped server's wire contract before any
// business call, so a regression that misleads every connecting host fails first.

const BASE_EXERCISED_WRITES = [
  "placeOrder",
  "cancelOrder",
  "placeStrategyOrder",
  "cancelStrategyOrder",
];

const SUITES = {
  paper: {
    label: "模拟盘（纸面交易）",
    description: "纯 paper/demo trading，虚拟资金，无真实写操作",
    paperTrading: true,
    allowWrites: false,
    maxNotional: Infinity,
    phases: {
      protocol: true,
      connectivity: true,
      read: true,
      scenario: true,
      write: false,
      strategy: false,
      safety: true,
      subAccountLifecycle: false,
    },
    exercisedWriteOps: [],
  },

  "agent-sub": {
    label: "实盘（agent 子账户）",
    description: "真实资金，使用 agent sub-account key — place→cancel 回环 + 策略单",
    paperTrading: false,
    allowWrites: true,
    maxNotional: 60,
    phases: {
      protocol: true,
      connectivity: true,
      read: true,
      scenario: true,
      write: true,
      strategy: true,
      safety: true,
      subAccountLifecycle: false,
    },
    exercisedWriteOps: BASE_EXERCISED_WRITES,
  },

  main: {
    label: "实盘（主账户）",
    description:
      "真实资金，使用主账户 key — place→cancel 回环 + 策略单 + agent 子账户生命周期（创建→验证列表→验证 key→清理 API key）",
    paperTrading: false,
    allowWrites: true,
    maxNotional: 60,
    phases: {
      protocol: true,
      connectivity: true,
      read: true,
      scenario: true,
      write: true,
      strategy: true,
      safety: true,
      subAccountLifecycle: true,
    },
    exercisedWriteOps: [
      ...BASE_EXERCISED_WRITES,
      "createAgentSubAccount",
      "deleteSubAccountApiKey",
    ],
  },
};

/**
 * Resolve the active suite from env, with backward-compatible fallback.
 *
 * Priority:
 *  1. E2E_SUITE=paper|agent-sub|main  (explicit)
 *  2. E2E_LIVE=1                      → "agent-sub"
 *  3. default                          → "paper"
 */
function resolveSuite() {
  const explicit = process.env.E2E_SUITE;
  if (explicit) {
    const key = explicit.toLowerCase();
    if (!SUITES[key]) {
      console.warn(
        `[e2e] 未知 suite "${explicit}"，已知: ${Object.keys(SUITES).join(", ")}。回退到 "paper"。`,
      );
      return { key: "paper", ...SUITES.paper };
    }
    return { key, ...SUITES[key] };
  }
  if (process.env.E2E_LIVE === "1") {
    return { key: "agent-sub", ...SUITES["agent-sub"] };
  }
  return { key: "paper", ...SUITES.paper };
}

export { SUITES, resolveSuite };
