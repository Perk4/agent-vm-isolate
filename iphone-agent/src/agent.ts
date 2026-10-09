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
      "List on-screen accessibility elements, one per line: ref (e1, e2, ...), type, label, center=(x,y) in points, size, value. " +
      "Tap an element by its ref rather than estimating coordinates from the screenshot. " +
      "Refs expire after any action; call describe_ui again before tapping by ref.",
    input_schema: obj({}, []),
    strict: true,
  },
  {
    name: "tap",
    description:
      "Tap an element by its ref from the latest describe_ui, e.g. {\"ref\": \"e4\"}, or tap at {\"x\", \"y\"} in points. " +
      "Pass either ref, or both x and y, never both forms. A stale ref returns an error and taps nothing. " +
      "Returns a fresh screenshot.",
    // Either/or input, but a root-level oneOf/anyOf is refused by the Messages API (and so by MCP
    // clients that forward this schema), so all three fields are optional and execute() checks the shape.
    input_schema: obj(
      { ref: { type: "string", description: "element ref from describe_ui, e.g. e4" }, x: num("x in points"), y: num("y in points") },
      [],
    ),
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

Work in short observe -> act cycles: look, take one action, check the result. Use describe_ui to list elements, then tap them by ref; refs expire after every action, so call describe_ui again before the next tap by ref. All coordinates are iOS points. To type, tap the text field first, then type_text.

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
  /**
   * How many of the most recent tool results (screenshots included) the model keeps once
   * server-side context editing clears older ones. A positive integer; default 5. At least 1,
   * so the model always sees the result of its latest action.
   */
  keepToolUses?: number;
  /** Return false to deny an action before it reaches the device. */
  approve?: (tool: string, input: Record<string, unknown>) => boolean | Promise<boolean>;
  onStep?: (step: Step) => void;
};

export type RunResult = { answer: string; steps: Step[]; stopReason: string };

/**
 * The input an approver sees. A tap by ref gets a `target` naming the element it resolves to,
 * because `{"ref":"e7"}` alone doesn't tell a human whether e7 is "Cancel" or "Buy".
 */
export function approvalInput(device: Device, name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (name !== "tap" || typeof input.ref !== "string") return input;
  // `listing` pins the tap to the describe_ui listing this target came from (see IPhone.tapRef).
  return {
    ...input,
    target: device.describeRef(input.ref) ?? "unknown or stale ref (the tap will be refused)",
    listing: device.refListing() ?? -1,
  };
}

/** Tools that change device state; these go through the approve gate. */
export const ACTIONS = new Set(["tap", "swipe", "type_text", "press_button", "launch_app"]);

// Server-side context editing (beta context-management-2025-06-27). The API clears old
// tool results before the model sees them, so the history we send stays append-only, which
// preserved thinking requires: rewriting earlier turns client-side would invalidate it.
// Wait for a real backlog (trigger) and clear in batches of at least 5k tokens instead of
// one screenshot per turn. The trigger grows with `keep` (about 1k tokens of headroom per kept
// result, a ~440-token screenshot plus text) so a large keep count can't sit permanently
// below the point where anything is clearable.
const CONTEXT_EDITING_BETA = "context-management-2025-06-27";
export const clearOldToolResults = (keep: number): Anthropic.Beta.BetaClearToolUses20250919Edit => ({
  type: "clear_tool_uses_20250919",
  trigger: { type: "input_tokens", value: Math.max(20_000, 10_000 + keep * 1_000) },
  keep: { type: "tool_uses", value: keep },
  clear_at_least: { type: "input_tokens", value: 5_000 },
});

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
    case "tap": {
      const byRef = input.ref !== undefined;
      const byPoint = input.x !== undefined || input.y !== undefined;
      if (byRef === byPoint) throw new Error("tap takes either ref or x and y: exactly one of the two forms");
      // `listing` is set by approvalInput (never by the model: the schema forbids extra fields).
      if (byRef) await device.tapRef(s("ref"), typeof input.listing === "number" ? input.listing : undefined);
      else await device.tap(n("x"), n("y"));
      break;
    }
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
  // The action already happened. If only the follow-up screenshot fails, say so
  // rather than reporting a failure that would make the model repeat the action.
  try {
    return await shot(device);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `${name} done, but the follow-up screenshot failed (${why}). Call screenshot before acting again.`;
  }
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
  const keep = opts.keepToolUses ?? 5;
  // Fail before the first API call: a bad value would otherwise 400 on every request.
  if (!Number.isInteger(keep) || keep < 1) throw new RangeError(`keepToolUses must be a positive integer, got ${keep}`);
  const fallbacks = opts.fallbacks ?? true;

  for (let turn = 0; ; turn++) {
    const params: Params = {
      model: opts.model ?? "claude-opus-5-5",
      max_tokens: 16000,
      system: SYSTEM,
      tools: TOOLS,
      messages,
      output_config: { effort: opts.effort ?? "medium" },
      context_management: { edits: [clearOldToolResults(keep)] },
      betas: [CONTEXT_EDITING_BETA, ...(fallbacks ? ["server-side-fallback-2026-07-01"] : [])],
    };
    if (fallbacks) params.fallbacks = "default";
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
    if (uses.length === 0 && stop !== "pause_turn") return { answer: text, steps, stopReason: stop };
    if (turn >= maxSteps) return { answer: text || `(stopped after ${maxSteps} turns)`, steps, stopReason: "max_steps" };

    if (stop === "pause_turn") continue;

    const results: ToolResult[] = [];
    for (const use of uses) {
      const input = (use.input ?? {}) as Record<string, unknown>;
      // Resolve a tap's ref before acting: once the tap runs, the ref is stale.
      const shown = approvalInput(device, use.name, input);
      let content: ToolContent;
      let ok = true;
      let note = "ok";
      try {
        if (ACTIONS.has(use.name) && opts.approve && !(await opts.approve(use.name, shown))) {
          throw new Error("action denied by the operator");
        }
        content = await execute(device, use.name, shown);
      } catch (err) {
        ok = false;
        note = err instanceof Error ? err.message : String(err);
        content = note;
      }
      const step = { tool: use.name, input: shown, ok, note };
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
