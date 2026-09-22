// The Relight tool's arithmetic, kept pure so the pane is left with drawing and the state
// object with calling the engine. Every coordinate here is image-normalised — 0..1 over the
// uncropped photo, the space the op's `x`/`y` params are stored in — so nothing in this
// file knows about the crop, the straighten or the zoom.
import type { Op } from "@latent/protocol";

export const RELIGHT_OP = "relight";

export type Point = [number, number];

/**
 * What a pointer can take hold of on the overlay. `depth` is the same grip as `light` with
 * Shift held: the light lives in a scene the photo only shows one plane of, and a pointer
 * has two axes for three.
 */
export type RelightHandle = "light" | "reach" | "depth" | null;

/** Wire values: a sidecar reads better with 0.42 in it than with 0.4199999999999999. */
function round(value: number): number {
  return Number(value.toFixed(4));
}

export function clampPoint(point: Point): Point {
  return [round(Math.min(1, Math.max(0, point[0]))), round(Math.min(1, Math.max(0, point[1])))];
}

export function paramOf(op: Op | undefined, name: string, fallback: number): number {
  const value = op?.params[name];
  return typeof value === "number" ? value : fallback;
}

/** Every `relight` entry of the stack, top-level ones and the ones inside layers. */
export function lightsIn(stack: Op[]): Op[] {
  const lights: Op[] = [];
  for (const entry of stack) {
    if (entry.op === RELIGHT_OP) lights.push(entry);
    for (const child of entry.ops ?? []) {
      if (child.op === RELIGHT_OP) lights.push(child);
    }
  }
  return lights;
}

export function lightPosition(op: Op | undefined): Point {
  return [paramOf(op, "x", 0.5), paramOf(op, "y", 0.5)];
}

/**
 * The light's reach as the shader reads it, in image heights: the `radius` slider's 0..100
 * mapped onto the same 0.15..1.75 the engine uses (pipeline/renderer.cpp). The overlay
 * draws it so "Reach" is a ring the user can see rather than a number.
 */
export function reachOf(op: Op | undefined): number {
  return 0.15 + (paramOf(op, "radius", 40) / 100) * 1.6;
}

/**
 * The light's reach as a ring in image space: a circle in the scene is an ellipse on a
 * photo that is wider than it is tall, because the shader measures x in units of the
 * image's height. Returned as points and drawn through the overlay's map, like every other
 * image-space shape in the app — only a straight scale would let a canvas ellipse land on
 * the right pixels under a crop or a keystone.
 */
export function ringPoints(center: Point, reach: number, aspect: number, segments = 64): Point[] {
  const radiusX = reach / Math.max(aspect, 1e-4);
  const points: Point[] = [];
  for (let step = 0; step < segments; step++) {
    const angle = (step / segments) * Math.PI * 2;
    points.push([center[0] + radiusX * Math.cos(angle), center[1] + reach * Math.sin(angle)]);
  }
  return points;
}

/**
 * Which grip a press takes, decided in canvas pixels so the tolerance is a screen distance
 * however far the view is zoomed in. `ringRadius` is the ring's radius on screen, which
 * the caller reads off the map rather than computing from the aspect twice.
 */
export function handleAt(
  pointer: Point,
  light: Point,
  ringRadius: number,
  tolerance = 14,
): RelightHandle {
  const distance = Math.hypot(pointer[0] - light[0], pointer[1] - light[1]);
  if (distance <= tolerance) return "light";
  if (Math.abs(distance - ringRadius) <= tolerance) return "reach";
  return null;
}

/** Dragging the ring sets `radius`, the inverse of `reachOf`. */
export function radiusFromDrag(point: Point, center: Point, aspect: number): number {
  const reach = Math.hypot((point[0] - center[0]) * aspect, point[1] - center[1]);
  return Math.round(Math.min(100, Math.max(0, ((reach - 0.15) / 1.6) * 100)));
}

/**
 * `distance`, the light's place along the axis the photo has no room for: 0 at the camera,
 * 100 at the back of the scene, on the same scale the depth map is normalised to. Dragging
 * up pushes the light away, which is where "further" is on a photograph.
 */
export function distanceFromDrag(start: number, startY: number, y: number): number {
  return clampDistance(start + (startY - y) * 200);
}

/** The same axis under the wheel, so it can be nudged without a modifier or a slider. */
export function distanceFromWheel(distance: number, deltaY: number): number {
  return clampDistance(distance - Math.sign(deltaY) * 2);
}

function clampDistance(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)));
}

/**
 * The light's colour on screen: the Planckian radiator at `kelvin`, normalised to a
 * readable swatch. An approximation of the engine's own transform (renderer.cpp's
 * `light_color`) — this one only has to look right in a 12 px dot.
 */
export function kelvinSwatch(kelvin: number): string {
  const t = Math.min(12000, Math.max(2000, kelvin)) / 100;
  const red = t <= 66 ? 255 : 329.7 * Math.pow(t - 60, -0.1332);
  const green = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * Math.pow(t - 60, -0.0755);
  let blue = 255;
  if (t < 66) blue = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  const channel = (value: number): number => Math.round(Math.min(255, Math.max(0, value)));
  return `rgb(${channel(red)}, ${channel(green)}, ${channel(blue)})`;
}

/** The depth map as an RGBA image, ready for `putImageData`: near is white, far is black. */
export function depthToRgba(depth: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(depth.length * 4);
  for (let i = 0; i < depth.length; i++) {
    const level = depth[i] ?? 0;
    rgba[i * 4] = level;
    rgba[i * 4 + 1] = level;
    rgba[i * 4 + 2] = level;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** Esc leaves the tool, `L` toggles it; a keystroke aimed at a text field is that field's. */
export interface RelightKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: { tagName: string; isContentEditable: boolean } | null;
}

/** A DOM event as the pure test above takes it — the fields, not the instance. */
export function keyEvent(event: KeyboardEvent): RelightKeyEvent {
  const target = event.target instanceof HTMLElement ? event.target : null;
  return {
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    target: target && { tagName: target.tagName, isContentEditable: target.isContentEditable },
  };
}

export function relightShortcut(event: RelightKeyEvent): "toggleTool" | "leaveTool" | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const target = event.target;
  if (target?.isContentEditable) return null;
  const tag = target?.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return null;
  if (event.key === "Escape") return "leaveTool";
  if (event.key === "l" || event.key === "L") return "toggleTool";
  return null;
}
