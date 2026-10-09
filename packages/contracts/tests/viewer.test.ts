// The coordinate arithmetic every tool and the viewer's zoom depend on. Pure functions, so
// this is the cheap half of the proof; the engine's Catch2 suite pins the matrix it sends.
import { describe, expect, test } from "bun:test";
import {
  applyImageTransform,
  baseLayerMap,
  containRect,
  contentRectFor,
  FIT_VIEWPORT,
  frameTransform,
  IDENTITY_IMAGE_TRANSFORM,
  type ImageTransform,
  imagePoint,
  invertImageTransform,
  multiplyImageTransforms,
  oneToOneScale,
  panViewport,
  transformImageMatrix,
  type ViewportFrame,
  zoomLabel,
  zoomViewport,
} from "../src/index";

/** The matrix a 900×600 view of an uncropped photo answers with: image 0..1 onto the frame. */
const FITTED: ImageTransform = [900, 0, 0, 0, 600, 0, 0, 0, 1];

/** The left half of the photo, filling the same frame: image x 0..0.5 spans 900 pixels. */
const CROPPED: ImageTransform = [1800, 0, 0, 0, 600, 0, 0, 0, 1];

/**
 * What the engine would answer for one of the two matrices above at `scale`, centred on
 * `centre` in image coordinates: the rect grows by the scale and the matrix grows with it,
 * exactly as `geometry_map` builds them.
 */
function frame(
  fitted: ImageTransform,
  scale = 1,
  centre: [number, number] = [0.5, 0.5],
  insets = { left: 0, top: 0, right: 0, bottom: 0 },
): ViewportFrame {
  const originX = 900 / 2 - fitted[0] * scale * centre[0];
  const originY = 600 / 2 - fitted[4] * scale * centre[1];
  const transform: ImageTransform = [
    fitted[0] * scale,
    0,
    originX,
    0,
    fitted[4] * scale,
    originY,
    0,
    0,
    1,
  ];
  return {
    contentRect: [
      applyImageTransform(transform, 0, 0).x,
      applyImageTransform(transform, 0, 0).y,
      900 * scale,
      600 * scale,
    ],
    frameWidth: 900,
    frameHeight: 600,
    transform,
    scale,
    insets,
  };
}

describe("the image transform", () => {
  test("maps a point and back", () => {
    const point = applyImageTransform(FITTED, 0.25, 0.75);
    expect(point).toEqual({ x: 225, y: 450 });
    const back = applyImageTransform(invertImageTransform(FITTED), point.x, point.y);
    expect(back.x).toBeCloseTo(0.25, 9);
    expect(back.y).toBeCloseTo(0.75, 9);
  });

  test("survives a projective matrix, which a keystone makes it", () => {
    // A perspective term in the bottom row: the round trip still has to close.
    const keystoned: ImageTransform = [900, 0, 0, 0, 600, 0, 0, -0.2, 1];
    for (const [x, y] of [
      [0.1, 0.2],
      [0.5, 0.5],
      [0.9, 0.95],
    ]) {
      const point = applyImageTransform(keystoned, x ?? 0, y ?? 0);
      const back = applyImageTransform(invertImageTransform(keystoned), point.x, point.y);
      expect(back.x).toBeCloseTo(x ?? 0, 9);
      expect(back.y).toBeCloseTo(y ?? 0, 9);
    }
  });

  test("a rotated view still round trips", () => {
    // 90 degrees: the image's x axis runs down the frame.
    const rotated: ImageTransform = [0, 600, 0, 900, 0, 0, 0, 0, 1];
    const point = applyImageTransform(rotated, 0.25, 0.75);
    expect(point).toEqual({ x: 450, y: 225 });
    const back = applyImageTransform(invertImageTransform(rotated), 450, 225);
    expect(back.x).toBeCloseTo(0.25, 9);
    expect(back.y).toBeCloseTo(0.75, 9);
  });

  test("a singular matrix is the identity rather than a crash", () => {
    expect(invertImageTransform([0, 0, 0, 0, 0, 0, 0, 0, 0])).toEqual(IDENTITY_IMAGE_TRANSFORM);
    expect(applyImageTransform([1, 0, 0, 0, 1, 0, 0, 0, 0], 0.5, 0.5)).toEqual({ x: 0, y: 0 });
  });

  test("a cropped view puts a different image point in the middle", () => {
    // The left half fills the frame, so image x 0.25 is the centre.
    expect(applyImageTransform(CROPPED, 0.25, 0.5).x).toBe(450);
    expect(applyImageTransform(FITTED, 0.25, 0.5).x).toBe(225);
  });
});

describe("the viewport", () => {
  test("zooming at a point keeps that point under the cursor", () => {
    const at = frame(FITTED);
    const next = zoomViewport(at, 3, 200, 150);
    expect(next.fit).toBe(false);
    expect(next.scale).toBe(3);

    // The frame the engine would answer with at that viewport, built the same way the
    // engine builds it: the rect grows by the scale and is placed on the new centre.
    const width = 900 * 3;
    const height = 600 * 3;
    const centre = applyImageTransform(FITTED, next.centerX, next.centerY);
    const originX = 900 / 2 - (centre.x / 900) * width;
    const originY = 600 / 2 - (centre.y / 600) * height;
    // The pixel under the cursor before is the pixel under the cursor after.
    const image = applyImageTransform(invertImageTransform(FITTED), 200, 150);
    expect(originX + image.x * width).toBeCloseTo(200, 6);
    expect(originY + image.y * height).toBeCloseTo(150, 6);
  });

  test("scale 1 is fit, whatever the anchor was", () => {
    expect(zoomViewport(frame(FITTED), 1, 10, 10)).toEqual(FIT_VIEWPORT);
    expect(zoomViewport(frame(FITTED), 0.2, 10, 10)).toEqual(FIT_VIEWPORT);
  });

  test("zooming at an unchanged scale moves nothing", () => {
    // Holding a point still while the scale does not change is holding the picture still.
    const at = frame(FITTED, 2);
    const same = zoomViewport(at, 2, 120, 90);
    expect(same.centerX).toBeCloseTo(0.5, 6);
    expect(same.centerY).toBeCloseTo(0.5, 6);
  });

  test("a pan moves the centre against the drag", () => {
    const at = frame(FITTED, 2);
    const middle = { ...FIT_VIEWPORT, scale: 2, fit: false };
    const dragged = panViewport(at, middle, 180, 0);
    // The picture follows the pointer to the right, so the centre moves left — by the drag
    // measured in the zoomed rect, which is 1800 pixels across.
    expect(dragged.centerX).toBeCloseTo(0.5 - 180 / 1800, 6);
    expect(dragged.centerY).toBeCloseTo(0.5, 6);
    // A fitted viewport has nothing to pan.
    expect(panViewport(at, FIT_VIEWPORT, 200, 0)).toEqual(FIT_VIEWPORT);
  });

  test("the pan is clamped so a zoomed frame is never part letterbox", () => {
    // At 2× the centre can travel between a quarter and three quarters of the image before
    // its own edge would come into view.
    const at = frame(FITTED, 2);
    const middle = { ...FIT_VIEWPORT, scale: 2, fit: false };
    const cornered = panViewport(at, middle, 10_000, 10_000);
    expect(cornered.centerX).toBeCloseTo(0.25, 6);
    expect(cornered.centerY).toBeCloseTo(0.25, 6);
    const other = panViewport(at, middle, -10_000, -10_000);
    expect(other.centerX).toBeCloseTo(0.75, 6);
    expect(other.centerY).toBeCloseTo(0.75, 6);
  });

  test("1:1 is the scale at which one image pixel is one frame pixel", () => {
    // 6000 image pixels across 900 frame pixels when fitted.
    expect(oneToOneScale(frame(FITTED), 6000)).toBeCloseTo(6000 / 900, 6);
    // Cropped to the left half, the same photo already shows twice the detail, so 1:1 is
    // half the zoom away.
    expect(oneToOneScale(frame(CROPPED), 6000)).toBeCloseTo(6000 / 1800, 6);
  });

  test("the readout says Fit until it says a percentage", () => {
    expect(zoomLabel(FIT_VIEWPORT, 6.67)).toBe("Fit");
    expect(zoomLabel({ scale: 6.67, centerX: 0.5, centerY: 0.5, fit: false }, 6.67)).toBe("100%");
    expect(zoomLabel({ scale: 3.335, centerX: 0.5, centerY: 0.5, fit: false }, 6.67)).toBe("50%");
  });
});

describe("the frame the client shows before the engine answers", () => {
  const FITTED_VIEWPORT = FIT_VIEWPORT;

  test("a frame's own viewport predicts the rect the engine already sent", () => {
    expect(contentRectFor(frame(FITTED), FITTED_VIEWPORT)).toEqual(frame(FITTED).contentRect);
    const zoomed = { scale: 2, centerX: 0.25, centerY: 0.75, fit: false };
    const at2 = frame(FITTED, 2, [0.25, 0.75]);
    expect(contentRectFor(at2, zoomed)).toEqual(at2.contentRect);
  });

  test("a zoom predicts the rect and the matrix the engine will answer with", () => {
    const fitted = frame(FITTED);
    const viewport = zoomViewport(fitted, 2, 450, 300);
    const predicted = contentRectFor(fitted, viewport);
    const engine = frame(FITTED, 2, [viewport.centerX, viewport.centerY]);
    expect(predicted).toEqual(engine.contentRect);
    // And the matrix a tool draws through follows the same move, so a mask overlay stays on
    // the photo while the gesture is still only on the client.
    const moved = transformImageMatrix(
      frameTransform(fitted, FITTED_VIEWPORT, viewport),
      fitted.transform,
    );
    for (const [index, value] of engine.transform.entries()) {
      expect(moved[index]).toBeCloseTo(value, 6);
    }
  });

  test("the transform is the identity while the viewport has not moved", () => {
    expect(frameTransform(frame(FITTED), FITTED_VIEWPORT, FITTED_VIEWPORT)).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    });
  });

  test("a pan moves the picture and leaves its size alone", () => {
    const zoomed = frame(FITTED, 2, [0.5, 0.5]);
    const current = { scale: 2, centerX: 0.5, centerY: 0.5, fit: false };
    const moved = frameTransform(zoomed, current, panViewport(zoomed, current, -40, 0));
    expect(moved.scale).toBe(1);
    expect(moved.x).toBeCloseTo(-40, 0);
    expect(moved.y).toBe(0);
  });

  test("a picture the panels leave room for is centred in the hole, not in the frame", () => {
    const panel = { left: 0, top: 0, right: 300, bottom: 0 };
    const [x, , width] = contentRectFor(frame(FITTED, 1, [0.5, 0.5], panel), FIT_VIEWPORT);
    expect(x + width / 2).toBe(300);
  });
});

describe("the letterbox", () => {
  test("contain still answers the frame's own rect", () => {
    expect(containRect(1000, 500, 400, 400)).toEqual({ x: 0, y: 100, width: 400, height: 200 });
    expect(containRect(0, 500, 400, 400)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  test("a point in the box is normalised over the drawn image", () => {
    const rect = { x: 10, y: 20, width: 200, height: 100 };
    expect(imagePoint(110, 70, rect)).toEqual({ x: 0.5, y: 0.5 });
    // Outside the image is outside 0..1: a drag that leaves the photo is still a direction.
    expect(imagePoint(0, 0, rect).x).toBeLessThan(0);
  });
});

describe("the panels the client floats over the frame", () => {
  // A 300 px column down the right of a 900 px frame: the hole the photo is placed in is
  // the left 600 px, so its middle is x = 300 and not x = 450.
  const PANEL = { left: 0, top: 0, right: 300, bottom: 0 };

  /**
   * What the engine answers once the insets are in play: a 700×467 picture placed in the
   * 600 px hole, so it is wider than the hole and 100 px of it run behind the panel.
   */
  function overhanging(): ViewportFrame {
    const width = 700;
    const height = 467;
    const originX = -50;
    const originY = (600 - height) / 2;
    const transform: ImageTransform = [width, 0, originX, 0, height, originY, 0, 0, 1];
    return {
      contentRect: [originX, originY, width, height],
      frameWidth: 900,
      frameHeight: 600,
      transform,
      scale: width / 600,
      insets: PANEL,
    };
  }

  test("a picture wider than the hole pans, even while it still fits the window", () => {
    const zoomed = overhanging();
    const current = { scale: zoomed.scale, centerX: 0.5, centerY: 0.5, fit: false };
    const panned = panViewport(zoomed, current, -40, 0);
    // Dragged left, so more of the photo's right half is in the hole.
    expect(panned.centerX).toBeGreaterThan(0.5);
    // And it stops once the hole is full, not once the window is.
    const hard = panViewport(zoomed, current, -5000, 0);
    expect(hard.centerX).toBeCloseTo(1 - 600 / (2 * 700), 3);
  });

  test("a zoom keeps the point under the pointer where it is, measured in the hole", () => {
    // The anchor is the hole's own middle, so the image point under it becomes the centre.
    const zoomed = zoomViewport(frame(FITTED, 1, [0.5, 0.5], PANEL), 2, 300, 300);
    expect(zoomed.centerX).toBeCloseTo(1 / 3, 3);
    expect(zoomed.fit).toBe(false);
  });
});

describe("the base layer under a zoomed frame", () => {
  test("multiplying runs the right-hand matrix first", () => {
    const scale: ImageTransform = [2, 0, 0, 0, 2, 0, 0, 0, 1];
    const shift: ImageTransform = [1, 0, 10, 0, 1, 20, 0, 0, 1];
    const point = applyImageTransform(multiplyImageTransforms(scale, shift), 1, 1);
    expect(point).toEqual({ x: 22, y: 42 });
  });

  test("a canvas pixel of a 4x zoom lands on the base pixel of the same photo point", () => {
    // Zoomed 4x about the image point (0.25, 0.5): that point sits in the middle of the
    // 900×600 canvas, and the image spans 3600×2400 pixels.
    const zoomed: ImageTransform = [3600, 0, 450 - 900, 0, 2400, 300 - 1200, 0, 0, 1];
    const map = baseLayerMap(FITTED, zoomed);
    const centre = applyImageTransform(map, 450, 300);
    expect(centre.x).toBeCloseTo(225);
    expect(centre.y).toBeCloseTo(300);
    // The canvas corner the pan uncovered is still photo in the base frame.
    const corner = applyImageTransform(map, 0, 0);
    expect(corner.x).toBeCloseTo(112.5);
    expect(corner.y).toBeCloseTo(225);
  });

  test("an unmoved fitted frame maps onto itself", () => {
    const map = baseLayerMap(FITTED, FITTED);
    expect(applyImageTransform(map, 123, 456).x).toBeCloseTo(123);
    expect(applyImageTransform(map, 123, 456).y).toBeCloseTo(456);
  });

  test("a crop in the frame on screen still finds the uncropped base pixel", () => {
    const map = baseLayerMap(FITTED, CROPPED);
    // x 900 on the cropped frame is image x 0.5, which the fitted base has at 450.
    expect(applyImageTransform(map, 900, 0).x).toBeCloseTo(450);
  });
});
