<script lang="ts">
  // The Relight column and the overlay it draws (PROMPT.md 3.8): estimate the scene's
  // depth, drop a light into it, drag it where it belongs. The column is only mounted while
  // the rail is on "relight", so attaching the painter and the pointer handler here — with
  // their inverses — is also what arms and disarms the tool.
  //
  // Nothing here holds a light: a light is a `relight` op in the engine's stack, and the
  // sliders under the list are the ones `ops.describe` publishes, drawn by the same
  // generated panel the Edit column uses.
  import {
    kernelContext,
    type OverlayMap,
    type OverlayPointer,
    type OverlayRect,
  } from "@latent/contracts";
  import { GeneratedPanel } from "@latent/plugin-panels";
  import { Button, LoadingSpinner, Tooltip } from "@neoworks-dev/ui";
  import EyeIcon from "phosphor-svelte/lib/EyeIcon";
  import EyeSlashIcon from "phosphor-svelte/lib/EyeSlashIcon";
  import SunIcon from "phosphor-svelte/lib/SunIcon";
  import TrashIcon from "phosphor-svelte/lib/TrashIcon";
  import {
    depthToRgba,
    distanceFromDrag,
    distanceFromWheel,
    handleAt,
    kelvinSwatch,
    keyEvent,
    lightPosition,
    paramOf,
    type Point,
    radiusFromDrag,
    reachOf,
    type RelightHandle,
    relightShortcut,
    ringPoints,
  } from "./relight";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const relight = ctx.relight;
  const viewer = ctx.viewer;
  const engine = ctx.engine;

  // The drag lives outside reactive state: it changes per pointer event and only the
  // overlay cares. A depth drag also remembers where it started, because it moves the light
  // along an axis the pointer has no coordinate for.
  let drag: RelightHandle = null;
  let dragStart = { y: 0, distance: 50 };
  let hover = $state<RelightHandle>(null);
  // The depth map as an offscreen canvas, so the painter blits instead of rebuilding it.
  let depthCanvas: HTMLCanvasElement | null = null;

  const lights = $derived(relight.lights);
  const selected = $derived(relight.op);
  // The image's aspect as the viewer draws it: the light's reach is a circle in the scene,
  // which is an ellipse on the photo.
  const aspect = $derived(
    viewer.overlay.rect.height > 0 ? viewer.overlay.rect.width / viewer.overlay.rect.height : 1,
  );

  function centre(map: OverlayMap): Point {
    const [x, y] = lightPosition(selected);
    const at = map.toCanvas(x, y);
    return [at.x, at.y];
  }

  /** The reach ring's radius on screen, read off the map rather than off the aspect twice. */
  function ringRadius(map: OverlayMap): number {
    const [x, y] = lightPosition(selected);
    const from = map.toCanvas(x, y);
    const to = map.toCanvas(x, y + reachOf(selected));
    return Math.hypot(to.x - from.x, to.y - from.y);
  }

  function drawOverlay(
    context: CanvasRenderingContext2D,
    rect: OverlayRect,
    map: OverlayMap,
  ): void {
    if (rect.width <= 0 || rect.height <= 0) return;
    context.save();
    if (relight.showDepth) drawDepth(context, map);
    if (selected) {
      drawRing(context, map);
      drawLight(context, map);
    }
    context.restore();
  }

  /**
   * The depth map over the photo. The map is image-space, so the three corners of the image
   * give the transform that puts it there — affine, which is exact under crop, straighten,
   * rotate, flip and zoom and slightly off under the Transform sliders' keystone. It is a
   * guide for placing a light, not a mask, so that is a fair trade against a per-pixel warp.
   */
  function drawDepth(context: CanvasRenderingContext2D, map: OverlayMap): void {
    const image = depthCanvas;
    if (!image) return;
    const origin = map.toCanvas(0, 0);
    const right = map.toCanvas(1, 0);
    const down = map.toCanvas(0, 1);
    context.save();
    context.globalAlpha = 0.85;
    context.setTransform(
      (right.x - origin.x) / image.width,
      (right.y - origin.y) / image.width,
      (down.x - origin.x) / image.height,
      (down.y - origin.y) / image.height,
      origin.x,
      origin.y,
    );
    context.drawImage(image, 0, 0);
    context.restore();
  }

  function drawRing(context: CanvasRenderingContext2D, map: OverlayMap): void {
    const points = ringPoints(lightPosition(selected), reachOf(selected), aspect);
    context.beginPath();
    for (const [index, point] of points.entries()) {
      const at = map.toCanvas(point[0], point[1]);
      if (index === 0) context.moveTo(at.x, at.y);
      else context.lineTo(at.x, at.y);
    }
    context.closePath();
    context.setLineDash([5, 5]);
    context.lineWidth = hover === "reach" || drag === "reach" ? 2 : 1;
    context.strokeStyle = "rgba(255, 220, 160, 0.7)";
    context.stroke();
    context.setLineDash([]);
  }

  /**
   * A sun: a filled core in the light's own colour, with spokes, so it reads at any zoom.
   * The spokes are short when the light sits far back in the scene and long when it sits
   * near the camera, and the depth reads out beside it — Z is the one thing a light has that
   * the photo has no room to show.
   */
  function drawLight(context: CanvasRenderingContext2D, map: OverlayMap): void {
    const [x, y] = centre(map);
    const color = kelvinSwatch(paramOf(selected, "kelvin", 5500));
    const big = hover === "light" || drag === "light" || hover === "depth" || drag === "depth";
    const distance = paramOf(selected, "distance", 50);
    const spoke = 8 + (1 - distance / 100) * 12;
    context.strokeStyle = "rgba(0, 0, 0, 0.6)";
    context.lineWidth = 3;
    context.beginPath();
    context.arc(x, y, big ? 8 : 6, 0, Math.PI * 2);
    context.stroke();
    context.fillStyle = color;
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = color;
    for (let index = 0; index < 8; index++) {
      const angle = (index / 8) * Math.PI * 2;
      context.beginPath();
      context.moveTo(x + Math.cos(angle) * 11, y + Math.sin(angle) * 11);
      context.lineTo(x + Math.cos(angle) * (11 + spoke), y + Math.sin(angle) * (11 + spoke));
      context.stroke();
    }

    context.font = "10px sans-serif";
    context.textBaseline = "middle";
    const label = `z ${Math.round(distance)}`;
    context.lineWidth = 3;
    context.strokeStyle = "rgba(0, 0, 0, 0.7)";
    context.strokeText(label, x + 13 + spoke, y);
    context.fillStyle = color;
    context.fillText(label, x + 13 + spoke, y);
  }

  function grabAt(event: OverlayPointer): RelightHandle {
    if (!selected) return null;
    const map = viewer.overlay.map;
    const at = map.toCanvas(event.imageX, event.imageY);
    const grip = handleAt([at.x, at.y], centre(map), ringRadius(map));
    if (grip === "light" && event.shiftKey) return "depth";
    return grip;
  }

  function onPointer(event: OverlayPointer): boolean {
    if (!selected) return false;
    // The wheel over the light moves it in Z; anywhere else it is the viewer's zoom.
    if (event.kind === "wheel") {
      if (grabAt(event) === null) return false;
      const distance = distanceFromWheel(paramOf(selected, "distance", 50), event.deltaY);
      void relight.setParams({ distance }, false);
      return true;
    }
    const point: Point = [event.imageX, event.imageY];
    if (event.kind === "down") {
      drag = grabAt(event);
      hover = drag;
      dragStart = { y: event.y, distance: paramOf(selected, "distance", 50) };
      return drag !== null;
    }
    if (event.kind === "cancel") {
      drag = null;
      return true;
    }
    if (!drag) {
      hover = grabAt(event);
      return false;
    }
    const transient = event.kind === "move";
    if (drag === "light") {
      void relight.setParams({ x: clamp(point[0]), y: clamp(point[1]) }, transient);
    } else if (drag === "depth") {
      void relight.setParams(
        { distance: distanceFromDrag(dragStart.distance, dragStart.y, event.y) },
        transient,
      );
    } else {
      void relight.setParams(
        { radius: radiusFromDrag(point, lightPosition(selected), aspect) },
        transient,
      );
    }
    viewer.overlay.redraw();
    if (!transient) drag = null;
    return true;
  }

  function clamp(value: number): number {
    return Number(Math.min(1, Math.max(0, value)).toFixed(4));
  }

  async function loadDepth(): Promise<void> {
    const photoId = viewer.photoId;
    if (photoId === null || !relight.depthReady) return;
    // A box rather than a plain local: the frame arrives in a callback, and a `let` written
    // only from inside one narrows to `null` for everything after it.
    const received: { map: ImageData | null } = { map: null };
    const off = engine.onDepth((header, depth) => {
      received.map = new ImageData(depthToRgba(depth), header.width, header.height);
    });
    try {
      // The frame is sent before the result on the same socket, so it has landed by now.
      await engine.call("depth.preview", { photoId });
    } finally {
      off();
    }
    const map = received.map;
    if (!map) return;
    const canvas = document.createElement("canvas");
    canvas.width = map.width;
    canvas.height = map.height;
    canvas.getContext("2d")?.putImageData(map, 0, 0);
    depthCanvas = canvas;
    viewer.overlay.redraw();
  }

  // Opening the column asks the engine whether this photo has a map; changing photo asks
  // again. Nothing else does — the answer only moves when a job lands, and that arrives as
  // depth.changed.
  $effect(() => {
    void viewer.photoId;
    depthCanvas = null;
    void relight.refresh();
  });

  // The depth overlay is fetched the first time it is switched on, and again whenever a new
  // map lands under it.
  $effect(() => {
    if (!relight.showDepth || !relight.depthReady) return;
    void relight.depthModel;
    void loadDepth();
  });

  // The overlay: one painter, one pointer handler, both gone when the column closes.
  $effect(() => {
    const detachDraw = viewer.overlay.attachOverlay(drawOverlay);
    const detachPointer = viewer.overlay.onPointer(onPointer);
    return () => {
      detachDraw();
      detachPointer();
    };
  });

  // The painter is a plain function and nothing repaints it when the stack moves under it:
  // undo, a slider in the column and selecting another light all move the handle with no
  // new frame behind them.
  $effect(() => {
    void selected?.params;
    void relight.showDepth;
    void hover;
    viewer.overlay.redraw();
  });

  $effect(() => {
    if (!hover) return;
    if (hover === "light") return viewer.overlay.setCursor("grab");
    return viewer.overlay.setCursor(hover === "depth" ? "ns-resize" : "ew-resize");
  });

  // Esc leaves, live only while this column is.
  $effect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (relightShortcut(keyEvent(event)) !== "leaveTool") return;
      event.preventDefault();
      relight.leave();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
</script>

<div
  class="flex flex-col pb-4 text-xs"
  data-pane="relight"
  data-relight-op={selected?.id ?? ""}
  data-relight-depth={relight.depthReady}
  data-relight-running={relight.running}
  data-relight-lights={lights.length}
>
  <header class="flex items-center gap-1 border-b border-line-faint px-2 py-1.5">
    <SunIcon size={13} />
    <span class="min-w-0 flex-1 truncate font-semibold text-default">Relight</span>
  </header>

  <!-- Depth first: it is the scene the lights are placed in, and without it they render
       nothing at all. -->
  <div class="flex items-center gap-2 px-2 py-2">
    <span class="flex-1" data-relight-estimate>
      <Button
        size="sm"
        full
        disabled={viewer.photoId === null || relight.running}
        onclick={() => void relight.estimate()}
      >
        {relight.depthReady ? "Re-estimate depth" : "Estimate depth"}
      </Button>
    </span>
    {#if relight.depthReady}
      <Tooltip text="Show the depth map over the photo" placement="left">
        <span data-relight-show-depth>
          <Button
            size="sm"
            variant={relight.showDepth ? "primary" : "ghost"}
            icon={relight.showDepth ? EyeIcon : EyeSlashIcon}
            onclick={() => (relight.showDepth = !relight.showDepth)}
          />
        </span>
      </Tooltip>
    {/if}
  </div>

  {#if relight.running}
    <div class="flex items-center gap-2 px-3 pb-2" data-relight-progress>
      <LoadingSpinner size={12} />
      <span class="text-[10px] text-faint">reading the scene's depth…</span>
    </div>
  {:else}
    <p class="px-3 pb-2 text-[10px] text-faint" data-relight-status>
      {relight.depthReady
        ? `depth map from ${relight.depthModel || "the model store"}`
        : "No depth map yet. A light needs one before it can shine on anything."}
    </p>
  {/if}

  {#if relight.error}
    <p class="px-3 pb-2 text-red" data-relight-error>{relight.error}</p>
  {/if}

  <div class="flex items-center gap-2 border-t border-line-faint px-2 py-2">
    <span class="flex-1" data-relight-add>
      <Button
        size="sm"
        full
        icon={SunIcon}
        disabled={viewer.photoId === null}
        onclick={() => void relight.addLight()}
      >
        Add light
      </Button>
    </span>
  </div>

  {#each lights as light (light.id)}
    {@const isSelected = light.id === selected?.id}
    <div
      class="flex items-center gap-2 px-2 py-1"
      class:bg-raised={isSelected}
      data-relight-light={light.id}
    >
      <button
        class="flex min-w-0 flex-1 items-center gap-2 text-left"
        onclick={() => (relight.selectedId = light.id)}
      >
        <span
          class="size-3 shrink-0 rounded-full border border-line-strong"
          style:background={kelvinSwatch(paramOf(light, "kelvin", 5500))}
        ></span>
        <span class="min-w-0 flex-1 truncate">
          {Math.round(paramOf(light, "intensity", 0))}% · {Math.round(
            paramOf(light, "kelvin", 5500),
          )} K
        </span>
      </button>
      <Button
        size="sm"
        variant="ghost"
        icon={light.enabled === false ? EyeSlashIcon : EyeIcon}
        onclick={() => void viewer.setEnabled(light.id, light.enabled === false)}
      />
      <Button
        size="sm"
        variant="ghost"
        icon={TrashIcon}
        onclick={() => void relight.remove(light.id)}
      />
    </div>
  {/each}

  {#if selected}
    <p class="border-t border-line-faint px-3 py-2 text-[10px] text-faint" data-relight-hint>
      Drag the light to move it across the photo, the ring to change its reach. Shift-drag or scroll
      on it to move it through the scene — Distance (Z) is 0 at the camera and 100 behind
      everything.
    </p>
    <div class="border-t border-line-faint pt-1">
      <GeneratedPanel opId={selected.id} />
    </div>
  {:else}
    <p class="px-3 py-2 text-faint">
      Add a light, then drag it over the photo. The ring is how far it reaches.
    </p>
  {/if}
</div>
