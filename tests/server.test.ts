import { test, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockServer } from "@bitget-ai/bitget-agent-sdk/testing";
import { loadConfig } from "@bitget-ai/bitget-agent-sdk";
import { createServer } from "../src/server.js";

let mockServer: MockServer;
let mcpClient: Client;

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ text: string }>;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

beforeAll(async () => {
  mockServer = new MockServer();
  await mockServer.start();
  process.env["BITGET_API_BASE_URL"] = mockServer.baseUrl;
  process.env["BITGET_API_KEY"] = "test-key";
  process.env["BITGET_SECRET_KEY"] = "test-secret";
  process.env["BITGET_PASSPHRASE"] = "test-passphrase";

  const config = loadConfig({ modules: "market,account,trade", readOnly: false });
  const server = createServer(config);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  mcpClient = new Client({ name: "test-client", version: "1.0" }, { capabilities: {} });
  await mcpClient.connect(clientTransport);
});

beforeEach(() => mockServer.reset());

afterAll(async () => {
  await mcpClient.close();
  await mockServer.stop();
});

test("server advertises its own MCP identity, not the SDK's", async () => {
  const version = mcpClient.getServerVersion();
  expect(version?.name).toBe("bitget-agent-mcp");
  // The SDK foundation identifies itself differently; the wire name must not leak it.
  expect(version?.name).not.toBe("bitget-agent-sdk");
});

test("server declares logging + prompts capabilities alongside tools", async () => {
  const caps = mcpClient.getServerCapabilities();
  expect(caps?.tools).toBeDefined();
  expect(caps?.logging).toBeDefined();
  expect(caps?.prompts).toBeDefined();
});

test("intent surface exposes curated verbs + meta tools, not 1:1 endpoints", async () => {
  const result = await mcpClient.listTools();
  const names = result.tools.map((t) => t.name);
  expect(names).toContain("market");
  expect(names).toContain("order");
  expect(names).toContain("account_overview");
  expect(names).toContain("raw");
  expect(names).toContain("discover");
  // Legacy v2 / hand-rolled tools must be gone under the v3 surface.
  expect(names).not.toContain("spot_get_ticker");
  expect(names).not.toContain("system_get_capabilities");
  // intent surface omits the 1:1 generated tier.
  expect(names).not.toContain("getTickers");
});

test("annotations derive from riskLevel: order is write, market is read", async () => {
  const result = await mcpClient.listTools();
  const order = result.tools.find((t) => t.name === "order");
  const market = result.tools.find((t) => t.name === "market");
  expect(order?.annotations?.readOnlyHint).toBe(false);
  expect(market?.annotations?.readOnlyHint).toBe(true);
});

test("call market action=tickers returns ok:true", async () => {
  const result = await mcpClient.callTool({
    name: "market",
    arguments: { action: "tickers", category: "SPOT", symbol: "BTCUSDT" },
  });
  expect(result.isError).toBeFalsy();
  const parsed = textOf(result);
  expect(parsed["ok"]).toBe(true);
  expect(parsed["data"]).toBeDefined();
});

test("discover({}) returns domain overview", async () => {
  const result = await mcpClient.callTool({ name: "discover", arguments: {} });
  expect(result.isError).toBeFalsy();
  const parsed = textOf(result);
  const data = parsed["data"] as Record<string, unknown>;
  expect(data["domains"]).toBeDefined();
  expect(Array.isArray(data["domains"])).toBe(true);
});

test("discover({tool:'order'}) returns input schema and actions", async () => {
  const result = await mcpClient.callTool({ name: "discover", arguments: { tool: "order" } });
  expect(result.isError).toBeFalsy();
  const parsed = textOf(result);
  const data = parsed["data"] as Record<string, unknown>;
  expect(data["inputSchema"]).toBeDefined();
  expect(data["actions"]).toContain("place");
});

test("discover({tool:'order', action:'place'}) returns the exact action contract", async () => {
  const result = await mcpClient.callTool({
    name: "discover",
    arguments: { tool: "order", action: "place" },
  });
  expect(result.isError).toBeFalsy();
  const data = textOf(result)["data"] as Record<string, unknown>;
  expect(data["action"]).toBe("place");
  expect(data["operationId"]).toBeDefined();
  expect(Array.isArray(data["required"])).toBe(true);
  expect(Array.isArray(data["optional"])).toBe(true);
  expect(typeof data["requiresConfirm"]).toBe("boolean");
});

test("raw escape hatch invokes a catalog op by operationId", async () => {
  const result = await mcpClient.callTool({
    name: "raw",
    arguments: { operationId: "getTickers", args: { category: "SPOT" } },
  });
  expect(result.isError).toBeFalsy();
  const parsed = textOf(result);
  expect(parsed["ok"]).toBe(true);
  expect(parsed["data"]).toBeDefined();
});

test("raw routes through the same safety gate: high-risk needs confirm", async () => {
  // cancelAllOrders is graded high-risk by the SDK; reaching it via raw must
  // still hit the confirm gate, not slip past it.
  const gated = await mcpClient.callTool({
    name: "raw",
    arguments: { operationId: "cancelAllOrders" },
  });
  expect(gated.isError).toBeFalsy();
  const gatedData = (textOf(gated)["data"] as Record<string, unknown>) ?? {};
  expect(gatedData["confirmationRequired"]).toBe(true);
});

test("prompts: list returns curated workflows; get renders a user message", async () => {
  const listed = await mcpClient.listPrompts();
  const names = listed.prompts.map((p) => p.name);
  expect(names).toContain("account_snapshot");
  expect(names).toContain("pre_trade_check");

  const got = await mcpClient.getPrompt({
    name: "pre_trade_check",
    arguments: { symbol: "BTCUSDT" },
  });
  expect(got.messages.length).toBeGreaterThan(0);
  const first = got.messages[0];
  expect(first?.role).toBe("user");
  const content = first?.content as { type: string; text: string };
  expect(content.type).toBe("text");
  expect(content.text).toContain("BTCUSDT");
});

test("high-risk write gate: confirm required, dryRun previews, confirm executes", async () => {
  // cancelAll is graded high-risk by the SDK; the gate is a non-error ok:true.
  const gated = await mcpClient.callTool({ name: "order", arguments: { action: "cancelAll" } });
  expect(gated.isError).toBeFalsy();
  const gatedData = (textOf(gated)["data"] as Record<string, unknown>) ?? {};
  expect(gatedData["confirmationRequired"]).toBe(true);

  const preview = await mcpClient.callTool({
    name: "order",
    arguments: { action: "cancelAll", dryRun: true },
  });
  expect(preview.isError).toBeFalsy();
  const previewData = (textOf(preview)["data"] as Record<string, unknown>) ?? {};
  expect(previewData["dryRun"]).toBe(true);
  expect(previewData["wouldSend"]).toBeDefined();

  const executed = await mcpClient.callTool({
    name: "order",
    arguments: { action: "cancelAll", confirm: true },
  });
  expect(executed.isError).toBeFalsy();
  const executedData = (textOf(executed)["data"] as Record<string, unknown>) ?? {};
  expect(executedData["confirmationRequired"]).toBeUndefined();
});

test("call unknown tool returns isError:true with ok:false", async () => {
  const result = await mcpClient.callTool({ name: "nonexistent_tool", arguments: {} });
  expect(result.isError).toBe(true);
  const parsed = textOf(result);
  expect(parsed["ok"]).toBe(false);
});

test("upstream error envelope surfaces as isError:true", async () => {
  mockServer.setErrorOverride("GET", "/api/v3/market/tickers", "40001", "Rate limit exceeded");
  const result = await mcpClient.callTool({
    name: "market",
    arguments: { action: "tickers", category: "SPOT" },
  });
  expect(result.isError).toBe(true);
  const parsed = textOf(result);
  expect(parsed["ok"]).toBe(false);
});

test("paperTrading=true sends paptrading:1 header on signed (private) requests", async () => {
  // paptrading is injected only on private/signed requests — public market
  // endpoints 404 under it — so exercise a private verb here.
  const config = loadConfig({ modules: "account", readOnly: false, paperTrading: true });
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "pt-test-client", version: "1.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const fetchSpy = vi.spyOn(globalThis, "fetch");

  await client.callTool({ name: "account_overview", arguments: {} });

  const init = fetchSpy.mock.calls[0]?.[1];
  const sentHeaders = new Headers(init?.headers as Record<string, string>);
  expect(sentHeaders.get("paptrading")).toBe("1");

  vi.restoreAllMocks();
  await client.close();
});

test("surface=full also exposes the 1:1 generated tier", async () => {
  const config = loadConfig({ modules: "market", surface: "full", readOnly: false });
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "full-test-client", version: "1.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const result = await client.listTools();
  const names = result.tools.map((t) => t.name);
  expect(names).toContain("getTickers");
  expect(names).toContain("market");

  await client.close();
});
