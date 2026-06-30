import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  SetLevelRequestSchema,
  type CallToolResult,
  type LoggingLevel,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  BitgetRestClient,
  buildTools,
  toMcpTool as toMcpDescriptor,
  safeInvoke,
  toToolErrorPayload,
  ValidationError,
} from "@bitget-ai/bitget-agent-sdk";
import type {
  BitgetConfig,
  ClientHooks,
  RiskLevel,
  ToolSpec,
} from "@bitget-ai/bitget-agent-sdk";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./meta.js";

/**
 * MCP tool annotations are derived from the SDK's declarative `riskLevel`, NOT
 * from `isWrite`: a composite verb such as `order` carries `isWrite: false`
 * (its per-action safety gate decides) yet `riskLevel: "write"`, so keying off
 * `isWrite` would wrongly advertise it as read-only.
 */
function annotationsFor(riskLevel: RiskLevel): Tool["annotations"] {
  switch (riskLevel) {
    case "read":
      return {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      };
    case "write":
      return {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      };
    case "high":
      return {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      };
  }
}

function toMcpTool(spec: ToolSpec): Tool {
  const descriptor = toMcpDescriptor(spec);
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema as Tool["inputSchema"],
    annotations: annotationsFor(spec.riskLevel),
  };
}

/**
 * Teach the host/agent the discover → drill-down → execute workflow and the
 * live session posture. This is where the capability snapshot lives now (there
 * is no dedicated capabilities tool): a one-time, zero-cost briefing carried in
 * the MCP `initialize` response.
 */
function buildInstructions(config: BitgetConfig): string {
  const posture = [
    `surface=${config.surface}`,
    `modules=${config.modules.join(",")}`,
    `readOnly=${config.readOnly}`,
    `paperTrading=${config.paperTrading}`,
    `authenticated=${config.hasAuth}`,
  ].join(", ");

  return [
    "Bitget Unified Trading Account (UTA / v3) MCP server. The tool surface is small and",
    "progressively discoverable — do not expect one tool per endpoint. Preferred workflow:",
    "",
    "  1. discover({})              list business domains (account, trade, market, …) + meta tools.",
    "  2. discover({ domain })      list one domain's verbs with one-line descriptions.",
    "  3. discover({ tool })        one verb's full input schema; action-routed verbs list their actions.",
    "  4. discover({ tool, action }) one action's exact required/optional contract.",
    "  then call the verb (e.g. order, position, market, account_overview).",
    "",
    "If the prompt already gives you the verb and arguments, skip discovery and call directly.",
    "For long-tail or newly-added endpoints use raw({ operationId, args }).",
    "discover({ search }) keyword-searches the whole surface when you don't know the domain.",
    "",
    "Write safety: ordinary writes execute immediately. High-risk/irreversible operations",
    "(e.g. cancel-all, withdraw) return { confirmationRequired: true } unless you pass confirm: true.",
    "Pass dryRun: true on any write to preview the request without sending it.",
    "",
    `Session posture: ${posture}.`,
    "Without API credentials only public/read operations succeed.",
  ].join("\n");
}

/**
 * On success, the SDK's SafeResult envelope is structured data the host can read
 * programmatically (`structuredContent`) and the model can read as text. On
 * error we keep only the text channel: `structuredContent` is reserved for
 * successful, schema-shaped output, so attaching the error envelope there would
 * misrepresent it as a normal result. The text channel still carries the full
 * error payload, so nothing is lost.
 *
 * The text is compact JSON (not pretty-printed): every byte is a token the model
 * pays for, and the structured channel already serves machine consumers.
 */
function toCallToolResult(payload: unknown, isError: boolean): CallToolResult {
  const structured = payload as Record<string, unknown>;
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    ...(isError ? { isError: true } : { structuredContent: structured }),
  };
}

/** RFC 5424 severity ordering — lower rank is less severe (filtered out first). */
const LEVEL_RANK: Record<LoggingLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
};

/**
 * Forward the SDK client's lifecycle hooks to the host as MCP log notifications,
 * gated by the level the host requested via `logging/setLevel` (default `info`,
 * so routine request/response debug chatter is suppressed until asked for).
 * Sends are best-effort: a not-yet-connected transport must never surface as a
 * request failure.
 */
function buildLoggingHooks(server: Server, minLevel: () => LoggingLevel): ClientHooks {
  const send = (level: LoggingLevel, data: Record<string, unknown>): void => {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel()]) return;
    void server
      .sendLoggingMessage({ level, logger: MCP_SERVER_NAME, data })
      .catch(() => {});
  };
  return {
    onRequest: (e) => send("debug", { event: "request", ...e }),
    onResponse: (e) =>
      send(e.status >= 400 ? "warning" : "debug", { event: "response", ...e }),
    onRetry: (e) => send("warning", { event: "retry", ...e }),
    onError: (e) =>
      send("error", {
        event: "error",
        method: e.method,
        endpoint: e.endpoint,
        attempt: e.attempt,
        error: e.error instanceof Error ? e.error.message : String(e.error),
      }),
  };
}

interface PromptDef {
  name: string;
  description: string;
  arguments?: { name: string; description: string; required: boolean }[];
  build: (args: Record<string, string>) => string;
}

/**
 * Curated, read-only workflow starters. Each expands to a single user-message
 * template that steers the agent through the intent verbs (and never toward an
 * unconfirmed write), reinforcing the discover → verb pattern for the host's
 * most common asks.
 */
const PROMPTS: PromptDef[] = [
  {
    name: "account_snapshot",
    description:
      "Read-only summary of the connected account: balances, open positions, and working orders.",
    build: () =>
      [
        "Give me a concise snapshot of my Bitget Unified Trading Account.",
        'Call account_overview({}) for balances, position({ action: "info" }) for open positions,',
        'and order({ action: "open" }) for working orders.',
        "Summarize equity, exposure, and anything that needs attention.",
        "Do not place, modify, or cancel anything.",
      ].join(" "),
  },
  {
    name: "pre_trade_check",
    description: "Pre-trade safety review for a symbol before you place an order.",
    arguments: [
      { name: "symbol", description: "Trading symbol, e.g. BTCUSDT", required: true },
      {
        name: "category",
        description: "Product category (SPOT, USDT-FUTURES, …); optional",
        required: false,
      },
    ],
    build: (args) => {
      const symbol = args["symbol"] ?? "<symbol>";
      const category = args["category"] ? ` in category ${args["category"]}` : "";
      return [
        `Before I trade ${symbol}${category}, do a safety review.`,
        `Check the current price via market({ action: "tickers", symbol: "${symbol}" }),`,
        'my existing exposure via position({ action: "info" }),',
        "and my available balance via account_overview({}).",
        "Flag liquidation risk, insufficient margin, or an oversized order.",
        "Recommend a size, but do not place the order until I confirm.",
      ].join(" ");
    },
  },
];

export function createServer(config: BitgetConfig): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {}, logging: {}, prompts: {} },
      instructions: buildInstructions(config),
    },
  );

  // Host-selected minimum log level (logging/setLevel). Default `info` keeps the
  // channel quiet (warnings + errors) until a host opts into debug detail.
  let logLevel: LoggingLevel = "info";
  server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    logLevel = request.params.level;
    return {};
  });

  // Wire the client's observability hooks to the log channel, preserving any
  // hooks the caller already configured.
  const callerHooks = config.hooks;
  const loggingHooks = buildLoggingHooks(server, () => logLevel);
  const hooks: ClientHooks = {
    onRequest: (e) => {
      callerHooks?.onRequest?.(e);
      loggingHooks.onRequest?.(e);
    },
    onResponse: (e) => {
      callerHooks?.onResponse?.(e);
      loggingHooks.onResponse?.(e);
    },
    onRetry: (e) => {
      callerHooks?.onRetry?.(e);
      loggingHooks.onRetry?.(e);
    },
    onError: (e) => {
      callerHooks?.onError?.(e);
      loggingHooks.onError?.(e);
    },
  };

  const client = new BitgetRestClient({ ...config, hooks });
  // The surface is static for the session (no runtime capability probing), so
  // build it once and route tools/call back through the kept specs by name.
  const tools = buildTools(config);
  const toolMap = new Map<string, ToolSpec>(tools.map((tool) => [tool.name, tool]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(toMcpTool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const spec = toolMap.get(toolName);

    if (!spec) {
      const payload = toToolErrorPayload(
        new ValidationError(
          `Tool "${toolName}" is not available in this server session.`,
          "Call discover({}) to list the currently available tools.",
        ),
      );
      return toCallToolResult(payload, true);
    }

    const result = await safeInvoke(spec, request.params.arguments ?? {}, {
      config,
      client,
    });
    return toCallToolResult(result, !result.ok);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      ...(prompt.arguments ? { arguments: prompt.arguments } : {}),
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = PROMPTS.find((p) => p.name === request.params.name);
    if (!prompt) {
      throw new ValidationError(
        `Prompt "${request.params.name}" is not available.`,
        `Available prompts: ${PROMPTS.map((p) => p.name).join(", ")}.`,
      );
    }
    const text = prompt.build(request.params.arguments ?? {});
    return {
      description: prompt.description,
      messages: [{ role: "user", content: { type: "text", text } }],
    };
  });

  return server;
}
