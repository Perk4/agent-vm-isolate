// A fake iPhone that speaks the subset of the WebDriverAgent HTTP API the
// harness uses. It lets the whole loop (screenshot -> model -> tap/type) run on
// Linux CI with no Mac, Xcode, or device. Screens are deliberately tiny:
// a home screen, Settings with a Wi-Fi switch, and Notes with a text field.
//
// Run standalone: npm run mock   (listens on :8100 like a real WDA)

import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { encodePng } from "./png.ts";

export type Rect = { x: number; y: number; width: number; height: number };

export type Element = {
  type: string;
  label: string;
  name: string;
  value: string | null;
  rect: Rect;
  isEnabled: boolean;
  children: Element[];
};

type App = "home" | "com.apple.Preferences" | "com.apple.mobilenotes";

export type DeviceState = {
  app: App;
  wifi: boolean;
  draft: string;
  focused: boolean;
  notes: string[];
  /** A system alert drawn over the current app (e.g. a permission prompt). Any tap answers it. */
  alert: string | null;
};

export const SCREEN = { width: 390, height: 844, scale: 3 } as const;

const APPS: { id: App; label: string }[] = [
  { id: "com.apple.Preferences", label: "Settings" },
  { id: "com.apple.mobilenotes", label: "Notes" },
];

function el(type: string, label: string, rect: Rect, value: string | null = null, children: Element[] = []): Element {
  return { type: `XCUIElementType${type}`, label, name: label, value, rect, isEnabled: true, children };
}

export function tree(s: DeviceState): Element {
  const app = appTree(s);
  if (!s.alert) return app;
  // Like WDA, the alert comes after the app's own elements in document order.
  const alert = el("Alert", s.alert, { x: 40, y: 300, width: 310, height: 160 }, null, [
    el("Button", "Allow", { x: 40, y: 410, width: 310, height: 50 }),
  ]);
  return { ...app, children: [...app.children, alert] };
}

function appTree(s: DeviceState): Element {
  const full = { x: 0, y: 0, width: SCREEN.width, height: SCREEN.height };
  if (s.app === "home") {
    const icons = APPS.map((a, i) => el("Icon", a.label, { x: 30 + i * 90, y: 80, width: 64, height: 64 }));
    return el("Application", "SpringBoard", full, null, icons);
  }
  const back = el("Button", "Back", { x: 8, y: 50, width: 70, height: 44 });
  if (s.app === "com.apple.Preferences") {
    return el("Application", "Settings", full, null, [
      back,
      el("StaticText", "Settings", { x: 140, y: 50, width: 110, height: 44 }),
      el("Cell", "Wi-Fi", { x: 0, y: 120, width: 390, height: 50 }, null, [
        el("Switch", "Wi-Fi", { x: 320, y: 130, width: 51, height: 31 }, s.wifi ? "1" : "0"),
      ]),
      // Scrolled below the 844-point screen.
      el("Cell", "Privacy", { x: 0, y: 900, width: 390, height: 50 }),
    ]);
  }
  const saved = s.notes.map((n, i) => el("StaticText", n, { x: 16, y: 260 + i * 36, width: 358, height: 32 }));
  return el("Application", "Notes", full, null, [
    back,
    el("TextField", "Note", { x: 16, y: 120, width: 280, height: 44 }, s.draft || null),
    el("Button", "Save", { x: 306, y: 120, width: 68, height: 44 }),
    ...saved,
  ]);
}

function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

/** Deepest element under the point. */
function hit(e: Element, x: number, y: number): Element | null {
  if (!contains(e.rect, x, y)) return null;
  for (const c of e.children) {
    const h = hit(c, x, y);
    if (h) return h;
  }
  return e;
}

export function tap(s: DeviceState, x: number, y: number): void {
  if (s.alert) {
    // The alert is modal: the tap answers it and reaches nothing underneath.
    s.alert = null;
    return;
  }
  const target = hit(tree(s), x, y);
  const kind = target?.type.replace("XCUIElementType", "");
  s.focused = kind === "TextField";
  if (!target) return;
  if (kind === "Icon") s.app = APPS.find((a) => a.label === target.label)!.id;
  else if (kind === "Button" && target.label === "Back") s.app = "home";
  else if (kind === "Switch" || (kind === "Cell" && target.label === "Wi-Fi")) s.wifi = !s.wifi;
  else if (kind === "Button" && target.label === "Save" && s.draft) {
    s.notes.push(s.draft);
    s.draft = "";
  }
}

const COLORS: Record<string, [number, number, number]> = {
  Icon: [52, 120, 246],
  Button: [0, 122, 255],
  TextField: [230, 230, 235],
  Cell: [248, 248, 250],
  StaticText: [60, 60, 67],
};

/** Draw each element as a filled box at device-pixel resolution. No text: labels live in /source. */
export function render(s: DeviceState): Buffer {
  const k = SCREEN.scale;
  const width = SCREEN.width * k;
  const height = SCREEN.height * k;
  const rgb = Buffer.alloc(width * height * 3, 255);
  const fill = (r: Rect, c: [number, number, number]) => {
    for (let y = r.y * k; y < Math.min(height, (r.y + r.height) * k); y++) {
      for (let x = r.x * k; x < Math.min(width, (r.x + r.width) * k); x++) {
        const i = (y * width + x) * 3;
        rgb[i] = c[0];
        rgb[i + 1] = c[1];
        rgb[i + 2] = c[2];
      }
    }
  };
  const walk = (e: Element) => {
    const kind = e.type.replace("XCUIElementType", "");
    if (kind === "Switch") fill(e.rect, e.value === "1" ? [52, 199, 89] : [200, 200, 205]);
    else if (COLORS[kind]) fill(e.rect, COLORS[kind]);
    e.children.forEach(walk);
  };
  walk(tree(s));
  return encodePng({ width, height, rgb });
}

export type MockWda = {
  server: Server;
  url: string;
  state: DeviceState;
  log: string[];
  /** Simulate the WDA runner restarting: every existing session id becomes invalid. */
  restart: () => void;
  close: () => Promise<void>;
};

export async function startMockWda(port = 0): Promise<MockWda> {
  const state: DeviceState = { app: "home", wifi: true, draft: "", focused: false, notes: [], alert: null };
  const log: string[] = [];
  let sessions = 0;
  let sessionId = "";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = req.method === "POST" ? await readJson(req) : {};
    const sid = url.pathname.match(/^\/session\/([^/]+)/)?.[1];
    const path = url.pathname.replace(/^\/session\/[^/]+/, "");
    log.push(`${req.method} ${path}`);
    const ok = (value: unknown) => send(res, 200, { value, sessionId });
    const fail = (status: number, error: string, message: string) => send(res, status, { value: { error, message } });
    if (sid !== undefined && sid !== sessionId) return fail(404, "invalid session id", `Session ${sid} does not exist`);

    switch (`${req.method} ${path}`) {
      case "GET /status":
        return ok({ ready: true, message: "mock WebDriverAgent", os: { name: "iOS", version: "26.0" } });
      case "POST /session":
        sessionId = `mock-session-${++sessions}`;
        return send(res, 200, { value: { sessionId, capabilities: {} }, sessionId });
      case "GET /wda/activeAppInfo":
        return ok({ bundleId: state.app === "home" ? "com.apple.springboard" : state.app, name: "", pid: 1 });
      case "GET /window/size":
        return ok({ width: SCREEN.width, height: SCREEN.height });
      case "GET /screenshot":
        return ok(render(state).toString("base64"));
      case "GET /source":
        return ok(tree(state));
      case "POST /wda/tap":
        tap(state, Number(body.x), Number(body.y));
        return ok(null);
      case "POST /wda/dragfromtoforduration":
        return ok(null);
      case "POST /wda/keys": {
        if (!state.focused) return fail(400, "invalid element state", "Keyboard is not present");
        const chars = Array.isArray(body.value) ? body.value.join("") : String(body.value ?? "");
        state.draft += chars;
        return ok(null);
      }
      case "POST /wda/homescreen":
        state.app = "home";
        state.focused = false;
        return ok(null);
      case "POST /wda/pressButton":
        return ok(null);
      case "POST /wda/apps/launch": {
        const app = APPS.find((a) => a.id === body.bundleId);
        if (!app) return fail(404, "unknown error", `App ${String(body.bundleId)} is not installed`);
        state.app = app.id;
        state.focused = false;
        return ok(null);
      }
      default:
        return fail(404, "unknown command", `Unhandled endpoint: ${req.method} ${url.pathname}`);
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  return {
    server,
    url: `http://127.0.0.1:${actual}`,
    state,
    log,
    restart: () => {
      sessionId = "";
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 8100);
  const mock = await startMockWda(port);
  console.log(`mock WDA listening on ${mock.url}`);
}
