// Declarative case registry + helpers for the real-network E2E harness.
//
// Pure data / pure functions only — transport-agnostic. The MCP harness drives the
// SAME intent verbs (market / account_overview / account_config / order / position
// / strategy_order) and the SAME `raw({operationId, args})` escape hatch as the CLI
// and skill harnesses, so the case universe (read sweep, scenarios, write cycle,
// strategy, sub-account lifecycle, skip registry) is identical; `run.mjs` does the
// orchestration so the classification (what is safe to call) stays auditable here.

/** Tunables, overridable by env so the user can match their account/symbol. */
export const DEFAULTS = {
  symbol: process.env.E2E_SYMBOL || "BTCUSDT",
  // Default order size for futures (margin-based). SPOT uses its own smaller
  // size via sizeForMarket() to stay within a typical 10-20 USDT UTA balance.
  size: process.env.E2E_SIZE || "0.001",
  priceFactor: clampFactor(Number(process.env.E2E_PRICE_FACTOR || "0.5")),
  markets: (process.env.E2E_MARKETS || "SPOT,USDT-FUTURES")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  delayMs: Number.isFinite(Number(process.env.E2E_DELAY_MS))
    ? Number(process.env.E2E_DELAY_MS)
    : 80,
  allowWrites: process.env.E2E_ALLOW_WRITES === "1",
};

// Keep the probe order a strict, safe BUY-below-market (never >= 0.95 of last).
function clampFactor(f) {
  if (!Number.isFinite(f) || f <= 0) return 0.5;
  return Math.min(f, 0.9);
}

/**
 * Per-market order size overrides.
 *
 * SPOT is full-notional (no leverage): a 0.001 BTC order at 50%-of-market price
 * ties up ~33 USDT, which fails with a typical 10-20 USDT UTA balance. Futures
 * are margin-based and can use the default 0.001 without issue.
 *
 * 0.0002 BTC at BTC=66k (50%→33k) = 6.6 USDT notional — above Bitget's 5-USDT
 * min-notional, below a 10 USDT balance.
 */
const MARKET_SIZES = { SPOT: "0.0002" };

/** Return the safe order size for a given market category. */
export function sizeForMarket(market) {
  return MARKET_SIZES[market] || DEFAULTS.size;
}

/**
 * Per-operationId argument overrides for the real-network read sweep — for ops
 * whose generic required-param sample the live API rejects.
 */
export const ARG_OVERRIDES = {
  getMaxOpenAvailable: {
    category: "USDT-FUTURES",
    symbol: DEFAULTS.symbol,
    orderType: "limit",
    side: "buy",
    price: "1",
  },
  getPositionTier: { category: "USDT-FUTURES", symbol: DEFAULTS.symbol },
  getTransferableCoins: { fromType: "uta", toType: "spot" },
};

/**
 * Fill the required path + query params of a catalog op with safe sample values,
 * then apply ARG_OVERRIDES for ops whose generic sample the live API rejects.
 */
export function sampleArgs(op) {
  const args = {};
  const fill = (name, param) => {
    if (param && Array.isArray(param.enum) && param.enum.length) return param.enum[0];
    const l = name.toLowerCase();
    if (l.includes("category")) return "SPOT";
    if (l.includes("symbol")) return DEFAULTS.symbol;
    if (l.includes("coin")) return "USDT";
    if (l.includes("interval") || l.includes("granularity")) return "1H";
    if (l.includes("endtime")) return "1690604800000"; // 1690000000000 + 7 days
    if (l.includes("time")) return "1690000000000";
    if (l.includes("uid")) return "123456";
    return "1";
  };
  for (const name of op.pathParams) args[name] = fill(name);
  for (const p of op.queryParams) if (p.required) args[p.name] = fill(p.name, p);
  return { ...args, ...(ARG_OVERRIDES[op.operationId] || {}) };
}

/** All read operations — the full read sweep universe. */
export function readOps(catalog) {
  return catalog.filter((op) => !op.isWrite);
}

/** First usable orderId out of a normalized orders payload (history/open/fills). */
export function firstOrderId(data) {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.list)
      ? data.list
      : Array.isArray(data?.orders)
        ? data.orders
        : data
          ? [data]
          : [];
  for (const row of rows) {
    if (row && typeof row === "object" && row.orderId != null && String(row.orderId).length) {
      return String(row.orderId);
    }
  }
  return null;
}

/** First usable subUid out of a sub-account list payload (getSubAccountList → data.list). */
export function firstSubUid(data) {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.list)
      ? data.list
      : Array.isArray(data?.subList)
        ? data.subList
        : data
          ? [data]
          : [];
  for (const row of rows) {
    if (row && typeof row === "object" && row.subUid != null && String(row.subUid).length) {
      return String(row.subUid);
    }
  }
  return null;
}

/**
 * Reads that REQUIRE a real resource id the generic sampler cannot invent. We
 * first source a real id from a prior read, THEN GET — a read-then-read chain
 * that mirrors how an agent works (list → drill into one row).
 */
export const CHAINED_READS = {
  getOrderDetails: {
    sources: [
      { operationId: "getOrderHistory", args: { category: "SPOT" } },
      { operationId: "getOrderHistory", args: { category: "USDT-FUTURES" } },
    ],
    pick: firstOrderId,
    toArgs: (orderId) => ({ orderId }),
    emptyNote: "账户无历史订单可供链式取 orderId，已跳过(非 SDK 缺陷)",
  },
  getSubAccountApiKeys: {
    sources: [{ operationId: "getSubAccountList", args: {} }],
    pick: firstSubUid,
    toArgs: (subUid) => ({ subUid }),
    emptyNote: "账户无子账户可供链式取 subUid，已跳过(非 SDK 缺陷)",
  },
};

/* ────────────────────────────────────────────────────────────────────────
 * Typical-journey scenarios for the core domains (market / account / trade).
 *
 * The read sweep proves every endpoint *answers*; these scenarios prove the
 * answers are *usable* — they assert on the actual payload an agent consumes,
 * so a shape regression that still returns 200 OK is caught here.
 *
 *   auth: "public" runs always; "private" skips without credentials.
 * ──────────────────────────────────────────────────────────────────────── */

/** Distinct error type so an assertion failure reads clearly and never collides
 *  with a real API error message. */
export class ScenarioAssertError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScenarioAssertError";
  }
}

/** Raised by a scenario when a precondition is met by the environment, not the
 *  product — e.g. a composite section whose endpoint isn't hosted on the demo
 *  backend. The runner records these as a benign skip (🟡-equivalent), never a
 *  defect, so env limitations don't masquerade as wrong-shape payloads. */
export class ScenarioSkip extends Error {
  constructor(message) {
    super(message);
    this.name = "ScenarioSkip";
  }
}

function assert(cond, msg) {
  if (!cond) throw new ScenarioAssertError(msg);
}
function skipBenign(msg) {
  throw new ScenarioSkip(msg);
}

/** True when a composite section's error reads as a benign environment limit
 *  (endpoint not routed on demo, product not supported) rather than a product
 *  defect. Used to skip — never to pass — the section's payload assertions. */
const SECTION_UNAVAILABLE = /url not found|not\s*found|404|not support|unsupported|demo|不支持|未找到/i;
function sectionUnavailable(error) {
  return SECTION_UNAVAILABLE.test(String(error ?? ""));
}
const num = (v) => Number(v);
const isFiniteNum = (v) => Number.isFinite(Number(v));
const isPosNum = (v) => Number.isFinite(Number(v)) && Number(v) > 0;

/** Coerce a payload to row[] across the shapes Bitget returns. */
function asList(data, key) {
  if (Array.isArray(data)) return data;
  if (key && Array.isArray(data?.[key])) return data[key];
  if (Array.isArray(data?.list)) return data.list;
  return data && typeof data === "object" ? [data] : [];
}

/** First row whose `symbol` matches `want` (case-insensitive), or null. */
function rowForSymbol(data, want) {
  const W = String(want).toUpperCase();
  return (
    asList(data).find(
      (r) => r && typeof r === "object" && String(r.symbol).toUpperCase() === W,
    ) || null
  );
}

export const SCENARIOS = [
  // ── market (public — run even without credentials) ──────────────────────
  {
    id: "market-spot-ticker",
    domain: "market",
    auth: "public",
    title: "现货行情：BTCUSDT 有正的最新价",
    tool: "market",
    args: { action: "tickers", category: "SPOT", symbol: "BTCUSDT" },
    assert: (d) => {
      const row = rowForSymbol(d, "BTCUSDT");
      assert(row, "行情结果里找不到 BTCUSDT");
      assert(isPosNum(row.lastPrice), `现货最新价不是正数：${row.lastPrice}`);
    },
  },
  {
    id: "market-fut-ticker",
    domain: "market",
    auth: "public",
    title: "合约行情：USDT 永续 BTCUSDT 有正的最新价",
    tool: "market",
    args: { action: "tickers", category: "USDT-FUTURES", symbol: "BTCUSDT" },
    assert: (d) => {
      const row = rowForSymbol(d, "BTCUSDT");
      assert(row, "合约行情里找不到 BTCUSDT");
      assert(isPosNum(row.lastPrice), `合约最新价不是正数：${row.lastPrice}`);
    },
  },
  {
    id: "market-orderbook",
    domain: "market",
    auth: "public",
    title: "盘口：买一卖一齐全且卖一≥买一",
    tool: "market",
    args: { action: "orderbook", category: "SPOT", symbol: "BTCUSDT" },
    assert: (d) => {
      const asks = d?.a;
      const bids = d?.b;
      assert(Array.isArray(asks) && asks.length, "盘口缺少卖盘");
      assert(Array.isArray(bids) && bids.length, "盘口缺少买盘");
      const bestAsk = num(asks[0][0]);
      const bestBid = num(bids[0][0]);
      assert(isPosNum(bestAsk) && isPosNum(bestBid), "盘口价格不是正数");
      assert(bestAsk >= bestBid, `卖一(${bestAsk})竟低于买一(${bestBid})`);
    },
  },
  {
    id: "market-candles",
    domain: "market",
    auth: "public",
    title: "K线：1H 蜡烛 最高≥最低、收盘为正",
    tool: "market",
    args: { action: "candles", category: "SPOT", symbol: "BTCUSDT", interval: "1H", limit: 20 },
    assert: (d) => {
      assert(Array.isArray(d) && d.length, "K线返回为空");
      const row = d[0];
      assert(Array.isArray(row) && row.length >= 5, "K线每行应是数组");
      const high = num(row[2]);
      const low = num(row[3]);
      const close = num(row[4]);
      assert(isPosNum(close), `收盘价不是正数：${row[4]}`);
      assert(high >= low, `最高价(${high})竟低于最低价(${low})`);
    },
  },
  {
    id: "market-funding",
    domain: "market",
    auth: "public",
    title: "资金费率：BTCUSDT 费率是有效数字",
    tool: "market",
    args: { action: "fundingRate", category: "USDT-FUTURES", symbol: "BTCUSDT" },
    assert: (d) => {
      const row = rowForSymbol(d, "BTCUSDT") || asList(d)[0];
      assert(row, "资金费率返回为空");
      assert(isFiniteNum(row.fundingRate), `资金费率不是数字：${row.fundingRate}`);
    },
  },
  {
    id: "market-open-interest",
    domain: "market",
    auth: "public",
    title: "持仓量：BTCUSDT 未平仓合约为正",
    tool: "market",
    args: { action: "openInterest", category: "USDT-FUTURES", symbol: "BTCUSDT" },
    assert: (d) => {
      const rows = asList(d, "list");
      assert(rows.length, "持仓量列表为空");
      assert(isPosNum(rows[0].openInterest), `持仓量不是正数：${rows[0].openInterest}`);
    },
  },
  {
    id: "market-instruments",
    domain: "market",
    auth: "public",
    title: "交易对清单：数量充足且含 BTCUSDT",
    tool: "market",
    args: { action: "instruments", category: "SPOT" },
    assert: (d) => {
      const rows = asList(d);
      assert(rows.length > 100, `现货交易对数量异常少：${rows.length}`);
      assert(rowForSymbol(d, "BTCUSDT"), "交易对清单里缺少 BTCUSDT");
    },
  },
  {
    id: "market-recent-fills",
    domain: "market",
    auth: "public",
    title: "最近成交：有成交、价格为正、方向合法",
    tool: "market",
    args: { action: "recentFills", category: "SPOT", symbol: "BTCUSDT" },
    assert: (d) => {
      const rows = asList(d);
      assert(rows.length, "最近成交为空");
      const f = rows[0];
      assert(isPosNum(f.price), `成交价不是正数：${f.price}`);
      assert(["buy", "sell"].includes(String(f.side).toLowerCase()), `成交方向异常：${f.side}`);
    },
  },
  {
    id: "market-price-consistency",
    domain: "market",
    auth: "public",
    title: "价格自洽：最新价落在盘口买一~卖一之间",
    tool: "market",
    args: { action: "tickers", category: "SPOT", symbol: "BTCUSDT" },
    then: () => ({
      tool: "market",
      args: { action: "orderbook", category: "SPOT", symbol: "BTCUSDT" },
    }),
    assert: (tickerData, book) => {
      const last = num(rowForSymbol(tickerData, "BTCUSDT")?.lastPrice);
      assert(isPosNum(last), "行情最新价不是正数");
      assert(book?.a?.length && book?.b?.length, "盘口缺买卖盘，无法校验自洽");
      const bestAsk = num(book.a[0][0]);
      const bestBid = num(book.b[0][0]);
      assert(isPosNum(bestAsk) && isPosNum(bestBid), "盘口价格不是正数");
      assert(
        last >= bestBid * 0.99 && last <= bestAsk * 1.01,
        `最新价(${last})偏离盘口[${bestBid}, ${bestAsk}]过大`,
      );
    },
  },

  // ── account (private — skipped without credentials) ─────────────────────
  {
    id: "account-balance-and-mode",
    domain: "account",
    auth: "private",
    title: "账户总览：权益是数字、账户模式齐全",
    tool: "account_overview",
    args: {},
    assert: (d) => {
      assert(d?.assets?.ok === true, `资产分区失败：${d?.assets?.error || ""}`);
      const eq = d.assets.data?.accountEquity;
      assert(isFiniteNum(eq), `账户权益不是数字：${eq}`);
      assert(num(eq) >= 0, `账户权益为负：${eq}`);
      assert(d?.settings?.ok === true, `账户设置分区失败：${d?.settings?.error || ""}`);
      const s = d.settings.data;
      assert(s?.uid, "账户设置缺少 uid");
      assert(s?.accountMode, "账户设置缺少 accountMode");
      assert(s?.holdMode, "账户设置缺少 holdMode");
    },
  },
  {
    id: "account-fee-rate",
    domain: "account",
    auth: "private",
    title: "费率：BTCUSDT 合约 maker/taker 费率是数字",
    tool: "account_overview",
    args: { category: "USDT-FUTURES", symbol: "BTCUSDT" },
    assert: (d) => {
      const section = d?.feeRate;
      if (section?.ok !== true) {
        // The composite degrades each section independently. fee-rate isn't
        // routed on the demo backend (404 URL NOT FOUND) — a benign env limit,
        // not a payload defect — so skip rather than fail. Live suites, where
        // the endpoint is hosted, still assert the numbers below.
        if (sectionUnavailable(section?.error)) {
          skipBenign(`费率接口在当前环境不可用(良性)：${section?.error || ""}`);
        }
        assert(false, `费率分区失败：${section?.error || ""}`);
      }
      const fr = section.data;
      assert(isFiniteNum(fr?.makerFeeRate), `maker 费率不是数字：${fr?.makerFeeRate}`);
      assert(isFiniteNum(fr?.takerFeeRate), `taker 费率不是数字：${fr?.takerFeeRate}`);
    },
  },
  {
    id: "account-deduct-info",
    domain: "account",
    auth: "private",
    title: "手续费抵扣设置：deduct 开关有值",
    tool: "account_config",
    args: { action: "deductInfo" },
    assert: (d) => {
      assert(
        typeof d?.deduct === "string" && d.deduct.length,
        `deduct 字段异常：${JSON.stringify(d?.deduct)}`,
      );
    },
  },
  {
    id: "account-payment-coins",
    domain: "account",
    auth: "private",
    title: "可抵扣币种：列表非空且含 coin 字段",
    tool: "account_config",
    args: { action: "paymentCoins" },
    assert: (d) => {
      const rows = asList(d, "paymentCoinList");
      assert(rows.length, "可抵扣手续费币种列表为空");
      assert(rows[0]?.coin, "抵扣币种行缺少 coin 字段");
    },
  },

  // ── trade (private; dryRun place is a no-send preview, so public) ────────
  {
    id: "trade-open-orders",
    domain: "trade",
    auth: "private",
    title: "未成交委托：返回 list 数组（可为空）",
    tool: "order",
    args: { action: "open", category: "SPOT" },
    assert: (d) => {
      assert(Array.isArray(d?.list), `未成交委托应返回 list 数组，实际：${typeof d?.list}`);
    },
  },
  {
    id: "trade-order-history",
    domain: "trade",
    auth: "private",
    title: "历史订单：list 数组；有数据时含 orderId/symbol",
    tool: "order",
    args: { action: "history", category: "SPOT" },
    assert: (d) => {
      assert(Array.isArray(d?.list), "历史订单应返回 list 数组");
      if (d.list.length) {
        const o = d.list[0];
        assert(o.orderId, "历史订单缺少 orderId");
        assert(o.symbol, "历史订单缺少 symbol");
      }
    },
  },
  {
    id: "trade-fills",
    domain: "trade",
    auth: "private",
    title: "成交明细：调用成功并返回对象（可为空）",
    tool: "order",
    args: { action: "fills", category: "SPOT" },
    assert: (d) => {
      assert(d && typeof d === "object", "成交明细返回的不是对象");
      if (Array.isArray(d.list) && d.list.length) {
        assert(d.list[0] && typeof d.list[0] === "object", "成交明细行结构异常");
      }
    },
  },
  {
    id: "trade-positions",
    domain: "trade",
    auth: "private",
    title: "当前持仓：调用成功并返回对象（无仓位为空）",
    tool: "position",
    args: { action: "info", category: "USDT-FUTURES" },
    assert: (d) => {
      assert(d !== null && typeof d === "object", "持仓信息返回的不是对象");
      if (Array.isArray(d.list) && d.list.length) {
        assert(d.list[0]?.symbol, "持仓行缺少 symbol");
      }
    },
  },
  {
    id: "trade-max-open",
    domain: "trade",
    auth: "private",
    title: "最大可开：BTCUSDT 合约 maxBuyOpen 是非负数字",
    tool: "order",
    args: {
      action: "maxOpen",
      category: "USDT-FUTURES",
      symbol: "BTCUSDT",
      orderType: "limit",
      side: "buy",
      price: "33000",
    },
    assert: (d) => {
      assert(isFiniteNum(d?.maxBuyOpen), `maxBuyOpen 不是数字：${d?.maxBuyOpen}`);
      assert(num(d.maxBuyOpen) >= 0, `maxBuyOpen 为负：${d.maxBuyOpen}`);
    },
  },
  {
    id: "trade-dryrun-place",
    domain: "trade",
    auth: "public",
    needsWrites: false,
    title: "下单预览(dryRun)：生成正确委托但绝不发送",
    tool: "market",
    args: { action: "tickers", category: "SPOT", symbol: "BTCUSDT" },
    then: (tickerData) => {
      const last = extractLastPrice(tickerData);
      if (!last) return null;
      return {
        tool: "order",
        args: {
          action: "place",
          category: "SPOT",
          symbol: "BTCUSDT",
          side: "buy",
          orderType: "limit",
          price: farBuyPrice(last),
          qty: "0.0002",
          dryRun: true,
        },
      };
    },
    assert: (_tickerData, preview) => {
      assert(preview?.dryRun === true, "dryRun 未生效（可能真的发单了！）");
      assert(preview?.wouldSend && typeof preview.wouldSend === "object", "缺少 wouldSend 预览");
      assert(preview.wouldSend.clientOid, "wouldSend 缺少 clientOid");
      assert(isPosNum(preview.wouldSend.price), `预览委托价不是正数：${preview.wouldSend.price}`);
    },
  },
];

/** Generate a unique sub-account label for idempotent lifecycle tests.
 *  Per createSubAccount docs: "only lowercase letters, ≤20 chars". */
export function uniqueSubAccountName() {
  let n = Date.now();
  let suffix = "";
  while (n > 0) {
    suffix = String.fromCharCode(97 + (n % 26)) + suffix;
    n = Math.floor(n / 26);
  }
  return `tst${suffix}`;
}

/** Write operationIds the harness actually puts on the wire. */
export const EXERCISED_WRITE_OPS = new Set([
  "placeOrder",
  "cancelOrder",
  "placeStrategyOrder",
  "cancelStrategyOrder",
]);

/** Heuristic tag for the skip report (these are never executed regardless). */
const FUND_MOVING = /withdraw|transfer|redeem|borrow|repay|loan|sub-?account|deposit/i;

/**
 * Every write op the harness deliberately does NOT execute, with a reason —
 * makes test coverage and the safety boundary transparent in the report.
 */
export function skipRegistry(catalog, highRiskSet, exercisedWriteOps = EXERCISED_WRITE_OPS) {
  const exercised = exercisedWriteOps instanceof Set ? exercisedWriteOps : new Set(exercisedWriteOps);
  return catalog
    .filter((op) => op.isWrite && !exercised.has(op.operationId))
    .map((op) => ({
      operationId: op.operationId,
      endpoint: `${op.method} ${op.path}`,
      reason: highRiskSet.has(op.operationId)
        ? "high-risk: destructive/irreversible — never executed on real keys"
        : FUND_MOVING.test(op.operationId)
          ? "fund-moving — never executed"
          : "write not exercised by v1 (reads + order place/cancel only)",
    }));
}

/**
 * Pull a usable last price out of a (normalized) tickers payload; returns null if
 * it can't find a positive number — in which case the caller SKIPS placing.
 */
export function extractLastPrice(data) {
  const PRICE_KEYS = ["lastPrice", "lastPr", "last", "close", "markPrice", "indexPrice", "price"];
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.list)
      ? data.list
      : Array.isArray(data?.tickers)
        ? data.tickers
        : data
          ? [data]
          : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const key of PRICE_KEYS) {
      const n = Number(row[key]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/** A clean integer limit price well below market — a BUY here cannot fill. */
export function farBuyPrice(last, factor = DEFAULTS.priceFactor) {
  return String(Math.max(1, Math.floor(last * factor)));
}

/**
 * Build a SAFE strategy-order body for the create→read→cancel cycle.
 *
 * Uses ONLY `type:"tpsl"`, NEVER `trigger`: a tpsl order attaches TP/SL to an
 * EXISTING position and carries no side/triggerPrice, so it CANNOT open a position
 * — zero market exposure by construction. Triggers sit far from market (TP ≈ 3×
 * last, SL ≈ 0.3× last) and the harness cancels immediately.
 */
export function safeStrategyArgs(last, { symbol = DEFAULTS.symbol } = {}) {
  return {
    category: "USDT-FUTURES",
    symbol,
    type: "tpsl",
    tpslMode: "full",
    posSide: "long",
    takeProfit: String(Math.max(1, Math.floor(last * 3))),
    stopLoss: String(Math.max(1, Math.floor(last * 0.3))),
    tpTriggerBy: "mark",
    slTriggerBy: "mark",
    tpOrderType: "market",
    slOrderType: "market",
  };
}
