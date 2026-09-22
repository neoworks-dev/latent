<script lang="ts">
  // The Planes column: draw along one aircraft trail, let the engine find the rest, repaint
  // them, then do the same to every other photo of the night. The overlay work is a freehand
  // stroke and a tint.
  import {
    kernelContext,
    type OverlayMap,
    type OverlayPointer,
    type OverlayRect,
  } from "@latent/contracts";
  import { BoxedSlider } from "@latent/plugin-panels";
  import { Button, Checkbox, SectionHeader, Select } from "@neoworks-dev/ui";
  import {
    batchLabel,
    detectLabel,
    growRange,
    isRepaintBackend,
    minLengthRange,
    repaintBackends,
    seedFromStroke,
    seedIsUsable,
    sensitivityRange,
    type SeedPath,
  } from "./planes";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const planes = ctx.planes;
  const viewer = ctx.viewer;
  const catalog = ctx.catalog;

  type Point = [number, number];

  // The stroke under the pointer. Drawn here as it is made — the engine's answer is a round
  // trip away, and a line that only appears after it reads as a dropped gesture.
  let stroke = $state<SeedPath | null>(null);

  const others = $derived(catalog.selection.filter((id: number) => id !== viewer.photoId));
  const status = $derived(detectLabel(planes.op, planes.failure));

  function strokePath(context: CanvasRenderingContext2D, map: OverlayMap, path: SeedPath): void {
    const [first, ...rest] = path;
    if (!first) return;
    const at = map.toCanvas(first[0], first[1]);
    context.beginPath();
    context.moveTo(at.x, at.y);
    for (const point of rest) {
      const next = map.toCanvas(point[0], point[1]);
      context.lineTo(next.x, next.y);
    }
    context.stroke();
  }

  function drawOverlay(
    context: CanvasRenderingContext2D,
    rect: OverlayRect,
    map: OverlayMap,
  ): void {
    if (rect.width <= 0 || rect.height <= 0) return;
    const raster = planes.rasterCanvas;
    if (planes.showMask && raster) {
      // The raster is the engine's proxy size and letterboxed like the frame, so the blit
      // takes the photo's own rect out of it (the Masks column draws it the same way).
      const [sourceX, sourceY, sourceWidth, sourceHeight] = planes.rasterRect ?? [
        0,
        0,
        raster.width,
        raster.height,
      ];
      context.imageSmoothingEnabled = true;
      context.drawImage(
        raster,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
      );
    }
    context.save();
    context.lineWidth = 1.5;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "rgba(255, 255, 255, 0.9)";
    context.setLineDash([4, 3]);
    if (stroke) strokePath(context, map, stroke);
    else if (planes.seed) strokePath(context, map, planes.seed);
    context.restore();
  }

  function onPointer(event: OverlayPointer): boolean {
    if (event.kind === "wheel") return false;
    // Image space, not the drawn rect: the seed outlives a crop the same way a mask does.
    const point: Point = [event.imageX, event.imageY];
    if (event.kind === "down") {
      stroke = [point];
      return true;
    }
    if (!stroke) return false;
    if (event.kind === "move") {
      stroke = [...stroke, point];
      viewer.overlay.redraw();
      return true;
    }
    const drawn = [...stroke, point];
    stroke = null;
    viewer.overlay.redraw();
    if (event.kind === "cancel") return true;
    const seed = seedFromStroke(drawn);
    // A tap is not a stroke, and the detector would only answer that it has no direction.
    if (seedIsUsable(seed)) void planes.seedFrom(seed);
    return true;
  }

  function onBackend(value: string | string[]): void {
    if (typeof value === "string" && isRepaintBackend(value)) void planes.setBackend(value);
  }

  $effect(() => {
    const detachDraw = viewer.overlay.attachOverlay(drawOverlay);
    const detachPointer = viewer.overlay.onPointer(onPointer);
    const restoreCursor = viewer.overlay.setCursor("crosshair");
    return () => {
      detachDraw();
      detachPointer();
      restoreCursor();
    };
  });

  // The raster is view-space: it is re-asked for when the mask or the frame's geometry moved.
  $effect(() => {
    planes.syncPreview();
  });
</script>

<div class="flex flex-col gap-3 pb-3" data-pane="planes">
  <div>
    <SectionHeader title="Aircraft trails" />
    <p class="px-1 text-xs text-muted" data-planes-status>{status}</p>
    {#if planes.seed}
      <p class="px-1 pt-1 text-2xs text-faint" data-planes-seed={planes.seed.length}>
        Seed stroke, {planes.seed.length} points
      </p>
    {/if}
    <label class="flex items-center gap-2 px-1 pt-2 text-xs text-muted">
      <Checkbox
        checked={planes.showMask}
        onchange={() => (planes.showMask = !planes.showMask)}
        data-planes-option="showMask"
      />
      Show what was found
    </label>
  </div>

  {#if planes.seed}
    <div data-planes-section="tuning">
      <SectionHeader title="Detection" />
      <div class="px-1">
        <BoxedSlider
          value={planes.params.sensitivity}
          range={sensitivityRange}
          label="Sensitivity"
          onInput={(value: number) => void planes.setParam("sensitivity", value, true)}
          onCommit={(value: number) => void planes.setParam("sensitivity", value, false)}
          onReset={() => void planes.setParam("sensitivity", 50, false)}
        />
      </div>
      <div class="px-1 pt-2">
        <BoxedSlider
          value={planes.params.minLength}
          range={minLengthRange}
          label="Min length"
          onInput={(value: number) => void planes.setParam("minLength", value, true)}
          onCommit={(value: number) => void planes.setParam("minLength", value, false)}
          onReset={() => void planes.setParam("minLength", 10, false)}
        />
      </div>
      <div class="px-1 pt-2">
        <BoxedSlider
          value={planes.params.grow}
          range={growRange}
          label="Grow"
          onInput={(value: number) => void planes.setParam("grow", value, true)}
          onCommit={(value: number) => void planes.setParam("grow", value, false)}
          onReset={() => void planes.setParam("grow", 25, false)}
        />
      </div>
      <div class="px-1 pt-2" data-planes-backend={planes.backend}>
        <span class="text-2xs text-dim">Repaint with</span>
        <div class="mt-1">
          <Select value={planes.backend} options={repaintBackends} onChange={onBackend} />
        </div>
        <p class="pt-1 text-2xs text-dim">
          {planes.backend === "sky"
            ? "Interpolates the surrounding sky. Needs nothing running."
            : "SDXL inpaint through ComfyUI. Needs the server up."}
        </p>
      </div>
      <div class="flex gap-2 px-1 pt-2">
        <span data-planes-detect>
          <Button
            size="sm"
            variant="ghost"
            disabled={planes.detecting}
            onclick={() => void planes.detect()}
          >
            Detect again
          </Button>
        </span>
        <span data-planes-remove>
          <Button
            size="sm"
            variant="primary"
            disabled={!planes.detected || planes.removing}
            onclick={() => void planes.removePlanes()}
          >
            Remove trails
          </Button>
        </span>
      </div>
      {#if planes.removing}
        <p class="px-1 pt-1 text-2xs text-dim" data-planes-removing>
          {planes.removeNote || "repainting"}
        </p>
      {/if}
    </div>

    <div data-planes-section="batch">
      <SectionHeader title="Rest of the sequence" />
      <p class="px-1 text-2xs text-faint">
        Every photo detects its own trails from these settings — the mask is not copied, the search
        is.
      </p>
      <label class="flex items-center gap-2 px-1 pt-1 text-xs text-muted">
        <Checkbox
          checked={planes.batchRemoves}
          onchange={() => (planes.batchRemoves = !planes.batchRemoves)}
          data-planes-option="batchRemoves"
        />
        Repaint as well as detect
      </label>
      <div class="flex gap-2 px-1 pt-2">
        <span data-planes-apply={others.length}>
          <Button
            size="sm"
            variant="ghost"
            disabled={others.length === 0 || planes.batch !== null}
            onclick={() => void planes.applyToSelection()}
          >
            Apply to {others.length} selected
          </Button>
        </span>
        {#if planes.batch && planes.batch.done < planes.batch.total}
          <Button size="sm" variant="ghost" onclick={() => planes.cancelBatch()}>Stop</Button>
        {/if}
      </div>
      {#if planes.batch}
        <p class="px-1 pt-1 text-2xs text-dim" data-planes-batch={planes.batch.done}>
          {batchLabel(planes.batch)}
        </p>
      {/if}
    </div>
  {/if}

  {#if planes.error}
    <p class="px-1 text-xs text-red" data-planes-error>{planes.error}</p>
  {/if}
</div>
