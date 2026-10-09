// The agent's view of an iPhone. One coordinate system, iOS points, for
// everything: the screenshot is downscaled to point resolution, element frames
// come from the accessibility tree in points, and taps are sent in points.

import { decodePng, encodePng, resize } from "./png.ts";
import type { HardwareButton, WdaClient } from "./wda.ts";

export type Observation = { png: string; width: number; height: number };

export interface Device {
  screenshot(): Promise<Observation>;
  describeUi(): Promise<string>;
  tap(x: number, y: number): Promise<void>;
  /** Tap an element by the ref the latest describeUi gave it; throws, without tapping, if the ref is stale. */
  tapRef(ref: string): Promise<void>;
  /** What a ref points at per the latest describeUi (e.g. `Switch "Wi-Fi" at (345,145)`), or null if unknown or stale. */
  describeRef(ref: string): string | null;
  swipe(fromX: number, fromY: number, toX: number, toY: number, duration?: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressButton(name: HardwareButton): Promise<void>;
  launchApp(bundleId: string): Promise<void>;
}

type Rect = { x: number; y: number; width: number; height: number };

type UiNode = {
  type?: string;
  label?: string | null;
  name?: string | null;
  value?: string | null;
  rect?: Rect;
  isEnabled?: boolean | string;
  children?: UiNode[];
};

/** One listed element. Its ref is `e<n>`, its position in the listing. */
type UiElement = { ref: string; kind: string; text: string; rect: Rect; line: string };

type UiListing = { elements: UiElement[]; total: number };

// Containers that add noise without being tappable targets themselves.
const SKIP = new Set(["Other", "Window", "Application", "ScrollView", "Table", "CollectionView", "Image"]);

const MAX_ELEMENTS = 150;

/** Keep the meaningful elements of a WDA JSON source tree, in document order, at most `max`. */
function uiElements(root: unknown, max: number): UiListing {
  const elements: UiElement[] = [];
  let total = 0;
  const walk = (n: UiNode) => {
    const kind = (n.type ?? "").replace("XCUIElementType", "");
    const text = n.label || n.name || "";
    if (n.rect && (text || n.value) && !SKIP.has(kind) && n.rect.width > 0 && n.rect.height > 0) {
      total++;
      if (elements.length < max) {
        const { x, y, width, height } = n.rect;
        const ref = `e${elements.length + 1}`;
        const cx = Math.round(x + width / 2);
        const cy = Math.round(y + height / 2);
        let line = `${ref} ${kind} "${text}" center=(${cx},${cy}) size=${Math.round(width)}x${Math.round(height)}`;
        if (n.value !== null && n.value !== undefined && n.value !== "") line += ` value=${JSON.stringify(n.value)}`;
        if (n.isEnabled === false || n.isEnabled === "0") line += " disabled";
        elements.push({ ref, kind, text, rect: { x, y, width, height }, line });
      }
    }
    n.children?.forEach(walk);
  };
  walk(root as UiNode);
  return { elements, total };
}

function formatUi({ elements, total }: UiListing): string {
  const lines = elements.map((e) => e.line);
  if (total > elements.length) lines.push(`... ${total - elements.length} more elements`);
  return lines.join("\n") || "(no labeled elements; use the screenshot)";
}

/** Flatten a WDA JSON source tree into one line per meaningful element, each prefixed with its ref. */
export function flattenUi(root: unknown, max = MAX_ELEMENTS): string {
  return formatUi(uiElements(root, max));
}

/**
 * The screen's layout: every listed element's type, label and frame, in order, plus the total.
 * Values are left out so a flipped switch is the same screen. Any added element (an alert, a sheet,
 * a banner) or a different app changes it, which comparing one element at its index would miss.
 */
function layout({ elements, total }: UiListing): string {
  return JSON.stringify([total, elements.map((e) => [e.kind, e.text, e.rect.x, e.rect.y, e.rect.width, e.rect.height])]);
}

const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

const REFRESH = "Call describe_ui again for fresh refs; do not tap its old coordinates.";

export class IPhone implements Device {
  private readonly wda: WdaClient;
  private size: { width: number; height: number } | null = null;
  // Bumped before every device action: refs from an older epoch are stale whatever the screen shows now.
  private epoch = 0;
  private refs: { epoch: number; byRef: Map<string, UiElement>; layout: string } | null = null;

  constructor(wda: WdaClient) {
    this.wda = wda;
  }

  private async points() {
    this.size ??= await this.wda.windowSize();
    return this.size;
  }

  async screenshot(): Promise<Observation> {
    const [b64, size] = await Promise.all([this.wda.screenshot(), this.points()]);
    const img = decodePng(Buffer.from(b64, "base64"));
    // Landscape: WDA reports the rotated window size, so match orientation.
    const landscape = img.width > img.height;
    const w = landscape ? Math.max(size.width, size.height) : Math.min(size.width, size.height);
    const h = landscape ? Math.min(size.width, size.height) : Math.max(size.width, size.height);
    const small = resize(img, Math.round(w), Math.round(h));
    return { png: encodePng(small).toString("base64"), width: small.width, height: small.height };
  }

  async describeUi(): Promise<string> {
    const epoch = this.epoch;
    const ui = uiElements(await this.wda.source("json"), MAX_ELEMENTS);
    // An action that ran while /source was in flight may have changed the screen under this listing.
    if (epoch === this.epoch) this.refs = { epoch, byRef: new Map(ui.elements.map((e) => [e.ref, e])), layout: layout(ui) };
    return formatUi(ui);
  }

  async tapRef(ref: string): Promise<void> {
    const cached = this.refs;
    if (!cached) throw new Error("no element refs yet: call describe_ui first, then tap by ref.");
    if (cached.epoch !== this.epoch) throw new Error(`ref ${ref} is stale: an action ran since the last describe_ui. ${REFRESH}`);
    const target = cached.byRef.get(ref);
    if (!target) {
      const listed = cached.byRef.size ? `listed e1..e${cached.byRef.size}` : "listed no elements";
      throw new Error(`unknown ref ${ref}: the last describe_ui ${listed}. ${REFRESH}`);
    }
    const c = center(target.rect);
    const size = await this.points();
    if (c.x < 0 || c.y < 0 || c.x >= size.width || c.y >= size.height) {
      throw new Error(`ref ${ref} is off-screen at (${Math.round(c.x)},${Math.round(c.y)}): swipe it into view, then call describe_ui again.`);
    }
    // The screen can change without our tools (an alert, a notification, a slow transition), so the
    // whole layout must still match what describe_ui saw before tapping there.
    const epoch = this.epoch;
    const now = layout(uiElements(await this.wda.source("json"), MAX_ELEMENTS));
    if (epoch !== this.epoch || now !== cached.layout) {
      // Expire the listing but keep it, so a retry with another ref still reads "stale".
      if (this.refs === cached) this.refs = { ...cached, epoch: -1 };
      throw new Error(`ref ${ref} is stale: the screen changed since the last describe_ui. ${REFRESH}`);
    }
    await this.tap(c.x, c.y);
  }

  describeRef(ref: string): string | null {
    const cached = this.refs;
    const target = cached && cached.epoch === this.epoch ? cached.byRef.get(ref) : undefined;
    if (!target) return null;
    const c = center(target.rect);
    return `${target.kind} "${target.text}" at (${Math.round(c.x)},${Math.round(c.y)})`;
  }

  tap(x: number, y: number) {
    this.epoch++;
    return this.wda.tap(x, y);
  }

  swipe(fromX: number, fromY: number, toX: number, toY: number, duration?: number) {
    this.epoch++;
    return this.wda.swipe(fromX, fromY, toX, toY, duration);
  }

  typeText(text: string) {
    this.epoch++;
    return this.wda.typeText(text);
  }

  pressButton(name: HardwareButton) {
    this.epoch++;
    return this.wda.pressButton(name);
  }

  launchApp(bundleId: string) {
    this.epoch++;
    return this.wda.launchApp(bundleId);
  }
}
