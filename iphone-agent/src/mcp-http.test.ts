import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { connect as tcpConnect } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { IPhone, type Device } from "./device.ts";
import { parseHttpArgs, startPhoneHttpServer, wantsHttp, type PhoneHttpOptions, type PhoneHttpServer } from "./mcp-http.ts";
import { startMockWda, type MockWda } from "./mock-wda.ts";
import { WdaClient } from "./wda.ts";

process.env.SETTLE_MS = "0";

const TOKEN = "a".repeat(64);
const MCP_TS = fileURLToPath(new URL("./mcp.ts", import.meta.url));
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

async function serve(opts: Partial<PhoneHttpOptions> = {}, device?: Device): Promise<PhoneHttpServer> {
  Object.assign(mock.state, { app: "home", wifi: true, draft: "", focused: false, notes: [] });
  const server = await startPhoneHttpServer(device ?? new IPhone(new WdaClient(mock.url)), { port: 0, ...opts });
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

/** fetch won't let us forge Host, so speak HTTP by hand. `headers` are full lines ending in \r\n. */
function raw(url: string, headers: string): Promise<string> {
  const { port } = new URL(url);
  return new Promise<string>((resolve, reject) => {
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
}

const run = promisify(execFile);
const runMcp = (args: string[], env: NodeJS.ProcessEnv) =>
  run(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", MCP_TS, ...args], { env, timeout: 10_000 });

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
  assert.match(await raw(server.url, "host: evil.example:80\r\n"), /^HTTP\/1\.1 403/);
  assert.match(await raw(server.url, `host: localhost:${port}\r\norigin: http://evil.example\r\n`), /^HTTP\/1\.1 403/);
  assert.match(await raw(server.url, `host: localhost:${port}\r\norigin: null\r\n`), /^HTTP\/1\.1 403/);
  assert.match(await raw(server.url, `host: localhost:${port}\r\norigin: http://localhost:6274\r\n`), /^HTTP\/1\.1 200/);
  assert.match(await raw(server.url, `host: 127.0.0.1:${port}\r\n`), /^HTTP\/1\.1 200/);
  // Any 127.0.0.0/8 literal is loopback, same rule as the bind check.
  assert.match(await raw(server.url, `host: 127.0.0.2:${port}\r\n`), /^HTTP\/1\.1 200/);
  assert.match(await raw(server.url, `host: localhost:${port}\r\norigin: http://127.0.0.2:3000\r\n`), /^HTTP\/1\.1 200/);
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

test("http: a loopback bind with a non-loopback --allowed-host (proxy) counts as exposed", async () => {
  await assert.rejects(serve({ allowedHosts: ["mac.tail.ts.net"] }), /refusing to accept Host mac\.tail\.ts\.net without a bearer token/);

  const ro = await serve({ allowedHosts: ["mac.tail.ts.net"], token: TOKEN });
  assert.equal(ro.readOnly, true);
  const { port } = new URL(ro.url);
  assert.match(await raw(ro.url, `host: mac.tail.ts.net\r\n`), /^HTTP\/1\.1 401/);
  assert.match(await raw(ro.url, `host: mac.tail.ts.net\r\nauthorization: Bearer ${TOKEN}\r\n`), /^HTTP\/1\.1 200/);
  assert.match(await raw(ro.url, `host: other.tail.ts.net:${port}\r\nauthorization: Bearer ${TOKEN}\r\n`), /^HTTP\/1\.1 403/);

  assert.equal((await serve({ allowedHosts: ["mac.tail.ts.net"], token: TOKEN, allowActions: true })).readOnly, false);
  // Loopback-only extra names don't expose anything.
  assert.equal((await serve({ allowedHosts: ["localhost", "127.0.0.2", "[::1]"] })).readOnly, false);
});

test("http: --allowed-host entries are validated and normalized", async () => {
  for (const bad of ["http://mac.tail.ts.net", "mac.tail.ts.net:8765", "mac.tail.ts.net/mcp", "mac tail", "", "user@mac", "[::1]:80"]) {
    await assert.rejects(serve({ allowedHosts: [bad], token: TOKEN }), /invalid --allowed-host/, bad);
  }
  const server = await serve({ allowedHosts: ["Mac.Tail.TS.net.", "FD00:0:0:0:0:0:0:1"], token: TOKEN });
  const auth = `authorization: Bearer ${TOKEN}\r\n`;
  assert.match(await raw(server.url, `host: mac.tail.ts.net\r\n${auth}`), /^HTTP\/1\.1 200/);
  assert.match(await raw(server.url, `host: mac.tail.ts.net.:443\r\n${auth}`), /^HTTP\/1\.1 200/);
  assert.match(await raw(server.url, `host: [fd00::1]:8765\r\n${auth}`), /^HTTP\/1\.1 200/);
  assert.match(await raw(server.url, `host: [fd00::2]:8765\r\n${auth}`), /^HTTP\/1\.1 403/);
});

test("http: binds IPv6 loopback given as ::1 or [::1]", async (t) => {
  let first: PhoneHttpServer;
  try {
    first = await serve({ host: "::1" });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") return t.skip(`no IPv6 loopback here (${code})`);
    throw err;
  }
  assert.match(first.url, /^http:\/\/\[::1\]:\d+\/mcp$/);
  assert.equal(first.readOnly, false);
  const second = await serve({ host: "[::1]" });
  const client = await connect(second.url);
  assert.equal((await client.listTools()).tools.length, 7);
  await client.close();
});

test("http: IPHONE_MCP_READ_ONLY wins over allowActions", async () => {
  const server = await serve({ host: "0.0.0.0", token: TOKEN, allowActions: true, readOnly: true });
  assert.equal(server.readOnly, true);
});

test("http: concurrent clients' tool calls run one after another on the device", async () => {
  const log: string[] = [];
  const pause = () => new Promise((r) => setTimeout(r, 20));
  const slow = (label: string) => async () => {
    log.push(`${label}:start`);
    await pause();
    log.push(`${label}:end`);
  };
  const device: Device = {
    screenshot: async () => {
      log.push("screenshot:start");
      await pause();
      log.push("screenshot:end");
      return { png: "iVBORw0KGgo=", width: 1, height: 1 };
    },
    describeUi: async () => "",
    tap: slow("tap"),
    swipe: slow("swipe"),
    typeText: slow("type"),
    pressButton: slow("press"),
    launchApp: slow("launch"),
  };
  const server = await serve({}, device);
  const [a, b] = await Promise.all([connect(server.url), connect(server.url)]);
  const results = await Promise.all([
    a.callTool({ name: "tap", arguments: { x: 1, y: 2 } }),
    b.callTool({ name: "type_text", arguments: { text: "hi" } }),
  ]);
  assert.deepEqual(results.map((r) => r.isError), [undefined, undefined]);
  const tapFirst = ["tap:start", "tap:end", "screenshot:start", "screenshot:end", "type:start", "type:end", "screenshot:start", "screenshot:end"];
  const typeFirst = ["type:start", "type:end", "screenshot:start", "screenshot:end", "tap:start", "tap:end", "screenshot:start", "screenshot:end"];
  assert.ok(
    JSON.stringify(log) === JSON.stringify(tapFirst) || JSON.stringify(log) === JSON.stringify(typeFirst),
    `interleaved: ${log.join(", ")}`,
  );
  await Promise.all([a.close(), b.close()]);
});

test("parseHttpArgs: optional port, flags, and strictness", () => {
  assert.deepEqual(parseHttpArgs(["--http"], undefined), { port: 8765 });
  assert.deepEqual(parseHttpArgs(["--mock", "--http", "9000"], ""), { port: 9000 });
  assert.deepEqual(parseHttpArgs(["--http=9001", "--mock"], ""), { port: 9001 });
  assert.deepEqual(
    parseHttpArgs(["--http", "--host", "100.64.0.1", "--allow-actions", "--allowed-host", "mac.tail.ts.net"], TOKEN),
    { port: 8765, host: "100.64.0.1", token: TOKEN, allowActions: true, allowedHosts: ["mac.tail.ts.net"] },
  );
  assert.throws(() => parseHttpArgs(["--http", "--hots", "0.0.0.0"], TOKEN));
  assert.throws(() => parseHttpArgs(["--http", "--host"], TOKEN));
  assert.throws(() => parseHttpArgs(["--http", "70000"], TOKEN), /invalid port/);
  assert.throws(() => parseHttpArgs(["--http=abc"], TOKEN), /invalid port/);
});

test("wantsHttp: --http and --http=<port> select HTTP; HTTP-only flags without it are errors", () => {
  assert.equal(wantsHttp(["--http"]), true);
  assert.equal(wantsHttp(["--mock", "--http=9000"]), true);
  assert.equal(wantsHttp(["--mock"]), false);
  assert.equal(wantsHttp([]), false);
  assert.throws(() => wantsHttp(["--host", "0.0.0.0"]), /--host only applies to HTTP mode/);
  assert.throws(() => wantsHttp(["--allow-actions"]), /--allow-actions only applies to HTTP mode/);
  assert.throws(() => wantsHttp(["--allowed-host=mac.tail.ts.net"]), /--allowed-host only applies to HTTP mode/);
});

test("http entrypoint: refuses to start when exposure rules or flags are violated", async () => {
  const { IPHONE_MCP_TOKEN: _, ...env } = process.env;
  const fails = async (args: string[], pattern: RegExp) =>
    assert.rejects(runMcp(args, env), (err: { code?: number; stderr?: string }) => {
      assert.equal(err.code, 1, args.join(" "));
      assert.match(err.stderr ?? "", pattern);
      return true;
    });
  await fails(["--mock", "--http", "0", "--host", "0.0.0.0"], /refusing to bind 0\.0\.0\.0 without a bearer token/);
  await fails(["--mock", "--http=0", "--host", "0.0.0.0"], /refusing to bind 0\.0\.0\.0 without a bearer token/);
  await fails(["--mock", "--http", "0", "--allowed-host", "mac.tail.ts.net"], /refusing to accept Host mac\.tail\.ts\.net/);
  await fails(["--mock", "--http", "0", "--allowed-host", "mac.tail.ts.net:443"], /invalid --allowed-host/);
  await fails(["--mock", "--allow-actions"], /--allow-actions only applies to HTTP mode/);
});
