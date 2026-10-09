import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IPhone } from "./device.ts";
import { createPhoneMcpServer, type PhoneServerOptions } from "./mcp.ts";
import { startMockWda, type MockWda } from "./mock-wda.ts";
import { WdaClient } from "./wda.ts";

process.env.SETTLE_MS = "0";

let mock: MockWda;
before(async () => {
  mock = await startMockWda();
});
after(() => mock.close());

async function connect(opts: PhoneServerOptions = {}) {
  Object.assign(mock.state, { app: "home", wifi: true, draft: "", focused: false, notes: [] });
  const server = createPhoneMcpServer(new IPhone(new WdaClient(mock.url)), opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type Block = { type: string; text?: string; data?: string; mimeType?: string };

test("lists all seven tools with read-only annotations", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["screenshot", "describe_ui", "tap", "swipe", "type_text", "press_button", "launch_app"]);
  assert.equal(tools.find((t) => t.name === "screenshot")!.annotations?.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "tap")!.annotations?.readOnlyHint, false);
  assert.equal(tools.find((t) => t.name === "tap")!.annotations?.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === "tap")!.annotations?.openWorldHint, true);
  assert.deepEqual(tools.find((t) => t.name === "tap")!.inputSchema.required, ["x", "y"]);
  await client.close();
});

test("an MCP client can drive the phone: open Settings, flip Wi-Fi", async () => {
  const client = await connect();
  const ui = (await client.callTool({ name: "describe_ui", arguments: {} })).content as Block[];
  assert.match(ui[0]!.text!, /Icon "Settings" center=\(62,112\)/);

  const after = (await client.callTool({ name: "tap", arguments: { x: 62, y: 112 } })).content as Block[];
  assert.deepEqual(after.map((b) => b.type), ["text", "image"]);
  assert.equal(after[1]!.mimeType, "image/png");
  assert.equal(mock.state.app, "com.apple.Preferences");

  await client.callTool({ name: "tap", arguments: { x: 345, y: 145 } });
  assert.equal(mock.state.wifi, false);
  await client.close();
});

test("device errors come back as isError results, not protocol errors", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "type_text", arguments: { text: "x" } });
  assert.equal(res.isError, true);
  assert.match((res.content as Block[])[0]!.text!, /Keyboard is not present/);
  await client.close();
});

test("read-only mode hides and refuses action tools", async () => {
  const client = await connect({ readOnly: true });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["screenshot", "describe_ui"]);
  const res = await client.callTool({ name: "launch_app", arguments: { bundle_id: "com.apple.Preferences" } });
  assert.equal(res.isError, true);
  assert.equal(mock.state.app, "home");
  await client.close();
});

test("stdio entrypoint: `mcp.ts --mock` serves tools over stdin/stdout", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", new URL("./mcp.ts", import.meta.url).pathname, "--mock"],
    env: { ...process.env, SETTLE_MS: "0" } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "stdio-test", version: "0" });
  await client.connect(transport);
  const shot = (await client.callTool({ name: "screenshot", arguments: {} })).content as Block[];
  assert.equal(shot[0]!.text, "screen 390x844 points");
  await client.close();
});

test("approve gate refuses actions but lets reads through", async () => {
  const seen: string[] = [];
  const client = await connect({ approve: (tool) => (seen.push(tool), false) });
  const res = await client.callTool({ name: "launch_app", arguments: { bundle_id: "com.apple.Preferences" } });
  assert.equal(res.isError, true);
  assert.match((res.content as Block[])[0]!.text!, /denied/);
  assert.equal(mock.state.app, "home");
  const shot = await client.callTool({ name: "screenshot", arguments: {} });
  assert.notEqual(shot.isError, true);
  assert.deepEqual(seen, ["launch_app"]);
  await client.close();
});
