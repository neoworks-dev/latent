import { describe, expect, test } from "bun:test";
import {
  ASPECT_PRESETS,
  constrainCrop,
  type CropBox,
  cropCorners,
  cropInsideImage,
  cropRatio,
  cropShortcut,
  cursorFor,
  fitRatio,
  FULL_CROP,
  handleAt,
  moveCrop,
  type Point,
  ratioOf,
  resizeCrop,
  straightenAngle,
  swapOrientation,
} from "../src/crop";

/** The sample raw's shape: 3 : 2 landscape. */
const ASPECT = 1.5;

function box(left: number, top: number, right: number, bottom: number): CropBox {
  return { left, top, right, bottom };
}

function hit(point: Point, crop: CropBox, angle = 0): string {
  return handleAt({
    point,
    box: crop,
    angle,
    aspect: ASPECT,
    width: 900,
    height: 600,
    tolerance: 14,
  });
}

describe("the crop rectangle", () => {
  test("is its own corners when nothing is straightened", () => {
    const corners = cropCorners(box(0.2, 0.1, 0.8, 0.6), 0, ASPECT);
    const expected: Point[] = [
      [0.2, 0.1],
      [0.8, 0.1],
      [0.8, 0.6],
      [0.2, 0.6],
    ];
    for (const [index, corner] of corners.entries()) {
      expect(corner[0]).toBeCloseTo(expected[index]?.[0] ?? 0, 9);
      expect(corner[1]).toBeCloseTo(expected[index]?.[1] ?? 0, 9);
    }
  });

  test("turns against the image when it is straightened", () => {
    const corners = cropCorners(box(0.3, 0.3, 0.7, 0.7), 10, ASPECT);
    // No corner keeps both of its coordinates, and the centre does not move.
    expect(corners[0]?.[0]).not.toBeCloseTo(0.3, 3);
    const centreX = corners.reduce((sum, corner) => sum + corner[0], 0) / 4;
    const centreY = corners.reduce((sum, corner) => sum + corner[1], 0) / 4;
    expect(centreX).toBeCloseTo(0.5, 6);
    expect(centreY).toBeCloseTo(0.5, 6);
  });

  test("reports the ratio the exported picture will have", () => {
    // Half the width of a 3:2 frame is 3:4 — the crop's ratio is not the box's numbers.
    expect(cropRatio(box(0, 0, 0.5, 1), ASPECT)).toBeCloseTo(0.75, 6);
  });
});

describe("staying inside the image", () => {
  test("the whole image is inside itself until it is straightened", () => {
    expect(cropInsideImage(FULL_CROP, 0, ASPECT)).toBe(true);
    expect(cropInsideImage(FULL_CROP, 5, ASPECT)).toBe(false);
  });

  test("a small crop can be turned as far as the slider goes", () => {
    const small = box(0.4, 0.4, 0.6, 0.6);
    for (const angle of [-45, -12, 0, 12, 45]) {
      expect(cropInsideImage(small, angle, ASPECT)).toBe(true);
    }
  });

  test("a crop against an edge is pushed off it rather than clipped", () => {
    const edged = box(0.0, 0.3, 0.4, 0.7);
    const fixed = constrainCrop(edged, 20, ASPECT);
    expect(cropInsideImage(fixed, 20, ASPECT)).toBe(true);
    // The ratio survives, because the fix is a uniform shrink and a slide.
    expect(cropRatio(fixed, ASPECT)).toBeCloseTo(cropRatio(edged, ASPECT), 2);
  });

  test("a straightened full frame shrinks until every corner is back on the photo", () => {
    const fixed = constrainCrop(FULL_CROP, 8, ASPECT);
    expect(cropInsideImage(fixed, 8, ASPECT)).toBe(true);
    expect(fixed.right - fixed.left).toBeLessThan(1);
    expect(cropRatio(fixed, ASPECT)).toBeCloseTo(ASPECT, 2);
  });

  test("a move that would leave the photo stops at the edge", () => {
    const moved = moveCrop(box(0.2, 0.2, 0.5, 0.5), 0, ASPECT, [0.9, 0.9]);
    expect(moved.right).toBeCloseTo(1, 6);
    expect(moved.bottom).toBeCloseTo(1, 6);
    expect(moved.right - moved.left).toBeCloseTo(0.3, 6);
  });
});

describe("dragging a grip", () => {
  test("moves that corner and leaves the opposite one where it was", () => {
    const resized = resizeCrop({
      box: box(0.2, 0.2, 0.8, 0.8),
      angle: 0,
      aspect: ASPECT,
      handle: "se",
      pointer: [0.6, 0.55],
    });
    expect(resized.left).toBeCloseTo(0.2, 6);
    expect(resized.top).toBeCloseTo(0.2, 6);
    expect(resized.right).toBeCloseTo(0.6, 6);
    expect(resized.bottom).toBeCloseTo(0.55, 6);
  });

  test("an edge grip moves one side only", () => {
    const resized = resizeCrop({
      box: box(0.2, 0.2, 0.8, 0.8),
      angle: 0,
      aspect: ASPECT,
      handle: "w",
      pointer: [0.35, 0.9],
    });
    expect(resized.left).toBeCloseTo(0.35, 6);
    expect(resized.top).toBeCloseTo(0.2, 6);
    expect(resized.bottom).toBeCloseTo(0.8, 6);
  });

  test("keeps the anchor corner in place on a straightened crop", () => {
    const before = box(0.25, 0.3, 0.75, 0.7);
    const anchor = cropCorners(before, 15, ASPECT)[0] ?? [0, 0];
    const resized = resizeCrop({
      box: before,
      angle: 15,
      aspect: ASPECT,
      handle: "se",
      pointer: [0.6, 0.62],
    });
    const after = cropCorners(resized, 15, ASPECT)[0] ?? [0, 0];
    expect(after[0]).toBeCloseTo(anchor[0], 3);
    expect(after[1]).toBeCloseTo(anchor[1], 3);
    // And the grip lands where the pointer left it.
    const dragged = cropCorners(resized, 15, ASPECT)[2] ?? [0, 0];
    expect(dragged[0]).toBeCloseTo(0.6, 3);
    expect(dragged[1]).toBeCloseTo(0.62, 3);
  });

  test("holds the locked ratio whichever grip is dragged", () => {
    for (const handle of ["se", "w", "n"] as const) {
      const resized = resizeCrop({
        box: box(0.2, 0.2, 0.8, 0.8),
        angle: 0,
        aspect: ASPECT,
        handle,
        pointer: [0.45, 0.35],
        ratio: 1,
      });
      expect(cropRatio(resized, ASPECT)).toBeCloseTo(1, 3);
    }
  });

  test("never resizes the crop off the photo", () => {
    const resized = resizeCrop({
      box: box(0.3, 0.3, 0.6, 0.6),
      angle: 25,
      aspect: ASPECT,
      handle: "se",
      pointer: [1.4, 1.4],
    });
    expect(cropInsideImage(resized, 25, ASPECT)).toBe(true);
  });

  test("cannot be collapsed to nothing by dragging a grip past its opposite", () => {
    const resized = resizeCrop({
      box: box(0.2, 0.2, 0.8, 0.8),
      angle: 0,
      aspect: ASPECT,
      handle: "se",
      pointer: [0.05, 0.05],
    });
    expect(resized.right).toBeGreaterThan(resized.left);
    expect(resized.bottom).toBeGreaterThan(resized.top);
  });
});

describe("hit-testing the overlay", () => {
  const crop = box(0.2, 0.2, 0.8, 0.8);

  test("finds the corners, the edges, the inside and the outside", () => {
    expect(hit([0.2, 0.2], crop)).toBe("nw");
    expect(hit([0.8, 0.8], crop)).toBe("se");
    expect(hit([0.5, 0.2], crop)).toBe("n");
    expect(hit([0.8, 0.5], crop)).toBe("e");
    expect(hit([0.5, 0.5], crop)).toBe("move");
    expect(hit([0.05, 0.05], crop)).toBe("straighten");
  });

  test("a corner wins over the edge that shares it", () => {
    // Half a grip's tolerance in from the corner is still the corner, not the top edge.
    expect(hit([0.205, 0.2], crop)).toBe("nw");
  });

  test("follows the grips around when the crop is straightened", () => {
    const turned = 20;
    const corner = cropCorners(crop, turned, ASPECT)[1] ?? [0, 0];
    expect(hit(corner, crop, turned)).toBe("ne");
    // The unrotated corner is off the turned rect by more than a grip's radius.
    expect(hit([0.8, 0.2], crop, turned)).not.toBe("ne");
  });

  test("names a cursor for every grip", () => {
    expect(cursorFor("move")).toBe("move");
    expect(cursorFor("nw")).toBe("nwse-resize");
    expect(cursorFor("n")).toBe("ns-resize");
  });
});

describe("straighten by dragging a line", () => {
  test("a level drag is no rotation at all", () => {
    expect(straightenAngle([0.2, 0.5], [0.8, 0.5], ASPECT)).toBe(0);
  });

  test("turns the crop until the drawn line is one of its edges", () => {
    const start: Point = [0.2, 0.4];
    const end: Point = [0.8, 0.55];
    const angle = straightenAngle(start, end, ASPECT);
    expect(angle).not.toBe(0);
    const corners = cropCorners(box(0.3, 0.3, 0.7, 0.7), angle, ASPECT);
    const top = corners[1] ?? [0, 0];
    const left = corners[0] ?? [0, 0];
    const edge: Point = [(top[0] - left[0]) * ASPECT, top[1] - left[1]];
    const drag: Point = [(end[0] - start[0]) * ASPECT, end[1] - start[1]];
    // Parallel: the cross product of the two directions is zero.
    expect(edge[0] * drag[1] - edge[1] * drag[0]).toBeCloseTo(0, 6);
  });

  test("a near-vertical drag straightens the verticals instead of turning 90°", () => {
    const angle = straightenAngle([0.5, 0.2], [0.56, 0.8], ASPECT);
    expect(Math.abs(angle)).toBeLessThanOrEqual(45);
    expect(Math.abs(angle)).toBeLessThan(20);
  });

  test("never leaves the op's range", () => {
    for (const end of [
      [0.9, 0.05],
      [0.1, 0.95],
      [0.5, 0.9],
    ] as Point[]) {
      const angle = straightenAngle([0.5, 0.5], end, ASPECT);
      expect(angle).toBeGreaterThanOrEqual(-45);
      expect(angle).toBeLessThanOrEqual(45);
    }
  });
});

describe("aspect presets", () => {
  test("Original is the photo's own ratio and Custom is none", () => {
    expect(ratioOf("original", ASPECT, FULL_CROP, false)).toBeCloseTo(ASPECT, 6);
    expect(ratioOf("free", ASPECT, FULL_CROP, false)).toBeUndefined();
  });

  test("As Shot keeps the crop that is already there", () => {
    const crop = box(0.1, 0.2, 0.6, 0.7);
    expect(ratioOf("asShot", ASPECT, crop, false)).toBeCloseTo(cropRatio(crop, ASPECT), 6);
  });

  test("the orientation toggle stands the ratio on its end", () => {
    expect(ratioOf("16:9", ASPECT, FULL_CROP, true)).toBeCloseTo(9 / 16, 6);
  });

  test("every preset fits a crop with that ratio onto the photo", () => {
    for (const preset of ASPECT_PRESETS) {
      const ratio = ratioOf(preset.id, ASPECT, box(0.2, 0.2, 0.8, 0.8), false);
      const fitted = fitRatio(box(0.2, 0.2, 0.8, 0.8), 6, ASPECT, ratio);
      expect(cropInsideImage(fitted, 6, ASPECT)).toBe(true);
      if (ratio === undefined) continue;
      expect(cropRatio(fitted, ASPECT)).toBeCloseTo(ratio, 2);
    }
  });

  test("swapping the orientation inverts the crop's ratio", () => {
    const crop = box(0.2, 0.25, 0.8, 0.65);
    const swapped = swapOrientation(crop, 0, ASPECT);
    expect(cropRatio(swapped, ASPECT)).toBeCloseTo(1 / cropRatio(crop, ASPECT), 2);
  });
});

describe("the tool's shortcuts", () => {
  const event = {
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: null,
  };

  test("R toggles, Escape leaves, X swaps", () => {
    expect(cropShortcut({ ...event, key: "r" })).toBe("toggleTool");
    expect(cropShortcut({ ...event, key: "R" })).toBe("toggleTool");
    expect(cropShortcut({ ...event, key: "Escape" })).toBe("leaveTool");
    expect(cropShortcut({ ...event, key: "x" })).toBe("swapOrientation");
    expect(cropShortcut({ ...event, key: "q" })).toBeNull();
  });

  test("is not a shortcut inside a text field or under a modifier", () => {
    const field = { tagName: "INPUT", isContentEditable: false };
    expect(cropShortcut({ ...event, key: "r", target: field })).toBeNull();
    expect(cropShortcut({ ...event, key: "r", ctrlKey: true })).toBeNull();
  });
});
