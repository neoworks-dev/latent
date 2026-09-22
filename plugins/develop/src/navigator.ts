// Where the viewer is looking, as a rectangle over the whole photo. Pure — the pane draws
// what this returns and nothing else decides it.

/** A rect over the photo, normalised 0..1 on both axes. */
export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const WHOLE_IMAGE: ViewRect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * The part of the photo on screen. `scale` is the viewer's: 1 is fit, so the whole picture
 * is in view and the rect is the whole thing. Above that the view shows 1/scale of each
 * axis around the centre, held inside the photo the way the engine holds the pan.
 */
export function visibleRect(viewport: {
  scale: number;
  centerX: number;
  centerY: number;
  fit: boolean;
}): ViewRect {
  if (viewport.fit || viewport.scale <= 1) return WHOLE_IMAGE;
  const extent = 1 / viewport.scale;
  const half = extent / 2;
  return {
    x: Math.min(1 - extent, Math.max(0, viewport.centerX - half)),
    y: Math.min(1 - extent, Math.max(0, viewport.centerY - half)),
    width: extent,
    height: extent,
  };
}

/**
 * The pan a click at `(u, v)` of the navigator asks for, in the canvas pixels `panBy`
 * takes: the picture moves against the pointer, so aiming at a point left of centre drags
 * the picture right. `imageWidth`/`imageHeight` are the drawn photo's size on the canvas.
 */
export function panForPoint(
  u: number,
  v: number,
  viewport: { centerX: number; centerY: number },
  imageWidth: number,
  imageHeight: number,
): { dx: number; dy: number } {
  return {
    dx: -(u - viewport.centerX) * imageWidth,
    dy: -(v - viewport.centerY) * imageHeight,
  };
}
