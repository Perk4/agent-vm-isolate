// Usage:
//   npm run agent -- "Turn off Wi-Fi in Settings"
//   npm run agent -- --wda http://127.0.0.1:8100 --confirm "Open Notes and write 'milk'"
//   npm run agent -- --mock "Turn off Wi-Fi"      (built-in fake iPhone, no device needed)
//
// Flags: --wda <url>  --model <id>  --effort <level>  --max-steps <n>
//        --confirm (ask before each action)  --no-fallbacks  --mock

import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { anthropicModel, runAgent } from "./agent.ts";
import { IPhone } from "./device.ts";
import { startMockWda } from "./mock-wda.ts";
import { WdaClient } from "./wda.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wda: { type: "string", default: process.env.WDA_URL ?? "http://127.0.0.1:8100" },
    model: { type: "string" },
    effort: { type: "string" },
    "max-steps": { type: "string" },
    confirm: { type: "boolean", default: false },
    "no-fallbacks": { type: "boolean", default: false },
    mock: { type: "boolean", default: false },
  },
});

const task = positionals.join(" ").trim();
if (!task) {
  console.error('usage: npm run agent -- [--mock] [--wda URL] "task for the iPhone"');
  process.exit(2);
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
const isEffort = (v: string): v is Effort => (EFFORTS as readonly string[]).includes(v);
if (values.effort !== undefined && !isEffort(values.effort)) {
  console.error(`--effort must be one of ${EFFORTS.join(", ")}`);
  process.exit(2);
}
const maxSteps = values["max-steps"] === undefined ? undefined : Number(values["max-steps"]);
if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) {
  console.error("--max-steps must be a positive integer");
  process.exit(2);
}

const mock = values.mock ? await startMockWda() : null;
const wda = new WdaClient(mock?.url ?? values.wda);
try {
  const status = await wda.status();
  console.error(`connected to WDA at ${wda.baseUrl}: ${JSON.stringify(status).slice(0, 120)}`);
} catch (err) {
  console.error(`cannot reach WebDriverAgent at ${wda.baseUrl}. Is it running and is port 8100 forwarded?`);
  console.error(String(err));
  process.exit(1);
}

const rl = values.confirm ? createInterface({ input: process.stdin, output: process.stderr }) : null;

// Typed text can be a password or a private message: log its length, never its content.
const redact = (tool: string, input: Record<string, unknown>) =>
  tool === "type_text" && typeof input.text === "string" ? { ...input, text: `<${input.text.length} chars>` } : input;

let result;
try {
  result = await runAgent({
    task,
    device: new IPhone(wda),
    createMessage: anthropicModel(),
    // Unset flags fall through to runAgent's defaults, the single source of truth.
    ...(values.model !== undefined ? { model: values.model } : {}),
    ...(values.effort !== undefined && isEffort(values.effort) ? { effort: values.effort } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    fallbacks: !values["no-fallbacks"],
    ...(rl ? { approve: async (tool, input) => /^y/i.test(await rl.question(`allow ${tool} ${JSON.stringify(input)}? [y/N] `)) } : {}),
    onStep: (s) => console.error(`${s.ok ? "✓" : "✗"} ${s.tool} ${JSON.stringify(redact(s.tool, s.input))}${s.ok ? "" : ` -> ${s.note}`}`),
  });
} catch (err) {
  console.error(`agent run failed: ${err instanceof Error ? err.message : String(err)}`);
  const noEnvCreds = !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN;
  if (err instanceof Anthropic.AuthenticationError || noEnvCreds) {
    console.error("Check credentials: set ANTHROPIC_API_KEY, or run `ant auth login`.");
  }
  process.exitCode = 1;
} finally {
  rl?.close();
}
if (!result) {
  await mock?.close();
  process.exit();
}

console.log(result.answer);
console.error(`(${result.steps.length} tool calls, stop: ${result.stopReason})`);
if (mock) {
  console.error(`mock device state: ${JSON.stringify(mock.state)}`);
  await mock.close();
}
