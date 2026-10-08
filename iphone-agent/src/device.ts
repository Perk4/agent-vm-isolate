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
  swipe(fromX: number, fromY: number, toX: number, toY: number, duration?: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressButton(name: HardwareButton): Promise<void>;
  launchApp(bundleId: string): Promise<void>;
}

type UiNode = {
  type?: string;
  label?: string | null;
  name?: string | null;
  value?: string | null;
  rect?: { x: number; y: number; width: number; height: number };
  isEnabled?: boolean | string;
  children?: UiNode[];
};

// Containers that add noise without being tappable targets themselves.
const SKIP = new Set(["Other", "Window", "Application", "ScrollView", "Table", "CollectionView", "Image"]);

/** Flatten a WDA JSON source tree into one line per meaningful element. */
export function flattenUi(root: unknown, max = 150): string {
  const lines: string[] = [];
  const walk = (n: UiNode) => {
    const kind = (n.type ?? "").replace("XCUIElementType", "");
    const text = n.label || n.name || "";
    if (n.rect && (text || n.value) && !SKIP.has(kind) && n.rect.width > 0 && n.rect.height > 0) {
      const { x, y, width, height } = n.rect;
      const cx = Math.round(x + width / 2);
      const cy = Math.round(y + height / 2);
      let line = `${kind} "${text}" center=(${cx},${cy}) size=${Math.round(width)}x${Math.round(height)}`;
      if (n.value !== null && n.value !== undefined && n.value !== "") line += ` value=${JSON.stringify(n.value)}`;
      if (n.isEnabled === false || n.isEnabled === "0") line += " disabled";
      lines.push(line);
    }
    n.children?.forEach(walk);
  };
  walk(root as UiNode);
  if (lines.length > max) return [...lines.slice(0, max), `... ${lines.length - max} more elements`].join("\n");
  return lines.join("\n") || "(no labeled elements; use the screenshot)";
}

export class IPhone implements Device {
  private readonly wda: WdaClient;
  private size: { width: number; height: number } | null = null;

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
    return flattenUi(await this.wda.source("json"));
  }

  tap(x: number, y: number) {
    return this.wda.tap(x, y);
  }

  swipe(fromX: number, fromY: number, toX: number, toY: number, duration?: number) {
    return this.wda.swipe(fromX, fromY, toX, toY, duration);
  }

  typeText(text: string) {
    return this.wda.typeText(text);
  }

  pressButton(name: HardwareButton) {
    return this.wda.pressButton(name);
  }

  launchApp(bundleId: string) {
    return this.wda.launchApp(bundleId);
  }
}
