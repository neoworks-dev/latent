<script lang="ts">
  // The Crop column and the overlay it draws. The column is only mounted while the rail is
  // on "crop", so attaching the painter and the pointer handler here — with their inverses
  // — is also what arms and disarms the tool, and mounting is what switches the viewer to
  // the uncropped frame.
  import { kernelContext, type OverlayPointer, type OverlayRect } from "@latent/contracts";
  import { Slider, ValueField } from "@latent/plugin-panels";
  import type { OpParamSpec } from "@latent/protocol";
  import { Button, Select, Tooltip } from "@neoworks-dev/ui";
  import ArrowClockwiseIcon from "phosphor-svelte/lib/ArrowClockwiseIcon";
  import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
  import ArrowsHorizontalIcon from "phosphor-svelte/lib/ArrowsHorizontalIcon";
  import ArrowsVerticalIcon from "phosphor-svelte/lib/ArrowsVerticalIcon";
  import FrameCornersIcon from "phosphor-svelte/lib/FrameCornersIcon";
  import LockIcon from "phosphor-svelte/lib/LockIcon";
  import LockOpenIcon from "phosphor-svelte/lib/LockOpenIcon";
  import {
    ASPECT_PRESETS,
    type CropBox,
    type CropHandle,
    cropCorners,
    cropEdgePoints,
    cropPoint,
    cropShortcut,
    cursorFor,
    handleAt,
    moveCrop,
    type Point,
    resizeCrop,
    straightenAngle,
  } from "./crop";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const crop = ctx.crop;
  const viewer = ctx.viewer;

  /** Straighten is `crop.angle`: the same slider the generated Geometry panel draws. */
  const angleSpec: OpParamSpec = {
    name: "angle",
    label: "Straighten",
    type: "number",
    min: -45,
    max: 45,
    step: 0.1,
    default: 0,
    unit: "°",
    display: { kind: "slider" },
  };
  const angleRange = { min: -45, max: 45, step: 0.1 };
  const presetOptions = ASPECT_PRESETS.map((preset) => ({
    value: preset.id,
    label: preset.label,
  }));

  // The drag lives outside reactive state: it changes per pointer event and only the
  // overlay cares. `pending` is what the drag has produced so far — the overlay draws it
  // instead of the stack's rect, which is always one round trip behind the pointer.
  let drag: { handle: CropHandle; box: CropBox; start: Point; angle: number } | null = null;
  let pending: { box: CropBox; angle: number } | null = null;
  let hoverHandle = $state<CropHandle | null>(null);

  const ratioLabel = $derived(formatRatio(crop.currentRatio));
  // The drawn image's box on the overlay canvas. In the DOM because a driver aiming at a
  // grip has no other way to know where the photo is inside the letterboxed frame.
  const frameRect = $derived(viewer.overlay.rect);

  /** What the overlay draws: the drag so far, else what the engine last confirmed. */
  function paintBox(): CropBox {
    return pending?.box ?? crop.box;
  }

  function paintAngle(): number {
    return pending?.angle ?? crop.angle;
  }

  function formatRatio(ratio: number): string {
    if (!Number.isFinite(ratio) || ratio <= 0) return "—";
    return ratio >= 1 ? `${ratio.toFixed(2)} : 1` : `1 : ${(1 / ratio).toFixed(2)}`;
  }

  function toCanvas(point: Point, rect: OverlayRect): Point {
    return [rect.x + point[0] * rect.width, rect.y + point[1] * rect.height];
  }

  function drawOverlay(context: CanvasRenderingContext2D, rect: OverlayRect): void {
    if (rect.width <= 0 || rect.height <= 0) return;
    const corners = cropCorners(paintBox(), paintAngle(), crop.aspect).map((point) =>
      toCanvas(point, rect),
    );
    context.save();
    dimOutside(context, rect, corners);
    if (drag) drawThirds(context, rect);
    drawFrame(context, corners);
    drawHandles(context, rect, corners);
    context.restore();
  }

  /** Everything the crop throws away goes dark; the kept rectangle is a hole in it. */
  function dimOutside(
    context: CanvasRenderingContext2D,
    rect: OverlayRect,
    corners: Point[],
  ): void {
    context.beginPath();
    context.rect(rect.x, rect.y, rect.width, rect.height);
    for (const [index, corner] of corners.entries()) {
      if (index === 0) context.moveTo(corner[0], corner[1]);
      else context.lineTo(corner[0], corner[1]);
    }
    context.closePath();
    context.fillStyle = "rgba(0, 0, 0, 0.6)";
    context.fill("evenodd");
  }

  function drawFrame(context: CanvasRenderingContext2D, corners: Point[]): void {
    context.beginPath();
    for (const [index, corner] of corners.entries()) {
      if (index === 0) context.moveTo(corner[0], corner[1]);
      else context.lineTo(corner[0], corner[1]);
    }
    context.closePath();
    context.lineWidth = 1.5;
    context.strokeStyle = "rgba(255, 255, 255, 0.95)";
    context.stroke();
  }

  /** Lightroom's rule of thirds, drawn while a grip is held and gone as soon as it is not. */
  function drawThirds(context: CanvasRenderingContext2D, rect: OverlayRect): void {
    context.lineWidth = 1;
    context.strokeStyle = "rgba(255, 255, 255, 0.35)";
    const box = paintBox();
    const angle = paintAngle();
    for (const third of [1 / 3, 2 / 3]) {
      const columnTop = toCanvas(cropPoint(box, angle, crop.aspect, third, 0), rect);
      const columnBottom = toCanvas(cropPoint(box, angle, crop.aspect, third, 1), rect);
      const rowLeft = toCanvas(cropPoint(box, angle, crop.aspect, 0, third), rect);
      const rowRight = toCanvas(cropPoint(box, angle, crop.aspect, 1, third), rect);
      context.beginPath();
      context.moveTo(columnTop[0], columnTop[1]);
      context.lineTo(columnBottom[0], columnBottom[1]);
      context.moveTo(rowLeft[0], rowLeft[1]);
      context.lineTo(rowRight[0], rowRight[1]);
      context.stroke();
    }
  }

  function drawHandles(
    context: CanvasRenderingContext2D,
    rect: OverlayRect,
    corners: Point[],
  ): void {
    context.fillStyle = "rgba(255, 255, 255, 0.95)";
    for (const corner of corners) {
      context.fillRect(corner[0] - 4, corner[1] - 4, 8, 8);
    }
    for (const point of cropEdgePoints(paintBox(), paintAngle(), crop.aspect)) {
      const [x, y] = toCanvas(point, rect);
      context.fillRect(x - 3, y - 3, 6, 6);
    }
  }

  function onPointer(event: OverlayPointer): boolean {
    const point: Point = [event.x, event.y];
    if (event.kind === "wheel") return false;
    if (event.kind === "down") return onDown(point);
    if (!drag) {
      hoverHandle = grabAt(point);
      return false;
    }
    if (event.kind === "move") return onDrag(point, true);
    if (event.kind === "cancel") {
      drag = null;
      pending = null;
      crop.dragging = false;
      viewer.overlay.redraw();
      return true;
    }
    return onDrag(point, false);
  }

  function grabAt(point: Point): CropHandle {
    const rect = viewer.overlay.rect;
    return handleAt({
      point,
      box: paintBox(),
      angle: paintAngle(),
      aspect: crop.aspect,
      width: rect.width,
      height: rect.height,
      tolerance: 12,
    });
  }

  function onDown(point: Point): boolean {
    const handle = grabAt(point);
    drag = { handle, box: crop.box, start: point, angle: crop.angle };
    hoverHandle = handle;
    crop.dragging = true;
    return true;
  }

  function onDrag(point: Point, transient: boolean): boolean {
    const held = drag;
    if (!held) return false;
    if (held.handle === "straighten") {
      const next = straightenAngle(held.start, point, crop.aspect);
      pending = { box: held.box, angle: next };
      void commitAngle(next, transient);
    } else {
      const next = nextBox(held, point);
      pending = { box: next, angle: held.angle };
      void commitBox(next, transient);
    }
    viewer.overlay.redraw();
    if (transient) return true;
    drag = null;
    crop.dragging = false;
    return true;
  }

  function nextBox(
    held: { handle: CropHandle; box: CropBox; start: Point },
    point: Point,
  ): CropBox {
    if (held.handle === "move") {
      const delta: Point = [point[0] - held.start[0], point[1] - held.start[1]];
      return moveCrop(held.box, crop.angle, crop.aspect, delta);
    }
    return resizeCrop({
      box: held.box,
      angle: crop.angle,
      aspect: crop.aspect,
      handle: held.handle,
      pointer: point,
      ratio: crop.ratio,
    });
  }

  // The committed write is the one that snapshots, so the whole drag is one undo step —
  // the brush's rule. The pending rect is only dropped once the engine has the real one.
  async function commitBox(next: CropBox, transient: boolean): Promise<void> {
    await crop.setBox(next, transient);
    if (!transient) pending = null;
  }

  async function commitAngle(next: number, transient: boolean): Promise<void> {
    await crop.setAngle(next, transient);
    if (!transient) pending = null;
  }

  // The overlay: one painter, one pointer handler, both gone when the column closes.
  $effect(() => {
    const detachDraw = viewer.overlay.attachOverlay(drawOverlay);
    const detachPointer = viewer.overlay.onPointer(onPointer);
    return () => {
      detachDraw();
      detachPointer();
    };
  });

  // The painter is a plain function and nothing repaints it when the stack moves under it.
  // A drag asks for its own repaint; an aspect preset, the straighten readout and undo
  // change the rect with no new frame behind them, so reading the two here is what keeps
  // the overlay on the crop the engine holds.
  $effect(() => {
    void crop.box;
    void crop.angle;
    viewer.overlay.redraw();
  });

  // Mounting the column is entering the tool: the frames show the whole photo while it is
  // open and the cropped one again as soon as it is not.
  $effect(() => {
    crop.showUncropped(true);
    return () => crop.showUncropped(false);
  });

  // The grip under the pointer wears its own cursor; leaving the crop is the straighten
  // drag, which is a crosshair.
  $effect(() => {
    const handle = hoverHandle;
    if (!handle) return;
    return viewer.overlay.setCursor(cursorFor(handle));
  });

  // Esc leaves and X swaps the orientation, live only while this column is.
  $effect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const action = cropShortcut({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        target,
      });
      if (action !== "leaveTool" && action !== "swapOrientation") return;
      event.preventDefault();
      if (action === "leaveTool") crop.leave();
      else void crop.swapOrientation();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
</script>

<div
  class="flex flex-col gap-2 pb-4 text-xs"
  data-pane="crop"
  data-crop-left={crop.box.left}
  data-crop-top={crop.box.top}
  data-crop-right={crop.box.right}
  data-crop-bottom={crop.box.bottom}
  data-crop-angle={crop.angle}
  data-crop-frame={`${frameRect.x},${frameRect.y},${frameRect.width},${frameRect.height}`}
  data-crop-preset={crop.presetId}
  data-crop-locked={crop.locked}
  data-crop-swapped={crop.swapped}
>
  <div class="flex items-center gap-1 px-2">
    <span class="w-14 shrink-0 text-muted">Aspect</span>
    <div class="min-w-0 flex-1" data-crop-aspect>
      <!-- Lightroom's Aspect menu; picking one locks the ratio, Custom unlocks it. -->
      <Select
        value={crop.presetId}
        options={presetOptions}
        onChange={(value) => void crop.choosePreset(String(value))}
      />
    </div>
    <Tooltip text={crop.locked ? "Unlock the ratio" : "Constrain the ratio"} placement="left">
      <span data-crop-lock={crop.locked}>
        <Button
          size="sm"
          variant={crop.locked ? "surface" : "ghost"}
          icon={crop.locked ? LockIcon : LockOpenIcon}
          onclick={() => void crop.setLocked(!crop.locked)}
        />
      </span>
    </Tooltip>
    <Tooltip text="Swap orientation (X)" placement="left">
      <span data-crop-swap>
        <Button
          size="sm"
          variant="ghost"
          icon={FrameCornersIcon}
          onclick={() => void crop.swapOrientation()}
        />
      </span>
    </Tooltip>
  </div>

  <div class="flex items-center gap-2 px-3">
    <span class="w-14 shrink-0 text-muted">Straighten</span>
    <div class="min-w-0 flex-1">
      <Slider
        value={crop.angle}
        range={angleRange}
        label="Straighten"
        onInput={(next) => void crop.setAngle(next, true)}
        onCommit={(next) => void crop.setAngle(next, false)}
        onReset={() => void crop.setAngle(0, false)}
      />
    </div>
    <ValueField
      value={crop.angle}
      spec={angleSpec}
      range={angleRange}
      label="Straighten"
      onInput={(next) => void crop.setAngle(next, true)}
      onCommit={(next) => void crop.setAngle(next, false)}
    />
  </div>

  <div class="flex items-center gap-1 px-2" role="group" aria-label="Rotate and flip">
    <span class="w-14 shrink-0 text-muted">Rotate</span>
    <Tooltip text="Rotate left 90°" placement="top">
      <span data-crop-rotate="left">
        <Button
          size="sm"
          variant="ghost"
          icon={ArrowCounterClockwiseIcon}
          onclick={() => void crop.rotateBy(-1)}
        />
      </span>
    </Tooltip>
    <Tooltip text="Rotate right 90°" placement="top">
      <span data-crop-rotate="right">
        <Button
          size="sm"
          variant="ghost"
          icon={ArrowClockwiseIcon}
          onclick={() => void crop.rotateBy(1)}
        />
      </span>
    </Tooltip>
    <Tooltip text="Flip horizontal" placement="top">
      <span data-crop-flip="horizontal">
        <Button
          size="sm"
          variant={crop.flippedHorizontally ? "surface" : "ghost"}
          icon={ArrowsHorizontalIcon}
          onclick={() => void crop.flip("horizontal")}
        />
      </span>
    </Tooltip>
    <Tooltip text="Flip vertical" placement="top">
      <span data-crop-flip="vertical">
        <Button
          size="sm"
          variant={crop.flippedVertically ? "surface" : "ghost"}
          icon={ArrowsVerticalIcon}
          onclick={() => void crop.flip("vertical")}
        />
      </span>
    </Tooltip>
  </div>

  <div class="flex items-center justify-between gap-2 px-3">
    <span class="text-faint">
      Ratio <span data-crop-ratio>{ratioLabel}</span> · {crop.quadrant}°
    </span>
    <Button size="sm" variant="ghost" onclick={() => void crop.reset()}>Reset</Button>
  </div>

  <p class="px-3 text-[10px] text-faint">
    Drag inside to move, a grip to resize, outside the frame to straighten. R leaves the tool.
  </p>

  {#if crop.status}
    <p class="px-3 text-red" data-crop-status>{crop.status}</p>
  {/if}
</div>
