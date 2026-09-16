// Geometry for the mock engine: the crop, straighten, rotate and flip ops applied to a
// frame `renderFrame` already painted, plus the content rect that goes out with it.
//
// The real engine folds geometry into the proxy's sampling pass
// (engine/src/pipeline/renderer.cpp, `build_base`); this is the same arithmetic, walked
// per destination pixel in JS and sampled nearest-neighbour. It exists so the crop overlay
// has something truthful to sit on when the UI is driven against the mock: the rect the
// engine reports and the pixels under it have to agree, or the tool looks broken for
// reasons that are not the tool's.
import type { Op } from "@latent/protocol";

/** `[x, y, width, height]` of the image inside the frame, in frame pixels. */
export type ContentRect = [number, number, number, number];

export interface Geometry {
  left: number;
  top: number;
  right: number;
  bottom: number;
  angle: number;
  /** 0..3 quarter turns, from the `rotate` op's 0/90/180/270. */
  quadrant: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

const NEUTRAL: Geometry = {
  left: 0,
  top: 0,
  right: 1,
  bottom: 1,
  angle: 0,
  quadrant: 0,
  flipHorizontal: false,
  flipVertical: false,
};

function numberParam(op: Op, name: string, fallback: number): number {
  const value = op.params[name];
  return typeof value === "number" ? value : fallback;
}

/**
 * The geometry ops of a stack, collapsed. `bypassCrop` is `view.render`'s
 * `geometry: "full"`: the crop's own rect and straighten go, rotate and flip stay.
 */
export function geometryOf(stack: Op[], bypassCrop: boolean): Geometry {
  const geometry = { ...NEUTRAL };
  for (const op of stack) {
    if (op.enabled === false) continue;
    if (op.op === "crop" && !bypassCrop) {
      geometry.left = Math.min(Math.max(numberParam(op, "left", 0), 0), 1);
      geometry.top = Math.min(Math.max(numberParam(op, "top", 0), 0), 1);
      geometry.right = Math.min(Math.max(numberParam(op, "right", 1), 0), 1);
      geometry.bottom = Math.min(Math.max(numberParam(op, "bottom", 1), 0), 1);
      geometry.angle = numberParam(op, "angle", 0);
    }
    if (op.op === "rotate") {
      geometry.quadrant = ((Math.round(numberParam(op, "value", 0) / 90) % 4) + 4) % 4;
    }
    if (op.op === "flip") {
      geometry.flipHorizontal = op.params.horizontal === true;
      geometry.flipVertical = op.params.vertical === true;
    }
  }
  // A collapsed or inverted rect would divide by zero; the engine keeps one per cent too.
  geometry.right = Math.max(geometry.right, geometry.left + 0.01);
  geometry.bottom = Math.max(geometry.bottom, geometry.top + 0.01);
  return geometry;
}

/** True when the ops leave the frame exactly as it was painted. */
export function isNeutral(geometry: Geometry): boolean {
  return (
    geometry.left === 0 &&
    geometry.top === 0 &&
    geometry.right === 1 &&
    geometry.bottom === 1 &&
    geometry.angle === 0 &&
    geometry.quadrant === 0 &&
    !geometry.flipHorizontal &&
    !geometry.flipVertical
  );
}

/** Where the cropped image sits inside a `width`×`height` frame, letterboxed and centred. */
export function contentRectOf(geometry: Geometry, width: number, height: number): ContentRect {
  const turned = geometry.quadrant % 2 !== 0;
  const workWidth = turned ? height : width;
  const workHeight = turned ? width : height;
  const cropWidth = geometry.right - geometry.left;
  const cropHeight = geometry.bottom - geometry.top;
  const aspect = (workWidth * cropWidth) / (workHeight * cropHeight);

  let contentWidth = width;
  let contentHeight = Math.max(1, Math.round(width / aspect));
  if (contentHeight > height) {
    contentHeight = height;
    contentWidth = Math.max(1, Math.round(height * aspect));
  }
  contentWidth = Math.min(contentWidth, width);
  return [
    Math.floor((width - contentWidth) / 2),
    Math.floor((height - contentHeight) / 2),
    contentWidth,
    contentHeight,
  ];
}

/** Undoes the quarter turns: rotated-image coordinates back to the source's. */
function unturn(x: number, y: number, quadrant: number): [number, number] {
  if (quadrant === 1) return [y, 1 - x];
  if (quadrant === 2) return [1 - x, 1 - y];
  if (quadrant === 3) return [1 - y, x];
  return [x, y];
}

/**
 * Rewrites the frame's pixels in place: the cropped, straightened, turned image inside the
 * content rect, black around it. Returns that rect, which is what `view.render` answers
 * with. A neutral geometry leaves the buffer alone.
 */
export function applyGeometry(
  frame: ArrayBuffer,
  headerBytes: number,
  width: number,
  height: number,
  geometry: Geometry,
): ContentRect {
  const rect = contentRectOf(geometry, width, height);
  if (isNeutral(geometry)) return rect;

  const pixels = new Uint8Array(frame, headerBytes);
  const source = pixels.slice();
  pixels.fill(0);

  const turned = geometry.quadrant % 2 !== 0;
  const workAspect = turned ? height / width : width / height;
  const cropWidth = geometry.right - geometry.left;
  const cropHeight = geometry.bottom - geometry.top;
  const centreX = (geometry.left + geometry.right) / 2;
  const centreY = (geometry.top + geometry.bottom) / 2;
  const radians = (geometry.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const [rectX, rectY, rectWidth, rectHeight] = rect;

  for (let y = 0; y < rectHeight; y++) {
    const v = (y + 0.5) / rectHeight;
    for (let x = 0; x < rectWidth; x++) {
      const u = (x + 0.5) / rectWidth;
      // Crop, centre with the image's aspect, straighten, put it back — the engine's
      // matrix, one destination pixel at a time.
      const cropX = geometry.left + u * cropWidth;
      const cropY = geometry.top + v * cropHeight;
      const centredX = workAspect * (cropX - centreX);
      const centredY = cropY - centreY;
      const rotatedX = cos * centredX + sin * centredY;
      const rotatedY = -sin * centredX + cos * centredY;
      let sourceX = rotatedX / workAspect + centreX;
      let sourceY = rotatedY + centreY;
      [sourceX, sourceY] = unturn(sourceX, sourceY, geometry.quadrant);
      if (geometry.flipHorizontal) sourceX = 1 - sourceX;
      if (geometry.flipVertical) sourceY = 1 - sourceY;
      if (sourceX < 0 || sourceX >= 1 || sourceY < 0 || sourceY >= 1) continue;

      const from = (Math.floor(sourceY * height) * width + Math.floor(sourceX * width)) * 4;
      const to = ((y + rectY) * width + x + rectX) * 4;
      pixels[to] = source[from] ?? 0;
      pixels[to + 1] = source[from + 1] ?? 0;
      pixels[to + 2] = source[from + 2] ?? 0;
      pixels[to + 3] = 255;
    }
  }
  return rect;
}
