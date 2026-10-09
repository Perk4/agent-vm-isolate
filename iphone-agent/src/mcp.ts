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

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { ACTIONS, approvalInput, execute, TOOLS, type ToolContent } from "./agent.ts";
import { IPhone, type Device } from "./device.ts";
import { startMockWda } from "./mock-wda.ts";
import { WdaClient } from "./wda.ts";

export type PhoneServerOptions = {
  readOnly?: boolean;
  /** Same gate as runAgent's: return false to refuse an action before it reaches the device. */
  approve?: (tool: string, input: Record<string, unknown>) => boolean | Promise<boolean>;
};

export function createPhoneMcpServer(device: Device, opts: PhoneServerOptions = {}): Server {
  const exposed = TOOLS.filter((t) => !opts.readOnly || !ACTIONS.has(t.name));
  const tools: Tool[] = exposed.map((t) => {
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
  const names = new Set(tools.map((t) => t.name));

  const server = new Server({ name: "iphone-agent", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args = {} } = req.params;
    if (!names.has(name)) return { isError: true, content: [{ type: "text", text: `unknown or disabled tool: ${name}` }] };
    try {
      // Resolve once: the approver and the tap must see the same target.
      const shown = approvalInput(device, name, args);
      if (ACTIONS.has(name) && opts.approve && !(await opts.approve(name, shown))) {
        return { isError: true, content: [{ type: "text", text: "action denied by the operator" }] };
      }
      return { content: toMcp(await execute(device, name, shown)) };
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
  const mock = process.argv.includes("--mock") ? await startMockWda() : null;
  const wda = new WdaClient(mock?.url ?? process.env.WDA_URL ?? "http://127.0.0.1:8100");
  const server = createPhoneMcpServer(new IPhone(wda), { readOnly: process.env.IPHONE_MCP_READ_ONLY === "1" });
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; diagnostics go to stderr.
  console.error(`iphone-agent MCP server on stdio, WDA at ${wda.baseUrl}${mock ? " (mock)" : ""}`);
}
