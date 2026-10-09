import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent, TOOLS, type CreateMessage } from "./agent.ts";
import { flattenUi, IPhone } from "./device.ts";
import { startMockWda, type MockWda } from "./mock-wda.ts";
import { decodePng, encodePng, resize } from "./png.ts";
import { WdaClient, WdaError } from "./wda.ts";

process.env.SETTLE_MS = "0";

let mock: MockWda;
before(async () => {
  mock = await startMockWda();
});
after(() => mock.close());

function reset() {
  Object.assign(mock.state, { app: "home", wifi: true, draft: "", focused: false, notes: [] });
  mock.log.length = 0;
}

/** A scripted model: each turn returns the next tool call(s), then a final answer. */
function scripted(turns: Array<Array<{ name: string; input: Record<string, unknown> }> | string>) {
  const seen: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  const create: CreateMessage = async (params) => {
    seen.push(structuredClone(params));
    const turn = turns[i++] ?? "done";
    const content: Anthropic.Beta.BetaContentBlock[] =
      typeof turn === "string"
        ? [{ type: "text", text: turn, citations: null }]
        : turn.map((t, j) => ({ type: "tool_use", id: `tu_${i}_${j}`, name: t.name, input: t.input }) as Anthropic.Beta.BetaContentBlock);
    return {
      id: `msg_${i}`,
      type: "message",
      role: "assistant",
      model: params.model,
      content,
      stop_reason: typeof turn === "string" ? "end_turn" : "tool_use",
    } as unknown as Anthropic.Beta.BetaMessage;
  };
  return { create, seen };
}

test("png round-trips and box-downscales 3x to point resolution", () => {
  const rgb = Buffer.alloc(6 * 3 * 3, 0);
  rgb.fill(255, 0, 6 * 3); // top row white
  const img = decodePng(encodePng({ width: 6, height: 3, rgb }));
  assert.deepEqual([img.width, img.height], [6, 3]);
  assert.equal(img.rgb[0], 255);
  const small = resize(img, 2, 1);
  assert.deepEqual([small.width, small.height], [2, 1]);
  assert.equal(small.rgb[0], 85); // one white row out of three
});

test("WDA client speaks the session API and surfaces WDA errors", async () => {
  reset();
  const wda = new WdaClient(mock.url);
  assert.equal((await wda.status()).ready, true);
  assert.deepEqual(await wda.windowSize(), { width: 390, height: 844 });
  await wda.launchApp("com.apple.Preferences");
  assert.equal(mock.state.app, "com.apple.Preferences");
  await assert.rejects(wda.typeText("x"), (e: unknown) => e instanceof WdaError && /Keyboard is not present/.test(e.message));
  assert.ok(mock.log.includes("POST /session"));

  // WDA restarts drop the session; the client reopens one and retries once.
  mock.restart();
  await wda.launchApp("com.apple.mobilenotes");
  assert.equal(mock.state.app, "com.apple.mobilenotes");
  assert.equal(mock.log.filter((l) => l === "POST /session").length, 2);
});

test("device screenshot is downscaled from 3x pixels to points", async () => {
  reset();
  const shot = await new IPhone(new WdaClient(mock.url)).screenshot();
  assert.deepEqual([shot.width, shot.height], [390, 844]);
  const img = decodePng(Buffer.from(shot.png, "base64"));
  assert.deepEqual([img.width, img.height], [390, 844]);
  // The Settings icon (blue) sits at points (30..94, 80..144).
  const at = (x: number, y: number) => [...img.rgb.subarray((y * 390 + x) * 3, (y * 390 + x) * 3 + 3)];
  assert.deepEqual(at(60, 110), [52, 120, 246]);
  assert.deepEqual(at(5, 5), [255, 255, 255]);
});

test("describe_ui flattens the tree to tappable centers in points", async () => {
  reset();
  const ui = await new IPhone(new WdaClient(mock.url)).describeUi();
  assert.match(ui, /Icon "Settings" center=\(62,112\)/);
  assert.match(ui, /Icon "Notes" center=\(152,112\)/);
  assert.doesNotMatch(ui, /SpringBoard/);
  assert.equal(flattenUi({ type: "XCUIElementTypeOther", children: [] }), "(no labeled elements; use the screenshot)");
});

test("agent loop: model drives Settings to turn Wi-Fi off", async () => {
  reset();
  const model = scripted([
    [{ name: "describe_ui", input: {} }],
    [{ name: "tap", input: { x: 62, y: 112 } }],
    [{ name: "tap", input: { x: 345, y: 145 } }],
    "Wi-Fi is now off.",
  ]);
  const result = await runAgent({ task: "Turn off Wi-Fi", device: new IPhone(new WdaClient(mock.url)), createMessage: model.create });
  assert.equal(result.answer, "Wi-Fi is now off.");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(mock.state.wifi, false);
  assert.deepEqual(result.steps.map((s) => s.tool), ["describe_ui", "tap", "tap"]);

  // Request shape: default model, tools, refusal fallbacks, effort.
  const first = model.seen[0]!;
  assert.equal(first.model, "claude-opus-5-5");
  assert.equal(first.fallbacks, "default");
  assert.deepEqual(first.betas, ["server-side-fallback-2026-07-01"]);
  assert.deepEqual(first.output_config, { effort: "medium" });
  assert.deepEqual(first.tools!.map((t) => (t as { name: string }).name), TOOLS.map((t) => t.name));

  // Each action's tool_result carries a fresh screenshot as an image block.
  const last = model.seen[3]!.messages.at(-1)!;
  assert.equal(last.role, "user");
  const tr = (last.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]!;
  assert.equal(tr.type, "tool_result");
  const blocks = tr.content as Array<{ type: string }>;
  assert.deepEqual(blocks.map((b) => b.type), ["text", "image"]);
});

test("agent loop: tap field, type, save a note; errors go back as is_error", async () => {
  reset();
  const model = scripted([
    [{ name: "launch_app", input: { bundle_id: "com.apple.mobilenotes" } }],
    [{ name: "type_text", input: { text: "too early" } }], // field not focused yet -> error
    [{ name: "tap", input: { x: 156, y: 142 } }],
    [{ name: "type_text", input: { text: "buy milk" } }],
    [{ name: "tap", input: { x: 340, y: 142 } }],
    "Saved.",
  ]);
  const result = await runAgent({ task: "Note: buy milk", device: new IPhone(new WdaClient(mock.url)), createMessage: model.create });
  assert.deepEqual(mock.state.notes, ["buy milk"]);
  const failed = result.steps.filter((s) => !s.ok);
  assert.equal(failed.length, 1);
  assert.match(failed[0]!.note, /Keyboard is not present/);
  const errResult = (model.seen[2]!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]!;
  assert.equal(errResult.is_error, true);
});

test("approve gate blocks actions before they reach the device; maxSteps caps the loop", async () => {
  reset();
  const looping = scripted(Array.from({ length: 10 }, () => [{ name: "launch_app", input: { bundle_id: "com.apple.Preferences" } }]));
  const result = await runAgent({
    task: "x",
    device: new IPhone(new WdaClient(mock.url)),
    createMessage: looping.create,
    approve: () => false,
    maxSteps: 3,
    fallbacks: false,
  });
  assert.equal(mock.state.app, "home");
  assert.ok(!mock.log.some((l) => l.includes("apps/launch")));
  assert.equal(result.stopReason, "max_steps");
  assert.ok(result.steps.every((s) => !s.ok && /denied/.test(s.note)));
  assert.equal(looping.seen[0]!.fallbacks, undefined);
});

test("pause_turn responses count against maxSteps", async () => {
  reset();
  let calls = 0;
  const pausing: CreateMessage = async (params) => {
    calls++;
    return { id: "m", type: "message", role: "assistant", model: params.model, content: [], stop_reason: "pause_turn" } as unknown as Anthropic.Beta.BetaMessage;
  };
  const result = await runAgent({ task: "x", device: new IPhone(new WdaClient(mock.url)), createMessage: pausing, maxSteps: 3 });
  assert.equal(result.stopReason, "max_steps");
  assert.equal(calls, 4); // turns 0..3, then the cap
});

test("an action whose follow-up screenshot fails is reported as done, not failed", async () => {
  reset();
  const phone = new IPhone(new WdaClient(mock.url));
  const flaky = Object.assign(Object.create(phone) as IPhone, {
    screenshot: () => Promise.reject(new Error("screenshot timed out")),
  });
  const model = scripted([[{ name: "launch_app", input: { bundle_id: "com.apple.Preferences" } }], "ok"]);
  const result = await runAgent({ task: "x", device: flaky, createMessage: model.create });
  assert.equal(mock.state.app, "com.apple.Preferences");
  assert.equal(result.steps[0]!.ok, true);
  const tr = (model.seen[1]!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]!;
  assert.equal(tr.is_error, undefined);
  assert.match(String(tr.content), /launch_app done, but the follow-up screenshot failed \(screenshot timed out\)/);
});

test("concurrent first calls share one WDA session", async () => {
  reset();
  const wda = new WdaClient(mock.url);
  await Promise.all([wda.windowSize(), wda.source(), wda.windowSize()]);
  assert.equal(mock.log.filter((l) => l === "POST /session").length, 1);
});

test("WDA errors delivered with HTTP 200 still throw (W3C envelope and legacy status)", async () => {
  const bodies: Record<string, unknown> = {
    "/w3c": { value: { error: "no such element", message: "Unable to find element" } },
    "/legacy": { status: 7, value: "An element could not be located" },
    "/ok": { status: 0, value: { ready: true } },
  };
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(bodies[req.url ?? ""] ?? {}));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  // call() is private; reach it the way every public method does.
  const call = (path: string) => (new WdaClient(`http://127.0.0.1:${port}`) as unknown as { call: (m: string, p: string) => Promise<unknown> }).call("GET", path);
  try {
    await assert.rejects(call("/w3c"), (e: unknown) => e instanceof WdaError && e.code === "no such element" && /Unable to find element/.test(e.message));
    await assert.rejects(call("/legacy"), (e: unknown) => e instanceof WdaError && /could not be located/.test(e.message));
    assert.deepEqual(await call("/ok"), { ready: true });
  } finally {
    srv.close();
  }
});
