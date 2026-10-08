// The agent harness: everything except the model call. A manual tool-use loop
// over seven phone tools. The model call is injected, so tests can swap in a
// scripted model and the real CLI uses the Anthropic SDK.

import Anthropic from "@anthropic-ai/sdk";
import type { Device } from "./device.ts";

type Tool = Anthropic.Beta.BetaTool;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type Message = Anthropic.Beta.BetaMessage;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;
export type ToolContent = Exclude<ToolResult["content"], undefined>;
type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;

export type CreateMessage = (params: Params) => Promise<Message>;

const obj = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const;
const num = (description: string) => ({ type: "number", description });

export const TOOLS: Tool[] = [
  {
    name: "screenshot",
    description: "Capture the iPhone screen. The image is in iOS points, the same units tap and swipe use.",
    input_schema: obj({}, []),
    strict: true,
  },
  {
    name: "describe_ui",
    description:
      "List on-screen accessibility elements, one per line: type, label, center=(x,y) in points, size, value. " +
      "Prefer tapping an element's center over estimating coordinates from the screenshot.",
    input_schema: obj({}, []),
    strict: true,
  },
  {
    name: "tap",
    description: "Tap at (x, y) in points. Returns a fresh screenshot.",
    input_schema: obj({ x: num("x in points"), y: num("y in points") }, ["x", "y"]),
    strict: true,
  },
  {
    name: "swipe",
    description: "Drag from one point to another, e.g. to scroll. Returns a fresh screenshot.",
    input_schema: obj(
      { from_x: num("start x"), from_y: num("start y"), to_x: num("end x"), to_y: num("end y") },
      ["from_x", "from_y", "to_x", "to_y"],
    ),
    strict: true,
  },
  {
    name: "type_text",
    description: "Type into the focused text field. Tap the field first. Returns a fresh screenshot.",
    input_schema: obj({ text: { type: "string" } }, ["text"]),
    strict: true,
  },
  {
    name: "press_button",
    description: "Press a hardware button. 'home' returns to the home screen. Returns a fresh screenshot.",
    input_schema: obj({ button: { type: "string", enum: ["home", "volumeUp", "volumeDown"] } }, ["button"]),
    strict: true,
  },
  {
    name: "launch_app",
    description:
      "Launch an app by bundle id, e.g. com.apple.Preferences (Settings), com.apple.mobilenotes (Notes), " +
      "com.apple.mobilesafari (Safari). Returns a fresh screenshot.",
    input_schema: obj({ bundle_id: { type: "string" } }, ["bundle_id"]),
    strict: true,
  },
];

export const SYSTEM = `You operate a real iPhone through tools. You cannot see the screen unless you call screenshot or an action returns one.

Work in short observe -> act cycles: look, take one action, check the result. Use describe_ui to get exact element centers; all coordinates are iOS points. To type, tap the text field first, then type_text.

Do not enter passwords, make purchases, send messages, or change security settings unless the task explicitly says to. If something unexpected appears (login wall, permission prompt, payment sheet), stop and report it.

When the task is done, or you are blocked, reply with a short final answer and no tool call.`;

export type Step = { tool: string; input: Record<string, unknown>; ok: boolean; note: string };

export type RunOptions = {
  task: string;
  device: Device;
  createMessage: CreateMessage;
  model?: string;
  maxSteps?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  fallbacks?: boolean;
  /** Return false to deny an action before it reaches the device. */
  approve?: (tool: string, input: Record<string, unknown>) => boolean | Promise<boolean>;
  onStep?: (step: Step) => void;
};

export type RunResult = { answer: string; steps: Step[]; stopReason: string };

/** Tools that change device state; these go through the approve gate. */
export const ACTIONS = new Set(["tap", "swipe", "type_text", "press_button", "launch_app"]);

export async function execute(device: Device, name: string, input: Record<string, unknown>): Promise<ToolContent> {
  const n = (k: string) => {
    const v = input[k];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} must be a number`);
    return v;
  };
  const s = (k: string) => {
    const v = input[k];
    if (typeof v !== "string") throw new Error(`${k} must be a string`);
    return v;
  };
  switch (name) {
    case "screenshot":
      return await shot(device);
    case "describe_ui":
      return await device.describeUi();
    case "tap":
      await device.tap(n("x"), n("y"));
      break;
    case "swipe":
      await device.swipe(n("from_x"), n("from_y"), n("to_x"), n("to_y"));
      break;
    case "type_text":
      await device.typeText(s("text"));
      break;
    case "press_button": {
      const b = s("button");
      if (b !== "home" && b !== "volumeUp" && b !== "volumeDown") throw new Error(`unknown button ${b}`);
      await device.pressButton(b);
      break;
    }
    case "launch_app":
      await device.launchApp(s("bundle_id"));
      break;
    default:
      throw new Error(`unknown tool ${name}`);
  }
  // Give the UI a moment to settle so the returned screenshot shows the result.
  await new Promise((r) => setTimeout(r, Number(process.env.SETTLE_MS ?? 400)));
  return await shot(device);
}

async function shot(device: Device): Promise<ToolContent> {
  const o = await device.screenshot();
  return [
    { type: "text", text: `screen ${o.width}x${o.height} points` },
    { type: "image", source: { type: "base64", media_type: "image/png", data: o.png } },
  ];
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { device, createMessage } = opts;
  const maxSteps = opts.maxSteps ?? 30;
  const steps: Step[] = [];
  const messages: MessageParam[] = [{ role: "user", content: opts.task }];

  for (let turn = 0; ; turn++) {
    const params: Params = {
      model: opts.model ?? "claude-opus-5-5",
      max_tokens: 16000,
      system: SYSTEM,
      tools: TOOLS,
      messages,
      output_config: { effort: opts.effort ?? "medium" },
    };
    if (opts.fallbacks ?? true) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    const message = await createMessage(params);
    // Append the full content (thinking blocks included) so history stays append-only.
    messages.push({ role: "assistant", content: message.content });

    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const stop = message.stop_reason ?? "unknown";

    if (stop === "refusal") return { answer: text || "(model declined)", steps, stopReason: stop };
    if (stop === "max_tokens") return { answer: text || "(hit max_tokens)", steps, stopReason: stop };
    if (stop === "pause_turn") continue;
    if (uses.length === 0) return { answer: text, steps, stopReason: stop };
    if (turn >= maxSteps) return { answer: text || `(stopped after ${maxSteps} turns)`, steps, stopReason: "max_steps" };

    const results: ToolResult[] = [];
    for (const use of uses) {
      const input = (use.input ?? {}) as Record<string, unknown>;
      let content: ToolContent;
      let ok = true;
      let note = "ok";
      try {
        if (ACTIONS.has(use.name) && opts.approve && !(await opts.approve(use.name, input))) {
          throw new Error("action denied by the operator");
        }
        content = await execute(device, use.name, input);
      } catch (err) {
        ok = false;
        note = err instanceof Error ? err.message : String(err);
        content = note;
      }
      const step = { tool: use.name, input, ok, note };
      steps.push(step);
      opts.onStep?.(step);
      // All results go back in one user message so parallel calls keep working.
      results.push({ type: "tool_result", tool_use_id: use.id, content, ...(ok ? {} : { is_error: true }) });
    }
    messages.push({ role: "user", content: results });
  }
}

/** The real model call: the Anthropic SDK, credentials resolved from the environment. */
export function anthropicModel(client = new Anthropic()): CreateMessage {
  return (params) => client.beta.messages.create(params);
}
