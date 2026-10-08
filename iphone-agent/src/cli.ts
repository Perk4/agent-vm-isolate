// Usage:
//   npm run agent -- "Turn off Wi-Fi in Settings"
//   npm run agent -- --wda http://127.0.0.1:8100 --confirm "Open Notes and write 'milk'"
//   npm run agent -- --mock "Turn off Wi-Fi"      (built-in fake iPhone, no device needed)
//
// Flags: --wda <url>  --model <id>  --effort <level>  --max-steps <n>
//        --confirm (ask before each action)  --no-fallbacks  --mock

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
    model: { type: "string", default: "claude-opus-5-5" },
    effort: { type: "string", default: "medium" },
    "max-steps": { type: "string", default: "30" },
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
const effort = values.effort as "low" | "medium" | "high" | "xhigh" | "max";

let result;
try {
  result = await runAgent({
    task,
    device: new IPhone(wda),
    createMessage: anthropicModel(),
    model: values.model,
    effort,
    maxSteps: Number(values["max-steps"]),
    fallbacks: !values["no-fallbacks"],
    ...(rl ? { approve: async (tool, input) => /^y/i.test(await rl.question(`allow ${tool} ${JSON.stringify(input)}? [y/N] `)) } : {}),
    onStep: (s) => console.error(`${s.ok ? "✓" : "✗"} ${s.tool} ${JSON.stringify(s.input)}${s.ok ? "" : ` -> ${s.note}`}`),
  });
} catch (err) {
  console.error(`model call failed: ${err instanceof Error ? err.message : String(err)}`);
  console.error("Set ANTHROPIC_API_KEY (or run `ant auth login`) and try again.");
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
