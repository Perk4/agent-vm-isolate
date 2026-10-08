// Minimal WebDriverAgent (WDA) HTTP client.
//
// WDA is the XCUITest-based HTTP server Appium uses to drive iOS. It runs on
// the iPhone (or Simulator) and listens on :8100. On a real device you forward
// that port to the host with `iproxy 8100 8100` or `go-ios forward 8100 8100`.
// Everything here is plain fetch: no Appium server, no Selenium client.
//
// Coordinates: WDA taps and drags are in *points*. Screenshots are in
// *pixels* (points x the device scale, usually 3 on modern iPhones); device.ts
// downscales them so the agent only ever deals in points.

export type Size = { width: number; height: number };

export type HardwareButton = "home" | "volumeUp" | "volumeDown";

type WdaResponse<T> = { value: T; sessionId?: string | null };

export class WdaError extends Error {
  readonly status: number;
  /** W3C error code from WDA, e.g. "invalid session id". */
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class WdaClient {
  readonly baseUrl: string;
  private sessionId: string | null = null;

  constructor(baseUrl = "http://127.0.0.1:8100") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: { "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(this.baseUrl + path, init);
    const text = await res.text();
    let json: WdaResponse<T> | undefined;
    try {
      json = JSON.parse(text) as WdaResponse<T>;
    } catch {
      // fall through: non-JSON body
    }
    if (!res.ok || json === undefined) {
      const err = (json?.value ?? null) as { error?: unknown; message?: unknown } | null;
      const detail = typeof err?.message === "string" ? err.message : text.slice(0, 200);
      const code = typeof err?.error === "string" ? err.error : null;
      throw new WdaError(`WDA ${method} ${path} -> ${res.status}: ${detail}`, res.status, code);
    }
    return json.value;
  }

  private async session(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const res = await fetch(this.baseUrl + "/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilities: { alwaysMatch: {} } }),
    });
    const json = (await res.json()) as WdaResponse<{ sessionId?: string }>;
    const id = json.sessionId ?? json.value?.sessionId;
    if (!res.ok || !id) throw new WdaError(`WDA could not create a session (${res.status})`, res.status);
    this.sessionId = id;
    return id;
  }

  /** Call a session-scoped route. If WDA restarted and dropped our session, open a new one and retry once. */
  private async sc<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    try {
      return await this.call<T>(method, `/session/${await this.session()}${path}`, body);
    } catch (err) {
      if (!(err instanceof WdaError) || err.code !== "invalid session id") throw err;
      this.sessionId = null;
      return await this.call<T>(method, `/session/${await this.session()}${path}`, body);
    }
  }

  status(): Promise<Record<string, unknown>> {
    return this.call("GET", "/status");
  }

  /** Screen size in points. */
  async windowSize(): Promise<Size> {
    return this.sc("GET", "/window/size");
  }

  /** Base64 PNG of the current screen, in pixels. */
  screenshot(): Promise<string> {
    return this.call("GET", "/screenshot");
  }

  /** Accessibility tree. `json` gives a nested object, `description` a compact text dump. */
  async source(format: "json" | "description" = "json"): Promise<unknown> {
    return this.sc("GET", `/source?format=${format}`);
  }

  async tap(x: number, y: number): Promise<void> {
    await this.sc("POST", "/wda/tap", { x, y });
  }

  async swipe(fromX: number, fromY: number, toX: number, toY: number, duration = 0.3): Promise<void> {
    await this.sc("POST", "/wda/dragfromtoforduration", { fromX, fromY, toX, toY, duration });
  }

  async typeText(text: string): Promise<void> {
    await this.sc("POST", "/wda/keys", { value: [...text] });
  }

  async pressButton(name: HardwareButton): Promise<void> {
    if (name === "home") {
      await this.call("POST", "/wda/homescreen");
      return;
    }
    await this.sc("POST", "/wda/pressButton", { name });
  }

  async launchApp(bundleId: string): Promise<void> {
    await this.sc("POST", "/wda/apps/launch", { bundleId });
  }
}
