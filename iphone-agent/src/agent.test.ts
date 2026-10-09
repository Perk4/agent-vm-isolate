import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { approvalInput, clearOldToolResults, execute, runAgent, TOOLS, type CreateMessage } from "./agent.ts";
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
  Object.assign(mock.state, { app: "home", wifi: true, draft: "", focused: false, notes: [], alert: null });
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
  assert.deepEqual(first.betas, ["context-management-2025-06-27", "server-side-fallback-2026-07-01"]);
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

const clearEdit = clearOldToolResults;

test("30-step run: every request asks the API to clear old tool results; history stays append-only", async () => {
  reset();
  const model = scripted(Array.from({ length: 30 }, () => [{ name: "screenshot", input: {} }]));
  const result = await runAgent({ task: "x", device: new IPhone(new WdaClient(mock.url)), createMessage: model.create });
  assert.equal(result.steps.length, 30);
  assert.equal(model.seen.length, 31);

  for (const req of model.seen) {
    assert.deepEqual(req.context_management, { edits: [clearEdit(5)] });
    assert.deepEqual(req.betas, ["context-management-2025-06-27", "server-side-fallback-2026-07-01"]);
    assert.equal(req.fallbacks, "default");
  }

  // Each request repeats the previous one's messages byte for byte and only appends.
  for (let k = 1; k < model.seen.length; k++) {
    const prev = model.seen[k - 1]!.messages;
    const next = model.seen[k]!.messages;
    assert.equal(next.length, prev.length + 2);
    assert.equal(JSON.stringify(next.slice(0, prev.length)), JSON.stringify(prev));
  }

  // Pruning is the server's job: the client still sends every screenshot.
  const images = model.seen.at(-1)!.messages.flatMap((m) =>
    typeof m.content === "string"
      ? []
      : m.content.flatMap((b) => (b.type === "tool_result" && Array.isArray(b.content) ? b.content.filter((c) => c.type === "image") : [])),
  );
  assert.equal(images.length, 30);
});

test("context editing without fallbacks keeps its beta; keepToolUses sets the kept count", async () => {
  reset();
  const model = scripted([[{ name: "screenshot", input: {} }], "done"]);
  await runAgent({ task: "x", device: new IPhone(new WdaClient(mock.url)), createMessage: model.create, fallbacks: false, keepToolUses: 2 });
  for (const req of model.seen) {
    assert.deepEqual(req.betas, ["context-management-2025-06-27"]);
    assert.equal(req.fallbacks, undefined);
    assert.deepEqual(req.context_management, { edits: [clearEdit(2)] });
  }
});

test("context editing: the default edit's numbers, a trigger that grows with keep, and bad keep values", async () => {
  assert.deepEqual(clearOldToolResults(5), {
    type: "clear_tool_uses_20250919",
    trigger: { type: "input_tokens", value: 20_000 },
    keep: { type: "tool_uses", value: 5 },
    clear_at_least: { type: "input_tokens", value: 5_000 },
  });
  // 40 kept screenshots alone are ~17.6k tokens; a fixed 20k trigger would rarely leave 5k clearable.
  assert.equal(clearOldToolResults(40).trigger?.value, 50_000);

  for (const bad of [0, -1, 2.5, Number.NaN]) {
    const model = scripted(["done"]);
    await assert.rejects(
      runAgent({ task: "x", device: new IPhone(new WdaClient(mock.url)), createMessage: model.create, keepToolUses: bad }),
      RangeError,
    );
    assert.equal(model.seen.length, 0, `keepToolUses ${bad} must fail before any API call`);
  }
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

test("describe_ui prefixes each element with a ref", async () => {
  reset();
  const ui = await new IPhone(new WdaClient(mock.url)).describeUi();
  assert.match(ui, /^e1 Icon "Settings" center=\(62,112\)/m);
  assert.match(ui, /^e2 Icon "Notes" center=\(152,112\)/m);
});

test("agent loop: tap by ref turns Wi-Fi off", async () => {
  reset();
  // Home: e1 Settings. Settings: e1 Back, e2 title, e3 Wi-Fi cell, e4 Wi-Fi switch.
  const model = scripted([
    [{ name: "describe_ui", input: {} }],
    [{ name: "tap", input: { ref: "e1" } }],
    [{ name: "describe_ui", input: {} }],
    [{ name: "tap", input: { ref: "e4" } }],
    "Wi-Fi is now off.",
  ]);
  const result = await runAgent({ task: "Turn off Wi-Fi", device: new IPhone(new WdaClient(mock.url)), createMessage: model.create });
  assert.ok(result.steps.every((s) => s.ok), JSON.stringify(result.steps));
  assert.equal(mock.state.app, "com.apple.Preferences");
  assert.equal(mock.state.wifi, false);
});

test("a ref from before launch_app is stale: is_error, and nothing is tapped", async () => {
  reset();
  const model = scripted([
    [{ name: "describe_ui", input: {} }],
    [{ name: "launch_app", input: { bundle_id: "com.apple.Preferences" } }],
    [{ name: "tap", input: { ref: "e1" } }],
    "stopped",
  ]);
  const result = await runAgent({ task: "x", device: new IPhone(new WdaClient(mock.url)), createMessage: model.create });
  const tap = result.steps[2]!;
  assert.equal(tap.ok, false);
  assert.match(tap.note, /e1 is stale: an action ran.*describe_ui/);
  const tr = (model.seen[3]!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]!;
  assert.equal(tr.is_error, true);
  // e1 is Back on the Settings screen; tapping it would have gone home.
  assert.equal(mock.state.app, "com.apple.Preferences");
  assert.ok(!mock.log.includes("POST /wda/tap"));
});

test("tap by ref re-checks the screen and refuses when it changed out of band", async () => {
  reset();
  const phone = new IPhone(new WdaClient(mock.url));
  await phone.describeUi();
  mock.state.app = "com.apple.Preferences"; // the screen changed without going through our tools
  await assert.rejects(execute(phone, "tap", { ref: "e1" }), /e1 is stale: the screen changed.*describe_ui/);
  assert.ok(!mock.log.includes("POST /wda/tap"));
  assert.equal(mock.state.app, "com.apple.Preferences");
});

test("any action expires refs, even one that leaves the screen as it was", async () => {
  reset();
  const phone = new IPhone(new WdaClient(mock.url));
  await phone.describeUi();
  await execute(phone, "press_button", { button: "home" }); // already home: same screen, same elements
  await assert.rejects(execute(phone, "tap", { ref: "e1" }), /e1 is stale: an action ran/);
  assert.equal(mock.state.app, "home");
  await phone.describeUi();
  await execute(phone, "tap", { ref: "e1" });
  assert.equal(mock.state.app, "com.apple.Preferences");
});

test("tap input: unknown ref, ref before describe_ui, both forms, and neither form are errors", async () => {
  reset();
  const phone = new IPhone(new WdaClient(mock.url));
  await assert.rejects(execute(phone, "tap", { ref: "e1" }), /call describe_ui/);
  await phone.describeUi();
  await assert.rejects(execute(phone, "tap", { ref: "e99" }), /unknown ref e99.*describe_ui/);
  await assert.rejects(execute(phone, "tap", { ref: "e1", x: 1, y: 2 }), /either ref or x and y/);
  await assert.rejects(execute(phone, "tap", {}), /either ref or x and y/);
  await assert.rejects(execute(phone, "tap", { x: 1 }), /y must be a number/);
  assert.ok(!mock.log.includes("POST /wda/tap"));
  assert.equal(mock.state.app, "home");
});

test("an alert that appears over the screen makes every ref stale; the tap never reaches it", async () => {
  reset();
  const phone = new IPhone(new WdaClient(mock.url));
  await phone.launchApp("com.apple.Preferences");
  await phone.describeUi();
  mock.state.alert = "Allow Notes to use your location?"; // appears without going through our tools
  await assert.rejects(execute(phone, "tap", { ref: "e4" }), /e4 is stale: the screen changed/);
  assert.equal(mock.state.alert, "Allow Notes to use your location?", "the alert was not answered");
  assert.equal(mock.state.wifi, true);
  // A retry with another ref still says stale, not "call describe_ui first".
  await assert.rejects(execute(phone, "tap", { ref: "e1" }), /e1 is stale/);
  mock.state.alert = null;
});

test("a ref whose element is off-screen is refused instead of tapping outside the screen", async () => {
  reset();
  const phone = new IPhone(new WdaClient(mock.url));
  await phone.launchApp("com.apple.Preferences");
  assert.match(await phone.describeUi(), /e5 Cell "Privacy" center=\(195,925\)/);
  await assert.rejects(execute(phone, "tap", { ref: "e5" }), /e5 is off-screen at \(195,925\): swipe it into view/);
  assert.ok(!mock.log.some((l) => l === "POST /wda/tap"));
});

test("the approve gate sees what a ref resolves to, not just its name", async () => {
  reset();
  const seen: Record<string, unknown>[] = [];
  const model = scripted([
    [{ name: "launch_app", input: { bundle_id: "com.apple.Preferences" } }],
    [{ name: "describe_ui", input: {} }],
    [{ name: "tap", input: { ref: "e4" } }],
    "done",
  ]);
  const result = await runAgent({
    task: "x",
    device: new IPhone(new WdaClient(mock.url)),
    createMessage: model.create,
    approve: (_tool, input) => (seen.push(input), true),
  });
  const approved = seen.at(-1)!;
  assert.equal(approved.target, 'Switch "Wi-Fi" at (346,146)');
  assert.equal(typeof approved.listing, "number");
  assert.deepEqual(result.steps.at(-1)!.input, approved);
  assert.equal(mock.state.wifi, false);
});

/** A WDA stand-in serving a fixed tree, for screens the mock can't draw. */
function fakeWda(state: { tree: unknown; size: { width: number; height: number }; bundleId?: string }) {
  const taps: [number, number][] = [];
  const wda = {
    source: async () => state.tree,
    activeBundleId: async () => state.bundleId ?? "com.example.app",
    windowSize: async () => state.size,
    screenshot: async () =>
      encodePng({ width: state.size.width, height: state.size.height, rgb: Buffer.alloc(state.size.width * state.size.height * 3) }).toString("base64"),
    tap: async (x: number, y: number) => void taps.push([x, y]),
  };
  return { wda: wda as unknown as WdaClient, taps };
}

const button = (label: string, x: number, y: number) => ({
  type: "XCUIElementTypeButton", label, rect: { x, y, width: 40, height: 20 }, children: [],
});

test("ref staleness covers elements past the 150 listed", async () => {
  const buttons = Array.from({ length: 200 }, (_, i) => button(`b${i}`, 10, 10 + i));
  const state = { tree: { type: "XCUIElementTypeApplication", children: buttons }, size: { width: 390, height: 844 } };
  const { wda, taps } = fakeWda(state);
  const phone = new IPhone(wda);
  assert.match(await phone.describeUi(), /\.\.\. 50 more elements/);
  // Element 180 is never listed, but an overlay replacing it still changes the screen.
  state.tree = { ...state.tree, children: buttons.map((b, i) => (i === 180 ? button("Allow", 10, 190) : b)) };
  await assert.rejects(phone.tapRef("e1"), /e1 is stale: the screen changed/);
  assert.deepEqual(taps, []);
});

test("after a rotation, a ref on the right of a landscape screen is on-screen", async () => {
  const state = { tree: { type: "XCUIElementTypeApplication", children: [button("Right", 700, 100)] }, size: { width: 390, height: 844 } };
  const { wda, taps } = fakeWda(state);
  const phone = new IPhone(wda);
  await phone.screenshot(); // caches the portrait window size, as a real session would
  state.size = { width: 844, height: 390 };
  await phone.describeUi();
  await phone.tapRef("e1");
  assert.deepEqual(taps, [[720, 110]]);
});

test("an action that runs while tapRef awaits the window size expires the ref", async () => {
  const state = { tree: { type: "XCUIElementTypeApplication", children: [button("OK", 10, 10)] }, size: { width: 390, height: 844 } };
  const { wda, taps } = fakeWda(state);
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const slowWda = Object.assign(Object.create(wda) as WdaClient, {
    windowSize: async () => {
      await gate;
      return state.size;
    },
  });
  const phone = new IPhone(slowWda);
  await phone.describeUi();
  const pending = phone.tapRef("e1");
  await phone.tap(1, 1); // a concurrent action that leaves the layout unchanged
  release();
  await assert.rejects(pending, /e1 is stale/);
  assert.deepEqual(taps, [[1, 1]]);
});

test("a describe_ui during a pending approval can't redirect the approved tap", async () => {
  reset();
  const phone = new IPhone(new WdaClient(mock.url));
  await phone.describeUi(); // home: e1 = the Settings icon
  const shown = approvalInput(phone, "tap", { ref: "e1" });
  assert.equal(shown.target, 'Icon "Settings" at (62,112)');
  // While the human is deciding, the screen changes out of band and another describe_ui
  // rebinds e1 to Settings' Back button. The layout check alone would accept this tap.
  mock.state.app = "com.apple.Preferences";
  assert.match(await phone.describeUi(), /^e1 Button "Back"/);
  await assert.rejects(execute(phone, "tap", shown), /e1 was re-listed since it was approved/);
  assert.equal(mock.state.app, "com.apple.Preferences", "Back was not tapped");
});

test("an identical-looking element in a new listing is not the approved one", async () => {
  reset();
  const phone = new IPhone(new WdaClient(mock.url));
  await phone.launchApp("com.apple.Preferences");
  await phone.describeUi();
  const shown = approvalInput(phone, "tap", { ref: "e1" });
  assert.equal(shown.target, 'Button "Back" at (43,72)');
  // Out of band, Notes comes to the front. Its Back button has the same label and frame, so a
  // fresh describe_ui gives e1 the same description. It is still not what was approved.
  mock.state.app = "com.apple.mobilenotes";
  await phone.describeUi();
  assert.equal(approvalInput(phone, "tap", { ref: "e1" }).target, shown.target);
  await assert.rejects(execute(phone, "tap", shown), /e1 was re-listed since it was approved/);
  assert.equal(mock.state.app, "com.apple.mobilenotes", "Back was not tapped");
});

test("a different foreground app with matching controls makes refs stale", async () => {
  // Same root label and controls; only the foreground bundle id (from /wda/activeAppInfo) differs.
  const tree = { type: "XCUIElementTypeApplication", label: "Shop", children: [button("OK", 10, 10)] };
  const state = { tree, size: { width: 390, height: 844 }, bundleId: "com.example.a" };
  const { wda, taps } = fakeWda(state);
  const phone = new IPhone(wda);
  await phone.describeUi();
  state.bundleId = "com.example.b";
  await assert.rejects(phone.tapRef("e1"), /e1 is stale: the screen changed/);
  assert.deepEqual(taps, []);
});

test("a control whose state changed out of band makes refs stale", async () => {
  reset();
  const phone = new IPhone(new WdaClient(mock.url));
  await phone.launchApp("com.apple.Preferences");
  assert.match(await phone.describeUi(), /e4 Switch "Wi-Fi".*value="1"/);
  mock.state.wifi = false; // flipped elsewhere: tapping e4 now would turn Wi-Fi back on
  await assert.rejects(execute(phone, "tap", { ref: "e4" }), /e4 is stale: the screen changed/);
  assert.equal(mock.state.wifi, false);
});
