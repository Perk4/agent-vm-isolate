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
  /** `listing` is the refListing() an approver saw; if the refs have been re-listed since, refuse. */
  tapRef(ref: string, listing?: number): Promise<void>;
  /** An opaque id of the current describe_ui listing, or null if there is none or it is stale. */
  refListing(): number | null;
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
  rawIdentifier?: string | null;
  value?: string | null;
  rect?: Rect;
  isEnabled?: boolean | string;
  isVisible?: boolean | string;
  children?: UiNode[];
};

/** One listed element. Its ref is `e<n>`, its position in the listing. */
type UiElement = {
  ref: string;
  kind: string;
  text: string;
  /** Accessibility name and identifier: two look-alike controls (same label, frame) can differ here. */
  id: [string | null, string | null];
  value: string | null;
  enabled: boolean;
  rect: Rect;
  line: string;
};

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
    // Hidden nodes get no ref: tapping a hidden element's frame would hit whatever is visible there.
    // A visible element turning hidden drops out of the listing, so the fingerprint changes too.
    const visible = !(n.isVisible === false || n.isVisible === "0");
    if (visible && n.rect && (text || n.value) && !SKIP.has(kind) && n.rect.width > 0 && n.rect.height > 0) {
      total++;
      if (elements.length < max) {
        const { x, y, width, height } = n.rect;
        const ref = `e${elements.length + 1}`;
        const cx = Math.round(x + width / 2);
        const cy = Math.round(y + height / 2);
        let line = `${ref} ${kind} "${text}" center=(${cx},${cy}) size=${Math.round(width)}x${Math.round(height)}`;
        if (n.value !== null && n.value !== undefined && n.value !== "") line += ` value=${JSON.stringify(n.value)}`;
        if (n.isEnabled === false || n.isEnabled === "0") line += " disabled";
        const enabled = !(n.isEnabled === false || n.isEnabled === "0");
        const id: [string | null, string | null] = [n.name ?? null, n.rawIdentifier ?? null];
        elements.push({ ref, kind, text, id, value: n.value ?? null, enabled, rect: { x, y, width, height }, line });
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
 * What a ref was taken from: the foreground app's bundle id (from /wda/activeAppInfo, which the
 * source tree doesn't carry), then every visible node with a frame, the root included, in order:
 * type, label, name, identifier, value, enabled state and frame. That covers nodes the listing
 * leaves out (unlabeled buttons, containers, an overlay), so any out-of-band change invalidates it:
 * an alert or sheet, a different app even with matching controls, or a control whose state changed
 * (a switch flipped elsewhere, which a tap would flip back). Our own actions expire refs through
 * the epoch anyway.
 */
function layout(root: unknown, bundleId: string | null): string {
  const nodes: unknown[] = [];
  const walk = (n: UiNode) => {
    const visible = !(n.isVisible === false || n.isVisible === "0");
    if (visible && n.rect && n.rect.width > 0 && n.rect.height > 0) {
      const { x, y, width, height } = n.rect;
      const enabled = !(n.isEnabled === false || n.isEnabled === "0");
      nodes.push([n.type ?? null, n.label ?? null, n.name ?? null, n.rawIdentifier ?? null, n.value ?? null, enabled, x, y, width, height]);
    }
    n.children?.forEach(walk);
  };
  const r = (root ?? {}) as UiNode;
  walk(r);
  return JSON.stringify([bundleId, r.type ?? null, r.label ?? null, r.name ?? null, r.rawIdentifier ?? null, nodes]);
}

const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

const REFRESH = "Call describe_ui again for fresh refs; do not tap its old coordinates.";

export class IPhone implements Device {
  private readonly wda: WdaClient;
  private size: { width: number; height: number } | null = null;
  // Bumped before every device action: refs from an older epoch are stale whatever the screen shows now.
  private epoch = 0;
  private refs: { epoch: number; listing: number; byRef: Map<string, UiElement>; layout: string } | null = null;
  // Each describe_ui listing gets a new id, so an approval can name the exact listing it saw.
  private listings = 0;

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
    const snap = await this.snapshot();
    const { source, bundleId } = snap;
    const ui = uiElements(source, MAX_ELEMENTS);
    // An action that ran while /source was in flight may have changed the screen under this listing,
    // and an app switch mid-read leaves no consistent snapshot: list it, but hand out no refs.
    if (epoch === this.epoch && snap.consistent) {
      this.refs = {
        epoch,
        listing: ++this.listings,
        byRef: new Map(ui.elements.map((e) => [e.ref, e])),
        layout: layout(source, bundleId),
      };
      return formatUi(ui);
    }
    // Don't leave an older listing answering to refs this text shows: expire it.
    if (this.refs) this.refs = { ...this.refs, epoch: -1 };
    return `${formatUi(ui)}\n(refs unavailable: the screen changed while it was read. Call describe_ui again before tapping by ref.)`;
  }

  async tapRef(ref: string, listing?: number): Promise<void> {
    const cached = this.refs;
    if (!cached) throw new Error("no element refs yet: call describe_ui first, then tap by ref.");
    if (cached.epoch !== this.epoch) throw new Error(`ref ${ref} is stale: an action ran since the last describe_ui. ${REFRESH}`);
    const target = cached.byRef.get(ref);
    if (!target) {
      const listed = cached.byRef.size ? `listed e1..e${cached.byRef.size}` : "listed no elements";
      throw new Error(`unknown ref ${ref}: the last describe_ui ${listed}. ${REFRESH}`);
    }
    // A describe_ui that ran while approval was pending can rebind the ref to another element, even
    // one that looks identical (a Back button in the same spot). Tap only from the listing approved.
    if (listing !== undefined && cached.listing !== listing) {
      throw new Error(`ref ${ref} was re-listed since it was approved; the approved element may be gone. ${REFRESH}`);
    }
    const c = center(target.rect);
    // Fresh, not the cached size: after a rotation the window is landscape and the cache is stale.
    const size = await this.wda.windowSize();
    this.size = size;
    if (c.x < 0 || c.y < 0 || c.x >= size.width || c.y >= size.height) {
      throw new Error(`ref ${ref} is off-screen at (${Math.round(c.x)},${Math.round(c.y)}): swipe it into view, then call describe_ui again.`);
    }
    // The screen can change without our tools (an alert, a notification, a slow transition), so the
    // whole layout must still match what describe_ui saw before tapping there.
    // Every visible node, not just the 150 listed, so a change past the cap or to an unlisted node counts.
    const snap = await this.snapshot();
    // An inconsistent snapshot (the app switched mid-read) can't vouch for the ref: treat it as changed.
    const now = snap.consistent ? layout(snap.source, snap.bundleId) : null;
    // Compare with the epoch checked on entry, not one read after the awaits above: an action that
    // ran during either await (a concurrent MCP call) must expire this ref.
    if (this.epoch !== cached.epoch || now !== cached.layout) {
      // Expire the listing but keep it, so a retry with another ref still reads "stale".
      if (this.refs === cached) this.refs = { ...cached, epoch: -1 };
      throw new Error(`ref ${ref} is stale: the screen changed since the last describe_ui. ${REFRESH}`);
    }
    await this.tap(c.x, c.y);
  }

  /**
   * /source bracketed by the foreground bundle id, read before and after. If the app switched while
   * /source was in flight, the tree and the id may describe different apps, so the snapshot is
   * marked inconsistent rather than fingerprinted.
   */
  private async snapshot(): Promise<{ source: unknown; bundleId: string | null; consistent: boolean }> {
    const before = await this.wda.activeBundleId();
    const source = await this.wda.source("json");
    const after = await this.wda.activeBundleId();
    return { source, bundleId: after, consistent: before === after };
  }

  refListing(): number | null {
    const cached = this.refs;
    return cached && cached.epoch === this.epoch ? cached.listing : null;
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
