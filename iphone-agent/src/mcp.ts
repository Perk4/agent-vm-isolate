// The same seven phone tools as an MCP server, so any MCP client (Claude Code,
// Claude Desktop, the Agent SDK) can drive the iPhone with its own loop.
// Over stdio, the client's per-tool permission prompts are the approval gate
// (action tools carry destructiveHint). Embedders can pass `approve` as well.
//
//   claude mcp add iphone -- node --experimental-strip-types /path/to/iphone-agent/src/mcp.ts
//   claude mcp add iphone-mock -- node --experimental-strip-types /path/to/iphone-agent/src/mcp.ts --mock
//
// Env: WDA_URL (default http://127.0.0.1:8100), IPHONE_MCP_READ_ONLY=1 to expose
// only screenshot and describe_ui.
//
// `--http [port]` serves Streamable HTTP instead (default 127.0.0.1:8765); see
// mcp-http.ts for the exposure rules and README.md for flags.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { ACTIONS, execute, TOOLS, type ToolContent } from "./agent.ts";
import { IPhone, type Device } from "./device.ts";
// Circular on purpose: mcp-http.ts uses createPhoneMcpServer only inside functions, so either
// module can load first. A dynamic import here would deadlock against this file's top-level await.
import { parseHttpArgs, startPhoneHttpServer, wantsHttp } from "./mcp-http.ts";
import { startMockWda } from "./mock-wda.ts";
import { WdaClient } from "./wda.ts";

export type PhoneServerOptions = {
  readOnly?: boolean;
  /** Same gate as runAgent's: return false to refuse an action before it reaches the device. */
  approve?: (tool: string, input: Record<string, unknown>) => boolean | Promise<boolean>;
};

// Built once per process: HTTP mode creates a Server per request.
const ALL_TOOLS: Tool[] = TOOLS.map((t) => {
  const action = ACTIONS.has(t.name);
  return {
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    inputSchema: t.input_schema as Tool["inputSchema"],
    // Actions can send messages, change settings or open payment sheets, so clients should prompt for them.
    // A tap can reach anything on the phone, websites included, so actions are open-world.
    annotations: { readOnlyHint: !action, destructiveHint: action, openWorldHint: action },
  };
});
const READ_ONLY_TOOLS = ALL_TOOLS.filter((t) => !ACTIONS.has(t.name));

// One physical phone, possibly many clients (HTTP serves each request on its own Server).
// Every tool call on a device runs alone: interleaved actions would act on a screen the
// other client didn't see, and a read taken mid-action would show a half-applied UI.
const queues = new WeakMap<Device, Promise<unknown>>();
function exclusive<T>(device: Device, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(device) ?? Promise.resolve()).then(fn);
  // The caller sees the rejection through `run`; the queue only needs to know it settled.
  queues.set(device, run.then(() => undefined, () => undefined));
  return run;
}

export function createPhoneMcpServer(device: Device, opts: PhoneServerOptions = {}): Server {
  const tools = opts.readOnly ? READ_ONLY_TOOLS : ALL_TOOLS;
  const names = new Set(tools.map((t) => t.name));

  const server = new Server({ name: "iphone-agent", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args = {} } = req.params;
    if (!names.has(name)) return { isError: true, content: [{ type: "text", text: `unknown or disabled tool: ${name}` }] };
    try {
      if (ACTIONS.has(name) && opts.approve && !(await opts.approve(name, args))) {
        return { isError: true, content: [{ type: "text", text: "action denied by the operator" }] };
      }
      // Approval stays outside the lock so a pending human prompt doesn't block other clients' reads.
      return { content: toMcp(await exclusive(device, () => execute(device, name, args))) };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  });
  return server;
}

/** Anthropic tool_result content -> MCP content blocks. */
function toMcp(content: ToolContent): CallToolResult["content"] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.flatMap((b): CallToolResult["content"] => {
    if (b.type === "text") return [{ type: "text", text: b.text }];
    if (b.type === "image" && b.source.type === "base64") {
      return [{ type: "image", data: b.source.data, mimeType: b.source.media_type }];
    }
    return [];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const fail = (err: unknown): never => {
    console.error(`iphone-agent MCP: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  };
  const argv = process.argv.slice(2);
  let http = false;
  try {
    http = wantsHttp(argv);
  } catch (err) {
    fail(err);
  }
  const mock = argv.includes("--mock") ? await startMockWda() : null;
  const wda = new WdaClient(mock?.url ?? process.env.WDA_URL ?? "http://127.0.0.1:8100");
  const readOnly = process.env.IPHONE_MCP_READ_ONLY === "1";
  if (http) {
    try {
      const opts = parseHttpArgs(argv, process.env.IPHONE_MCP_TOKEN);
      const served = await startPhoneHttpServer(new IPhone(wda), { ...opts, readOnly });
      console.error(
        `iphone-agent MCP server on ${served.url}${served.readOnly ? " (read-only)" : ""}, WDA at ${wda.baseUrl}${mock ? " (mock)" : ""}`,
      );
    } catch (err) {
      fail(err);
    }
  } else {
    const server = createPhoneMcpServer(new IPhone(wda), { readOnly });
    await server.connect(new StdioServerTransport());
    // stdout carries the protocol; diagnostics go to stderr.
    console.error(`iphone-agent MCP server on stdio, WDA at ${wda.baseUrl}${mock ? " (mock)" : ""}`);
  }
}
