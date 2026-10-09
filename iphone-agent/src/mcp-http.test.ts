import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { connect as tcpConnect } from "node:net";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { IPhone } from "./device.ts";
import { parseHttpArgs, startPhoneHttpServer, type PhoneHttpOptions, type PhoneHttpServer } from "./mcp-http.ts";
import { startMockWda, type MockWda } from "./mock-wda.ts";
import { WdaClient } from "./wda.ts";

process.env.SETTLE_MS = "0";

const TOKEN = "a".repeat(64);
type Block = { type: string; text?: string; mimeType?: string };

let mock: MockWda;
const open: PhoneHttpServer[] = [];
before(async () => {
  mock = await startMockWda();
});
after(async () => {
  await Promise.all(open.map((s) => s.close()));
  await mock.close();
});

async function serve(opts: Partial<PhoneHttpOptions> = {}): Promise<PhoneHttpServer> {
  Object.assign(mock.state, { app: "home", wifi: true, draft: "", focused: false, notes: [] });
  const server = await startPhoneHttpServer(new IPhone(new WdaClient(mock.url)), { port: 0, ...opts });
  open.push(server);
  return server;
}

/** The URL the server reports, reached via loopback (a 0.0.0.0 bind reports 127.0.0.1). */
async function connect(url: string, token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(token !== undefined ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}),
  });
  const client = new Client({ name: "http-test", version: "0" });
  // @ts-expect-error SDK 1.32 typings: `sessionId` is a `string | undefined` getter, which `Transport`'s optional prop rejects under exactOptionalPropertyTypes.
  await client.connect(transport);
  return client;
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
});

function post(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: initialize,
  });
}

test("http: SDK client lists tools and takes a screenshot over Streamable HTTP", async () => {
  const server = await serve();
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(server.readOnly, false);
  const client = await connect(server.url);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["screenshot", "describe_ui", "tap", "swipe", "type_text", "press_button", "launch_app"]);
  const shot = (await client.callTool({ name: "screenshot", arguments: {} })).content as Block[];
  assert.equal(shot[0]!.text, "screen 390x844 points");
  assert.equal(shot[1]!.mimeType, "image/png");
  await client.callTool({ name: "launch_app", arguments: { bundle_id: "com.apple.Preferences" } });
  assert.equal(mock.state.app, "com.apple.Preferences");
  await client.close();
});

test("http: requests with no or a wrong bearer token get 401", async () => {
  const server = await serve({ token: TOKEN });
  const none = await post(server.url);
  assert.equal(none.status, 401);
  assert.match(none.headers.get("www-authenticate") ?? "", /^Bearer/);
  assert.equal((await post(server.url, { authorization: `Bearer ${"b".repeat(64)}` })).status, 401);
  assert.equal((await post(server.url, { authorization: `Bearer ${TOKEN.slice(1)}` })).status, 401);
  assert.equal((await post(server.url, { authorization: TOKEN })).status, 401);
  await assert.rejects(connect(server.url, "wrong-token"));

  const client = await connect(server.url, TOKEN);
  assert.equal((await client.listTools()).tools.length, 7);
  await client.close();
});

test("http: rejects a foreign Host or Origin (DNS rebinding), accepts loopback ones", async () => {
  const server = await serve();
  const { port } = new URL(server.url);
  // fetch won't let us forge Host, so speak HTTP by hand.
  const raw = (headers: string) =>
    new Promise<string>((resolve, reject) => {
      const sock = tcpConnect(Number(port), "127.0.0.1", () => {
        sock.end(
          `POST /mcp HTTP/1.1\r\n${headers}content-type: application/json\r\naccept: application/json, text/event-stream\r\n` +
            `content-length: ${Buffer.byteLength(initialize)}\r\nconnection: close\r\n\r\n${initialize}`,
        );
      });
      let out = "";
      sock.on("data", (d) => (out += d.toString()));
      sock.on("end", () => resolve(out));
      sock.on("error", reject);
    });
  assert.match(await raw("host: evil.example:80\r\n"), /^HTTP\/1\.1 403/);
  assert.match(await raw(`host: localhost:${port}\r\norigin: http://evil.example\r\n`), /^HTTP\/1\.1 403/);
  assert.match(await raw(`host: localhost:${port}\r\norigin: null\r\n`), /^HTTP\/1\.1 403/);
  assert.match(await raw(`host: localhost:${port}\r\norigin: http://localhost:6274\r\n`), /^HTTP\/1\.1 200/);
  assert.match(await raw(`host: 127.0.0.1:${port}\r\n`), /^HTTP\/1\.1 200/);
});

test("http: only POST /mcp is served", async () => {
  const server = await serve();
  assert.equal((await fetch(server.url.replace("/mcp", "/"), { method: "POST" })).status, 404);
  assert.equal((await fetch(server.url)).status, 405);
});

test("http: a non-loopback bind refuses to start without a token", async () => {
  await assert.rejects(serve({ host: "0.0.0.0" }), /refusing to bind 0\.0\.0\.0 without a bearer token/);
  await assert.rejects(serve({ host: "0.0.0.0", token: "short" }), /at least 32 characters/);
});

test("http: a non-loopback bind is read-only unless allowActions, and still needs the token", async () => {
  const ro = await serve({ host: "0.0.0.0", token: TOKEN });
  assert.equal(ro.readOnly, true);
  assert.equal((await post(ro.url)).status, 401);
  const client = await connect(ro.url, TOKEN);
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["screenshot", "describe_ui"]);
  const res = await client.callTool({ name: "launch_app", arguments: { bundle_id: "com.apple.Preferences" } });
  assert.equal(res.isError, true);
  assert.equal(mock.state.app, "home");
  await client.close();

  const rw = await serve({ host: "0.0.0.0", token: TOKEN, allowActions: true });
  assert.equal(rw.readOnly, false);
  const full = await connect(rw.url, TOKEN);
  assert.equal((await full.listTools()).tools.length, 7);
  await full.close();
});

test("http: IPHONE_MCP_READ_ONLY wins over allowActions", async () => {
  const server = await serve({ host: "0.0.0.0", token: TOKEN, allowActions: true, readOnly: true });
  assert.equal(server.readOnly, true);
});

test("parseHttpArgs: optional port, flags, and strictness", () => {
  assert.deepEqual(parseHttpArgs(["--http"], undefined), { port: 8765 });
  assert.deepEqual(parseHttpArgs(["--mock", "--http", "9000"], ""), { port: 9000 });
  assert.deepEqual(
    parseHttpArgs(["--http", "--host", "100.64.0.1", "--allow-actions", "--allowed-host", "mac.tail.ts.net"], TOKEN),
    { port: 8765, host: "100.64.0.1", token: TOKEN, allowActions: true, allowedHosts: ["mac.tail.ts.net"] },
  );
  assert.throws(() => parseHttpArgs(["--http", "--hots", "0.0.0.0"], TOKEN));
  assert.throws(() => parseHttpArgs(["--http", "--host"], TOKEN));
  assert.throws(() => parseHttpArgs(["--http", "70000"], TOKEN), /invalid port/);
});

test("http entrypoint: `mcp.ts --http --host 0.0.0.0` without a token exits non-zero", async () => {
  const { IPHONE_MCP_TOKEN: _, ...env } = process.env;
  const run = promisify(execFile)(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", new URL("./mcp.ts", import.meta.url).pathname, "--mock", "--http", "0", "--host", "0.0.0.0"],
    { env, timeout: 10_000 },
  );
  await assert.rejects(run, (err: { code?: number; stderr?: string }) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr ?? "", /refusing to bind 0\.0\.0\.0 without a bearer token/);
    return true;
  });
});
