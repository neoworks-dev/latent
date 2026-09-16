// The Crop column's own state: whether the tool is open, which aspect preset is on, and
// the writes that go to the geometry ops. The crop itself is not held here — it is the
// `crop` op in the engine's stack, read back through the viewer's mirror, exactly like
// every other edit.
import type { GeometryView, PaneRegistry, ViewerService } from "@latent/contracts";
import type { Op } from "@latent/protocol";
import {
  type CropBox,
  constrainCrop,
  cropRatio,
  fitRatio,
  FULL_CROP,
  MAX_ANGLE,
  ratioOf,
  swapOrientation,
} from "./crop";

/** The rail mode this tool owns; `panes.setMode` is how it is entered and left. */
export const CROP_MODE = "crop";

function paramOf(op: Op | undefined, name: string, fallback: number): number {
  const value = op?.params[name];
  return typeof value === "number" ? value : fallback;
}

function flagOf(op: Op | undefined, name: string): boolean {
  return op?.params[name] === true;
}

export class CropState {
  /** The aspect preset, one of `ASPECT_PRESETS`. */
  presetId = $state("free");
  /** Lightroom's lock: a locked ratio holds through every resize. */
  locked = $state(false);
  /** The orientation toggle — the same ratio stood on its end. */
  swapped = $state(false);
  /** True while a grip is held: that is when the rule-of-thirds grid is drawn. */
  dragging = $state(false);
  status = $state("");

  constructor(
    private readonly viewer: ViewerService,
    private readonly geometryView: GeometryView,
    private readonly panes: PaneRegistry,
  ) {}

  /** The tool is open exactly when the rail is on it; the rail is the one truth. */
  get active(): boolean {
    return this.panes.mode === CROP_MODE;
  }

  private op(name: string): Op | undefined {
    return this.viewer.stack.find((entry) => entry.op === name);
  }

  /** The crop op's rect, or the whole image when there is no crop op yet. */
  get box(): CropBox {
    const crop = this.op("crop");
    if (!crop) return FULL_CROP;
    return {
      left: paramOf(crop, "left", 0),
      top: paramOf(crop, "top", 0),
      right: paramOf(crop, "right", 1),
      bottom: paramOf(crop, "bottom", 1),
    };
  }

  get angle(): number {
    return paramOf(this.op("crop"), "angle", 0);
  }

  get quadrant(): number {
    return paramOf(this.op("rotate"), "value", 0);
  }

  get flippedHorizontally(): boolean {
    return flagOf(this.op("flip"), "horizontal");
  }

  get flippedVertically(): boolean {
    return flagOf(this.op("flip"), "vertical");
  }

  /**
   * The image's own aspect as the viewer is drawing it. While the tool is open the engine
   * renders with `geometry: "full"`, so the overlay's rect is the whole photo and its
   * shape is what every constraint is measured against.
   */
  get aspect(): number {
    const rect = this.viewer.overlay.rect;
    if (rect.width <= 0 || rect.height <= 0) return 1;
    return rect.width / rect.height;
  }

  /** The ratio a resize has to hold, or undefined while the crop is free. */
  get ratio(): number | undefined {
    if (!this.locked) return undefined;
    return ratioOf(this.presetId, this.aspect, this.box, this.swapped);
  }

  /** What the crop currently is, for the readout. */
  get currentRatio(): number {
    return cropRatio(this.box, this.aspect);
  }

  enter(): void {
    this.panes.setMode(CROP_MODE);
  }

  leave(): void {
    if (!this.active) return;
    this.panes.setMode("edit");
  }

  toggle(): void {
    if (this.active) this.leave();
    else this.enter();
  }

  /**
   * Entering shows the uncropped image so the user can see what is being cut away;
   * leaving puts the cropped frame back. Called from the pane's mount and unmount, so the
   * rail is what drives it.
   */
  showUncropped(uncropped: boolean): void {
    this.geometryView.setGeometry(uncropped ? "full" : "stack");
  }

  /** The rect, mid-drag or committed. Always constrained before it goes out. */
  async setBox(box: CropBox, transient: boolean): Promise<void> {
    const fitted = constrainCrop(box, this.angle, this.aspect);
    await this.write(
      {
        left: fitted.left,
        top: fitted.top,
        right: fitted.right,
        bottom: fitted.bottom,
      },
      transient,
    );
  }

  /**
   * Straighten. The crop turns against the image, so it can end up hanging off the photo:
   * the rect is re-fitted in the same write rather than in a second one the undo stack
   * would have to hold separately.
   */
  async setAngle(angle: number, transient: boolean): Promise<void> {
    const clamped = Math.min(MAX_ANGLE, Math.max(-MAX_ANGLE, angle));
    const fitted = constrainCrop(this.box, clamped, this.aspect);
    await this.write(
      {
        angle: clamped,
        left: fitted.left,
        top: fitted.top,
        right: fitted.right,
        bottom: fitted.bottom,
      },
      transient,
    );
  }

  /** An aspect preset: the biggest crop with that ratio that still fits, and the lock on. */
  async choosePreset(presetId: string): Promise<void> {
    this.presetId = presetId;
    if (presetId === "free") {
      this.locked = false;
      return;
    }
    this.locked = true;
    await this.applyRatio();
  }

  async setLocked(locked: boolean): Promise<void> {
    this.locked = locked;
    if (locked) await this.applyRatio();
  }

  /** `X`. With a preset on it flips the preset; free-form it turns the rect on its side. */
  async swapOrientation(): Promise<void> {
    this.swapped = !this.swapped;
    if (this.locked) {
      await this.applyRatio();
      return;
    }
    await this.setBox(swapOrientation(this.box, this.angle, this.aspect), false);
  }

  private async applyRatio(): Promise<void> {
    const ratio = this.ratio;
    if (ratio === undefined) return;
    await this.setBox(fitRatio(this.box, this.angle, this.aspect, ratio), false);
  }

  /** The 90° buttons: one `rotate` op, its value walked a quarter turn at a time. */
  async rotateBy(quarters: number): Promise<void> {
    const next = (((this.quadrant / 90 + quarters) % 4) + 4) % 4;
    await this.viewer.setParam("rotate", { value: next * 90 }, false);
  }

  async flip(axis: "horizontal" | "vertical"): Promise<void> {
    const current = axis === "horizontal" ? this.flippedHorizontally : this.flippedVertically;
    await this.viewer.setParam("flip", { [axis]: !current }, false);
  }

  /** Reset: the whole photo, level, and every geometry op that exists back to neutral. */
  async reset(): Promise<void> {
    this.presetId = "free";
    this.locked = false;
    this.swapped = false;
    await this.write({ ...FULL_CROP, angle: 0 }, false);
    const rotate = this.op("rotate");
    if (rotate) await this.viewer.setOpParams(rotate.id, { value: 0 }, false);
    const flip = this.op("flip");
    if (flip) {
      await this.viewer.setOpParams(flip.id, { horizontal: false, vertical: false }, false);
    }
  }

  private async write(params: Record<string, number>, transient: boolean): Promise<void> {
    try {
      await this.viewer.setParam("crop", params, transient);
      this.status = "";
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    }
  }
}
