<script lang="ts">
  // The Masks panel, and the tools it draws on the viewer's overlay. It is the rail's
  // flyout: only mounted while it is open, so attaching the overlay and the shortcuts here —
  // with their inverses — is also what arms and disarms the tools.
  //
  // The adjustments of a mask are not drawn here. Selecting a mask aims the Edit column at
  // it (`ViewerService.maskTarget`), which is why this panel floats beside that column
  // instead of replacing it: pick the region here, move the sliders there.
  import {
    kernelContext,
    type OverlayMap,
    type OverlayPointer,
    type OverlayRect,
  } from "@latent/contracts";
  import { ValueField } from "@latent/plugin-panels";
  import type { MaskComponentKind } from "@latent/protocol";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import EyeIcon from "phosphor-svelte/lib/EyeIcon";
  import EyeSlashIcon from "phosphor-svelte/lib/EyeSlashIcon";
  import ImageIcon from "phosphor-svelte/lib/ImageIcon";
  import TrashIcon from "phosphor-svelte/lib/TrashIcon";
  import ComponentRow from "./ComponentRow.svelte";
  import KindIcon from "./KindIcon.svelte";
  import {
    coverageLabel,
    kindSpec,
    kindSpecs,
    layerLabel,
    maskShortcut,
    opacitySpec,
    tintStyle,
  } from "./masks";
  import BrushOptions from "./BrushOptions.svelte";
  import {
    boxFromDrag,
    boxPoints,
    brushSizeAfterStep,
    brushSizeAfterWheel,
    ellipsePoints,
    linearFromDrag,
    radialFromDrag,
    strokeImagePath,
    type Point,
  } from "./tools";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const masks = ctx.masks;
  const viewer = ctx.viewer;
  const panels = ctx.panels;

  const layer = $derived(masks.layer);
  const layers = $derived(masks.layers);
  const components = $derived(masks.components);
  const adjustments = $derived(masks.adjustments);
  const opacity = $derived(layer?.opacity ?? 100);
  let askingText = $state(false);
  // Drag and hover live outside reactive state: they change per pointer event and only the
  // overlay canvas cares, so they repaint it instead of re-rendering the column.
  let drag: { start: Point; current: Point } | null = null;
  let hover: Point | null = null;

  /** Adds a component of this kind to the selected mask; `text` asks for its words first. */
  function addKind(kind: MaskComponentKind): void {
    askingText = kind === "text";
    if (askingText) return;
    void masks.createComponent(kind);
  }

  /** The icon whose gesture the overlay is waiting for: a drag there lands in that kind. */
  function armed(kind: MaskComponentKind): boolean {
    const tool = kindSpec(kind).tool;
    return tool !== "none" && masks.tool === tool;
  }

  async function createText(): Promise<void> {
    masks.textPrompt = masks.textPrompt.trim();
    if (masks.textPrompt === "") return;
    const component = await masks.createComponent("text");
    askingText = false;
    if (component) await masks.detect(component.id, { prompt: masks.textPrompt });
  }

  // Shapes are stored in image space and drawn through `map`, so a crop, a straighten or a
  // zoom moves the handles with the picture instead of leaving them behind.
  function drawOverlay(
    context: CanvasRenderingContext2D,
    rect: OverlayRect,
    map: OverlayMap,
  ): void {
    if (rect.width <= 0 || rect.height <= 0) return;
    if (masks.overlayVisible && !viewer.adjusting) {
      drawTint(context, rect);
      drawLiveStroke(context, map);
    }
    drawTools(context, map);
  }

  /**
   * The stroke under the pointer, drawn here rather than waited for: the engine's raster is
   * a round trip behind the brush, and the whole of that round trip is the frame on the
   * socket. It is replaced by the engine's own coverage as soon as that lands.
   */
  function drawLiveStroke(context: CanvasRenderingContext2D, map: OverlayMap): void {
    const points = masks.livePoints;
    const [first] = points;
    if (!first) return;
    const { color, alpha } = tintStyle(masks.tint);
    const at = map.toCanvas(first[0], first[1]);
    context.save();
    context.setLineDash([]);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(2, masks.brushSize * map.scale);
    context.strokeStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
    context.beginPath();
    context.moveTo(at.x, at.y);
    for (const point of points.slice(1)) {
      const next = map.toCanvas(point[0], point[1]);
      context.lineTo(next.x, next.y);
    }
    // A press that has not moved yet is a dot, which `stroke` alone would not draw.
    if (points.length === 1) context.lineTo(at.x + 0.01, at.y);
    context.stroke();
    context.restore();
  }

  function drawTint(context: CanvasRenderingContext2D, rect: OverlayRect): void {
    const raster = masks.rasterCanvas;
    if (!raster) return;
    const style = tintStyle(masks.tint);
    if (style.wash) {
      const [r, g, b, a] = style.wash;
      context.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    // The raster is the engine's proxy size, not the canvas': one scaled blit, no resample
    // in JS. Smoothing keeps a 512-px mask from looking like a checkerboard. The source is
    // the photo's rect inside the raster — the raster is letterboxed like the frame, and
    // `rect` is already the drawn photo, so blitting all of it would stretch the mask.
    const [sourceX, sourceY, sourceWidth, sourceHeight] = masks.rasterRect ?? [
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

  function drawTools(context: CanvasRenderingContext2D, map: OverlayMap): void {
    context.save();
    context.lineWidth = 1.5;
    context.strokeStyle = "rgba(255, 255, 255, 0.9)";
    context.setLineDash([4, 3]);
    if (drag && masks.tool === "radial") strokeEllipse(context, map, drag.start, drag.current);
    if (drag && masks.tool === "linear") strokeLine(context, map, drag.start, drag.current);
    if (drag && masks.tool === "box") strokeBox(context, map, drag.start, drag.current);
    if (!drag) strokeSelected(context, map);
    if (masks.tool === "brush" && hover) strokeBrush(context, map, hover);
    context.restore();
  }

  /** The selected gradient's own handles, so it can be re-dragged without re-creating it. */
  function strokeSelected(context: CanvasRenderingContext2D, map: OverlayMap): void {
    const component = masks.selectedComponent;
    if (!component) return;
    const params = component.params ?? {};
    if (component.kind === "radial") {
      const center = (params.center ?? [0.5, 0.5]) as Point;
      const radius = (params.radius ?? [0.25, 0.25]) as Point;
      const angle = typeof params.angle === "number" ? params.angle : 0;
      strokeImagePath(context, map, ellipsePoints(center, radius, angle));
      for (const at of [
        center,
        [center[0] + radius[0], center[1]],
        [center[0], center[1] + radius[1]],
      ] as Point[]) {
        const canvas = map.toCanvas(at[0], at[1]);
        handle(context, canvas.x, canvas.y);
      }
    }
    if (component.kind === "linear") {
      const start = (params.start ?? [0.5, 0.25]) as Point;
      const end = (params.end ?? [0.5, 0.75]) as Point;
      strokeLine(context, map, start, end);
    }
  }

  function strokeEllipse(
    context: CanvasRenderingContext2D,
    map: OverlayMap,
    start: Point,
    current: Point,
  ): void {
    const rx = Math.max(1e-4, Math.abs(current[0] - start[0]));
    const ry = Math.max(1e-4, Math.abs(current[1] - start[1]));
    strokeImagePath(context, map, ellipsePoints(start, [rx, ry]));
  }

  function strokeLine(
    context: CanvasRenderingContext2D,
    map: OverlayMap,
    start: Point,
    end: Point,
  ): void {
    strokeImagePath(context, map, [start, end], false);
    const from = map.toCanvas(start[0], start[1]);
    const to = map.toCanvas(end[0], end[1]);
    handle(context, from.x, from.y);
    handle(context, to.x, to.y);
  }

  function strokeBox(
    context: CanvasRenderingContext2D,
    map: OverlayMap,
    start: Point,
    current: Point,
  ): void {
    strokeImagePath(context, map, boxPoints(boxFromDrag(start, current)));
  }

  function strokeBrush(context: CanvasRenderingContext2D, map: OverlayMap, point: Point): void {
    // The diameter is a fraction of the image's long edge, so the cursor grows with a crop
    // or a zoom exactly as the painted stroke does.
    const radius = (masks.brushSize * map.scale) / 2;
    const at = map.toCanvas(point[0], point[1]);
    context.setLineDash([]);
    context.beginPath();
    context.arc(at.x, at.y, Math.max(2, radius), 0, Math.PI * 2);
    context.stroke();
  }

  function handle(context: CanvasRenderingContext2D, x: number, y: number): void {
    context.save();
    context.setLineDash([]);
    context.fillStyle = "rgba(255, 255, 255, 0.95)";
    context.beginPath();
    context.arc(x, y, 3.5, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  function onPointer(event: OverlayPointer): boolean {
    if (event.kind === "wheel") return onWheel(event);
    // Image space, not the drawn rect: a mask component's coordinates outlive the crop.
    const point: Point = [event.imageX, event.imageY];
    hover = point;
    viewer.overlay.redraw();
    const tool = masks.tool;
    if (tool === "none") return false;
    if (tool === "brush") return onBrush(event, point);
    if (event.kind === "down") {
      drag = { start: point, current: point };
      return true;
    }
    if (!drag) return false;
    if (event.kind === "move") {
      drag = { start: drag.start, current: point };
      return true;
    }
    const finished = drag;
    drag = null;
    if (event.kind === "cancel") return true;
    void commitDrag(finished.start, point);
    return true;
  }

  function onWheel(event: OverlayPointer): boolean {
    if (masks.tool !== "brush") return false;
    masks.brushSize = brushSizeAfterWheel(masks.brushSize, event.deltaY);
    viewer.overlay.redraw();
    return true;
  }

  function onBrush(event: OverlayPointer, point: Point): boolean {
    const component = masks.selectedComponent;
    if (event.kind === "down") {
      // Alt is the erase modifier, the same one Lightroom uses.
      if (component?.kind === "brush")
        masks.beginStroke(component.id, event.altKey || masks.brushErasing);
      else void startFreshBrush(event.altKey);
      masks.addStrokePoint(point);
      return true;
    }
    if (event.kind === "move") {
      if (event.buttons === 0) return true;
      masks.addStrokePoint(point);
      return true;
    }
    void masks.endStroke();
    return true;
  }

  /** Painting with no brush component selected makes one, then paints into it. */
  async function startFreshBrush(erasing: boolean): Promise<void> {
    const component = await masks.createComponent("brush");
    if (component) masks.beginStroke(component.id, erasing || masks.brushErasing);
  }

  async function commitDrag(start: Point, end: Point): Promise<void> {
    const component = masks.selectedComponent;
    const tool = masks.tool;
    if (tool === "radial") {
      const params = radialFromDrag(start, end);
      if (component?.kind === "radial") await masks.patchParams(component.id, params);
      else await createFromDrag("radial", params);
      return;
    }
    if (tool === "linear") {
      const params = linearFromDrag(start, end);
      if (component?.kind === "linear") await masks.patchParams(component.id, params);
      else await createFromDrag("linear", params);
      return;
    }
    if (tool !== "box") return;
    const box = boxFromDrag(start, end);
    const target =
      component?.kind === "objects" ? component : await masks.createComponent("objects");
    if (!target) return;
    await masks.patchParams(target.id, { box });
    // The box is the hint the detector runs on; the engine stores it back on success.
    await masks.detect(target.id, { box });
  }

  async function createFromDrag(
    kind: MaskComponentKind,
    params: Record<string, unknown>,
  ): Promise<void> {
    const created = await masks.createComponent(kind);
    if (created) await masks.patchParams(created.id, params);
  }

  // The overlay: one painter, one pointer handler, both removed when the column closes.
  $effect(() => {
    const detachDraw = viewer.overlay.attachOverlay(drawOverlay);
    const detachPointer = viewer.overlay.onPointer(onPointer);
    return () => {
      detachDraw();
      detachPointer();
    };
  });

  // A tool that owns the pointer says so with the cursor; the brush draws its own circle.
  $effect(() => {
    const tool = masks.tool;
    if (tool === "none") return;
    return viewer.overlay.setCursor(tool === "brush" ? "none" : "crosshair");
  });

  // O, Shift+O and the brackets, live only while this column is.
  $effect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const action = maskShortcut({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        target,
      });
      if (!action) return;
      event.preventDefault();
      if (action === "toggleOverlay") masks.toggleOverlay();
      if (action === "cycleTint") masks.cycleTint();
      if (action === "brushSmaller") masks.brushSize = brushSizeAfterStep(masks.brushSize, -1);
      if (action === "brushLarger") masks.brushSize = brushSizeAfterStep(masks.brushSize, 1);
      viewer.overlay.redraw();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // The painter is a plain function, so the tint's hide and return is repainted from here.
  $effect(() => {
    void viewer.adjusting;
    viewer.overlay.redraw();
  });

  // The preview follows the stack: it re-asks when this op's mask changed and not otherwise.
  $effect(() => {
    masks.syncPreview();
  });

  // Closing the panel aims the Edit column back at the photo. Nothing else clears the
  // target, and a slider that writes into a mask has to have that mask on screen.
  $effect(() => () => masks.selectPhoto());
</script>

<div
  class="flex flex-col pb-4 text-xs"
  data-pane="masks"
  data-mask-coverage={masks.coverage.toFixed(4)}
  data-mask-tint={masks.tint}
  data-mask-overlay={masks.overlayVisible}
  data-mask-op={layer?.id ?? ""}
>
  <!-- The photo, then every mask of it. Clicking a mask leaves it selected: from then on the
       Edit column's sliders write into that mask, until the photo row above takes the
       selection back or the panel is closed. -->
  <ul class="flex flex-col border-b border-line-faint" data-mask-layers>
    <li class="flex items-center gap-1 px-1.5 py-0.5">
      <span class="px-2 text-faint"><ImageIcon size={13} weight="bold" /></span>
      <button
        type="button"
        class="min-w-0 flex-1 truncate rounded-sm px-1 py-1 text-left transition-colors
               hover:bg-hover"
        class:text-default={!layer}
        class:text-muted={Boolean(layer)}
        data-mask-layer-select="photo"
        data-selected={!layer}
        onclick={() => masks.selectPhoto()}
      >
        Whole photo
      </button>
    </li>
    {#each layers as entry, index (entry.id)}
      <li class="flex items-center gap-1 px-1.5 py-0.5" data-mask-layer={entry.id}>
        <Button
          size="sm"
          variant="ghost"
          icon={entry.enabled ? EyeIcon : EyeSlashIcon}
          onclick={() => void viewer.setEnabled(entry.id, !entry.enabled)}
        />
        <button
          type="button"
          class="min-w-0 flex-1 truncate rounded-sm px-1 py-1 text-left transition-colors
                 hover:bg-hover"
          class:bg-raised={entry.id === layer?.id}
          class:text-default={entry.id === layer?.id}
          class:text-muted={entry.id !== layer?.id}
          data-mask-layer-select={entry.id}
          data-selected={entry.id === layer?.id}
          onclick={() => masks.selectLayer(entry.id)}
        >
          {layerLabel(entry, index)}
        </button>
        <Tooltip text="Adjustments in this mask" placement="left">
          <span class="text-[10px] text-faint tabular-nums">
            {(entry.ops ?? []).length}
          </span>
        </Tooltip>
        <Tooltip text="Delete mask" placement="left">
          <Button
            size="sm"
            variant="ghost"
            icon={TrashIcon}
            onclick={() => void masks.removeLayer(entry.id)}
          />
        </Tooltip>
      </li>
    {/each}
  </ul>

  {#if !layer}
    <p class="px-3 pb-2 text-faint">
      A mask is a region and the adjustments inside it. Add one with + above, and while it is
      selected the Edit panel's sliders apply to it instead of to the photo.
    </p>
  {:else}
    <div class="flex items-center justify-between gap-2 px-3 py-1">
      <span class="text-muted">Opacity</span>
      <ValueField
        value={opacity}
        spec={opacitySpec}
        range={{ min: 0, max: 100, step: 1 }}
        label="Layer opacity"
        onInput={(next) => void viewer.setOpacity(layer.id, next, true)}
        onCommit={(next) => void viewer.setOpacity(layer.id, next, false)}
      />
    </div>

    <!-- Add to this mask, one click per kind: select the subject, then brush the rest of it
         in. Every kind is here in the menu's order — AI on the first row, tools and ranges on
         the second — on a fixed grid so the two rows line up column for column. -->
    <div class="flex flex-col gap-1 border-t border-line-faint px-2 py-1.5" data-add-component>
      <span class="px-1 text-[10px] text-faint">Add to this mask</span>
      <div class="grid w-fit grid-cols-6 gap-1" role="group" aria-label="Add to this mask">
        {#each kindSpecs as spec (spec.kind)}
          <Tooltip text={spec.label} placement="top">
            <button
              type="button"
              class="rounded-sm p-1.5 text-muted transition-colors hover:bg-hover
                     hover:text-default"
              class:bg-raised={armed(spec.kind)}
              class:text-default={armed(spec.kind)}
              aria-label={spec.label}
              data-add-kind={spec.kind}
              data-active={armed(spec.kind)}
              onclick={() => addKind(spec.kind)}
            >
              <KindIcon kind={spec.kind} size={14} />
            </button>
          </Tooltip>
        {/each}
      </div>
    </div>

    {#if askingText}
      <!-- `text` is the one kind that needs a word from the user before it can run. -->
      <form
        class="flex items-center gap-1 px-2 pb-1.5"
        onsubmit={(event) => {
          event.preventDefault();
          void createText();
        }}
      >
        <input
          class="min-w-0 flex-1 rounded-sm border border-line-strong bg-input px-1.5 py-1
                 text-xs text-default"
          placeholder="What to select, e.g. the cat"
          bind:value={masks.textPrompt}
          data-text-prompt
        />
        <Button size="sm" type="submit">Detect</Button>
      </form>
    {/if}

    <BrushOptions />

    {#if components.length === 0}
      <p class="px-3 py-2 text-faint">No region yet — pick one above.</p>
    {:else}
      <!-- What the mask is made of, bottom-up. Each one adds to, subtracts from or
           intersects the ones before it, and the line under them is what they come to: one
           mask, which is the only thing the render ever sees. -->
      <p class="px-3 pt-2 pb-1 text-[10px] text-faint">Layers of this mask</p>
      <ul class="flex flex-col border-b border-line" data-mask-components>
        {#each components as component (component.id)}
          <ComponentRow {component} />
        {/each}
      </ul>
      <p class="flex items-center gap-1.5 px-3 py-1 text-[10px] text-faint" data-mask-merged>
        <KindIcon kind={components[0]?.kind ?? "brush"} size={11} />
        <span>
          Merged: {components.length}
          {components.length === 1 ? "layer" : "layers"} covering
          <span data-coverage-label>{coverageLabel(masks.coverage)}</span> of the frame
          {#if masks.previewing}· updating{/if}
        </span>
      </p>
    {/if}

    {#if masks.status}
      <p class="px-3 py-1 text-red" data-mask-status>{masks.status}</p>
    {/if}

    <!-- What this mask adjusts. The sliders are the Edit column's — moving one there while
         this mask is selected adds it here — so these rows only say what is in the mask and
         let it be taken back out. -->
    <div class="border-t border-line" data-mask-adjustments>
      <p class="px-3 pt-2 pb-1 text-[10px] text-faint">Adjustments in this mask</p>
      {#each adjustments as entry (entry.id)}
        <div class="flex items-center gap-1 px-3 py-0.5" data-mask-adjustment={entry.op}>
          <span class="min-w-0 flex-1 truncate text-muted">
            {panels.ops.find((spec) => spec.name === entry.op)?.label ?? entry.op}
          </span>
          <Tooltip text="Remove from this mask" placement="left">
            <Button
              size="sm"
              variant="ghost"
              icon={TrashIcon}
              onclick={() => void masks.removeAdjustment(entry.id)}
            />
          </Tooltip>
        </div>
      {/each}
      {#if adjustments.length === 0}
        <p class="px-3 pb-2 text-faint">
          Nothing yet — move a slider in the Edit panel and it lands here.
        </p>
      {/if}
    </div>
  {/if}
</div>
