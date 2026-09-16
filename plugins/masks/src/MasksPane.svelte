<script lang="ts">
  // The Masks column, and the tools it draws on the viewer's overlay. The column is only
  // mounted while the rail is on "masks", so attaching the overlay and the shortcuts here —
  // with their inverses — is also what arms and disarms the tools.
  import { kernelContext, type OverlayPointer, type OverlayRect } from "@latent/contracts";
  import { GeneratedPanel, ValueField } from "@latent/plugin-panels";
  import type { MaskComponentKind } from "@latent/protocol";
  import { Button, Select, Tooltip } from "@neoworks-dev/ui";
  import EyeIcon from "phosphor-svelte/lib/EyeIcon";
  import EyeSlashIcon from "phosphor-svelte/lib/EyeSlashIcon";
  import PaletteIcon from "phosphor-svelte/lib/PaletteIcon";
  import ComponentRow from "./ComponentRow.svelte";
  import KindIcon from "./KindIcon.svelte";
  import {
    coverageLabel,
    groupLabels,
    kindSpecs,
    maskShortcut,
    opacitySpec,
    tintLabels,
    tintStyle,
  } from "./masks";
  import Toolbar from "./Toolbar.svelte";
  import {
    boxFromDrag,
    brushSizeAfterStep,
    brushSizeAfterWheel,
    ellipseBox,
    linearFromDrag,
    radialFromDrag,
    type Point,
  } from "./tools";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const masks = ctx.masks;
  const viewer = ctx.viewer;
  const panels = ctx.panels;

  const op = $derived(masks.op);
  const definition = $derived(panels.ops.find((entry) => entry.name === op?.op));
  const components = $derived(masks.components);
  const opacity = $derived(op?.opacity ?? 100);
  // Only ops the engine says take a mask can become layers; geometry ops cannot.
  const maskable = $derived(
    viewer.stack.filter((entry) =>
      panels.ops.some((spec) => spec.name === entry.op && spec.maskable),
    ),
  );
  const createOptions = $derived(
    kindSpecs.map((spec) => ({
      value: spec.kind as string,
      label: `${groupLabels[spec.group]} · ${spec.label}`,
    })),
  );

  let textKind = $state(false);
  // Drag and hover live outside reactive state: they change per pointer event and only the
  // overlay canvas cares, so they repaint it instead of re-rendering the column.
  let drag: { start: Point; current: Point } | null = null;
  let hover: Point | null = null;

  function createMask(kind: string): void {
    if (kind === "text") {
      textKind = true;
      return;
    }
    textKind = false;
    void masks.createComponent(kind as MaskComponentKind);
  }

  async function createText(): Promise<void> {
    const component = await masks.createComponent("text");
    textKind = false;
    if (component) await masks.detect(component.id, { prompt: masks.textPrompt });
  }

  function drawOverlay(context: CanvasRenderingContext2D, rect: OverlayRect): void {
    if (rect.width <= 0 || rect.height <= 0) return;
    if (masks.overlayVisible) drawTint(context, rect);
    drawTools(context, rect);
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
    // in JS. Smoothing keeps a 512-px mask from looking like a checkerboard.
    context.imageSmoothingEnabled = true;
    context.drawImage(raster, rect.x, rect.y, rect.width, rect.height);
  }

  function drawTools(context: CanvasRenderingContext2D, rect: OverlayRect): void {
    context.save();
    context.lineWidth = 1.5;
    context.strokeStyle = "rgba(255, 255, 255, 0.9)";
    context.setLineDash([4, 3]);
    if (drag && masks.tool === "radial") strokeEllipse(context, rect, drag.start, drag.current);
    if (drag && masks.tool === "linear") strokeLine(context, rect, drag.start, drag.current);
    if (drag && masks.tool === "box") strokeBox(context, rect, drag.start, drag.current);
    if (!drag) strokeSelected(context, rect);
    if (masks.tool === "brush" && hover) strokeBrush(context, rect, hover);
    context.restore();
  }

  /** The selected gradient's own handles, so it can be re-dragged without re-creating it. */
  function strokeSelected(context: CanvasRenderingContext2D, rect: OverlayRect): void {
    const component = masks.selectedComponent;
    if (!component) return;
    const params = component.params ?? {};
    if (component.kind === "radial") {
      const center = (params.center ?? [0.5, 0.5]) as Point;
      const radius = (params.radius ?? [0.25, 0.25]) as Point;
      const box = ellipseBox(center, radius, rect);
      context.beginPath();
      context.ellipse(box.cx, box.cy, box.rx, box.ry, 0, 0, Math.PI * 2);
      context.stroke();
      handle(context, box.cx, box.cy);
      handle(context, box.cx + box.rx, box.cy);
      handle(context, box.cx, box.cy + box.ry);
    }
    if (component.kind === "linear") {
      const start = (params.start ?? [0.5, 0.25]) as Point;
      const end = (params.end ?? [0.5, 0.75]) as Point;
      strokeLine(context, rect, start, end);
    }
  }

  function strokeEllipse(
    context: CanvasRenderingContext2D,
    rect: OverlayRect,
    start: Point,
    current: Point,
  ): void {
    const rx = Math.abs(current[0] - start[0]) * rect.width;
    const ry = Math.abs(current[1] - start[1]) * rect.height;
    context.beginPath();
    context.ellipse(
      rect.x + start[0] * rect.width,
      rect.y + start[1] * rect.height,
      Math.max(1, rx),
      Math.max(1, ry),
      0,
      0,
      Math.PI * 2,
    );
    context.stroke();
  }

  function strokeLine(
    context: CanvasRenderingContext2D,
    rect: OverlayRect,
    start: Point,
    end: Point,
  ): void {
    const x0 = rect.x + start[0] * rect.width;
    const y0 = rect.y + start[1] * rect.height;
    const x1 = rect.x + end[0] * rect.width;
    const y1 = rect.y + end[1] * rect.height;
    context.beginPath();
    context.moveTo(x0, y0);
    context.lineTo(x1, y1);
    context.stroke();
    handle(context, x0, y0);
    handle(context, x1, y1);
  }

  function strokeBox(
    context: CanvasRenderingContext2D,
    rect: OverlayRect,
    start: Point,
    current: Point,
  ): void {
    const [x0, y0, x1, y1] = boxFromDrag(start, current);
    context.strokeRect(
      rect.x + x0 * rect.width,
      rect.y + y0 * rect.height,
      (x1 - x0) * rect.width,
      (y1 - y0) * rect.height,
    );
  }

  function strokeBrush(context: CanvasRenderingContext2D, rect: OverlayRect, point: Point): void {
    const radius = (masks.brushSize * Math.max(rect.width, rect.height)) / 2;
    context.setLineDash([]);
    context.beginPath();
    context.arc(
      rect.x + point[0] * rect.width,
      rect.y + point[1] * rect.height,
      Math.max(2, radius),
      0,
      Math.PI * 2,
    );
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
    const point: Point = [event.x, event.y];
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

  // The preview follows the stack: it re-asks when this op's mask changed and not otherwise.
  $effect(() => {
    masks.syncPreview();
  });
</script>

<div
  class="flex flex-col pb-4 text-xs"
  data-pane="masks"
  data-mask-coverage={masks.coverage.toFixed(4)}
  data-mask-tint={masks.tint}
  data-mask-overlay={masks.overlayVisible}
  data-mask-op={op?.id ?? ""}
>
  {#if !op}
    <div class="flex flex-col gap-2 px-3 py-3">
      <p class="text-muted">Select an adjustment or create a mask.</p>
      {#if maskable.length > 0}
        <ul class="flex flex-col">
          {#each maskable as entry (entry.id)}
            <li>
              <button
                type="button"
                class="w-full rounded-sm px-2 py-1.5 text-left text-xs text-default
                       transition-colors hover:bg-hover"
                onclick={() => viewer.selectOp(entry.id)}
                data-select-op={entry.op}
              >
                {panels.ops.find((spec) => spec.name === entry.op)?.label ?? entry.op}
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-faint">Move a slider in the Edit column first.</p>
      {/if}
    </div>
  {:else}
    <header class="flex items-center gap-1 border-b border-line-faint px-2 py-1.5">
      <span class="min-w-0 flex-1 truncate font-semibold text-default">
        {definition?.label ?? op.op}
      </span>
      <Tooltip text="Overlay (O)" placement="left">
        <span data-overlay-toggle={masks.overlayVisible}>
          <Button
            size="sm"
            variant={masks.overlayVisible ? "surface" : "ghost"}
            icon={masks.overlayVisible ? EyeIcon : EyeSlashIcon}
            onclick={() => masks.toggleOverlay()}
          />
        </span>
      </Tooltip>
      <Tooltip text="Overlay style: {tintLabels[masks.tint]} (Shift+O)" placement="left">
        <Button size="sm" variant="ghost" icon={PaletteIcon} onclick={() => masks.cycleTint()} />
      </Tooltip>
    </header>

    <div class="flex items-center justify-between gap-2 px-3 py-1">
      <span class="text-muted">Opacity</span>
      <ValueField
        value={opacity}
        spec={opacitySpec}
        range={{ min: 0, max: 100, step: 1 }}
        label="Layer opacity"
        onInput={(next) => void viewer.setOpacity(op.id, next, true)}
        onCommit={(next) => void viewer.setOpacity(op.id, next, false)}
      />
    </div>

    <div class="px-2 py-1.5" data-create-mask>
      <Select
        value=""
        options={createOptions}
        placeholder="Create new mask"
        onChange={(value) => createMask(String(value))}
      />
    </div>

    {#if textKind}
      <!-- `text` is the one kind that needs a word from the user before it can run. -->
      <div class="flex items-center gap-1 px-2 pb-1.5">
        <input
          class="min-w-0 flex-1 rounded-sm border border-line-strong bg-input px-1.5 py-1
                 text-xs text-default"
          placeholder="the cat"
          bind:value={masks.textPrompt}
          data-text-prompt
        />
        <Button size="sm" onclick={() => void createText()}>Detect</Button>
      </div>
    {/if}

    <Toolbar />

    {#if components.length === 0}
      <p class="px-3 py-2 text-faint">No mask yet — create one above.</p>
    {:else}
      <ul class="flex flex-col border-b border-line" data-mask-components>
        {#each components as component, index (component.id)}
          <ComponentRow {component} {index} />
        {/each}
      </ul>
      <p class="px-3 py-1 text-[10px] text-faint">
        Mask covers <span data-coverage-label>{coverageLabel(masks.coverage)}</span> of the frame
        {#if masks.previewing}· updating{/if}
      </p>
    {/if}

    {#if masks.status}
      <p class="px-3 py-1 text-red" data-mask-status>{masks.status}</p>
    {/if}

    <!-- The op's own sliders, so a local adjustment is edited where its mask is. -->
    <div class="border-t border-line">
      <div class="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] text-faint">
        {#if components[0]}<KindIcon kind={components[0].kind} size={11} />{/if}
        <span>Adjustment</span>
      </div>
      <GeneratedPanel opId={op.id} />
    </div>
  {/if}
</div>
