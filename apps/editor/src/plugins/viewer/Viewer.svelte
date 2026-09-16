<script lang="ts">
  import { kernelContext } from "@latent/contracts";
  import { Button } from "@neoworks-dev/ui";
  import { FramePainter } from "./painter";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const viewer = ctx.viewer;
  const overlay = viewer.overlay;

  let canvas = $state<HTMLCanvasElement | null>(null);
  let overlayCanvas = $state<HTMLCanvasElement | null>(null);

  // The overlay is a second canvas in the same box: 2D, transparent, never in the frame
  // path. It hands itself to the viewer's overlay service, which owns what is drawn on it.
  $effect(() => {
    const element = overlayCanvas;
    if (!element) return;
    return overlay.attachCanvas(element);
  });

  function dispatch(kind: "down" | "move" | "up" | "cancel", event: PointerEvent): void {
    const element = overlayCanvas;
    if (!element) return;
    if (kind === "down") element.setPointerCapture(event.pointerId);
    if (kind === "up" || kind === "cancel") element.releasePointerCapture(event.pointerId);
    if (overlay.dispatch(kind, event, element.getBoundingClientRect())) event.preventDefault();
  }

  function onWheel(event: WheelEvent): void {
    const element = overlayCanvas;
    if (!element) return;
    // Only a tool that claims the wheel (brush size) stops the page from scrolling.
    if (overlay.dispatch("wheel", event, element.getBoundingClientRect())) event.preventDefault();
  }

  // The GL context lives as long as this canvas does, and the viewer draws through it
  // directly — no frame ever passes through reactive state.
  $effect(() => {
    const element = canvas;
    if (!element) return;
    const painter = new FramePainter(element);
    const detach = viewer.attachFrameSink((frame) => painter.draw(frame));
    return () => {
      detach();
      painter.dispose();
    };
  });

  async function openPath(path: string): Promise<void> {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.round(rect.width * devicePixelRatio);
    const height = Math.round(rect.height * devicePixelRatio);
    await viewer.open(path, width, height);
  }

  async function openPhoto(): Promise<void> {
    const paths = (await window.latentDesktop?.pickFiles()) ?? [];
    const path = paths[0];
    if (!path) return;
    await openPath(path);
  }

  // The engine renders at viewport resolution, so a window resize is a new frame size.
  $effect(() => {
    const element = canvas;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      viewer.resize(
        Math.round(rect.width * devicePixelRatio),
        Math.round(rect.height * devicePixelRatio),
      );
      // The overlay works in CSS pixels; it scales itself by devicePixelRatio when it paints.
      overlay.setBoxSize(rect.width, rect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  });

  // Dev hook: `?photo=<path>` opens that file once the canvas has a size, so the app can
  // be driven against the mock engine without the native dialog.
  let autoOpened = false;
  $effect(() => {
    if (autoOpened || !canvas) return;
    const path = new URLSearchParams(location.search).get("photo");
    if (!path) return;
    autoOpened = true;
    void openPath(path);
  });
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center gap-3 border-b border-line px-3 py-1.5 text-xs text-muted">
    <Button size="sm" onclick={openPhoto}>Open…</Button>
    <span>{viewer.status}</span>
    <span class="ml-auto tabular-nums" data-latency>
      {viewer.latencyMs.toFixed(1)} ms ({viewer.engineMs.toFixed(1)} engine)
    </span>
  </div>
  <div class="relative min-h-0 w-full min-w-0 flex-1">
    <canvas bind:this={canvas} class="absolute inset-0 size-full object-contain"></canvas>
    <!-- Masks, crop and every other tool draw here. Transparent, 2D, and never part of the
         frame path: the WebGL canvas below keeps its own context untouched. It is on the
         page only while a tool is attached — an idle second canvas over the frame is a
         compositing layer for nothing. -->
    <canvas
      bind:this={overlayCanvas}
      class="absolute inset-0 size-full touch-none"
      class:hidden={!overlay.active}
      style:cursor={overlay.cursor}
      data-overlay-canvas
      onpointerdown={(event) => dispatch("down", event)}
      onpointermove={(event) => dispatch("move", event)}
      onpointerup={(event) => dispatch("up", event)}
      onpointercancel={(event) => dispatch("cancel", event)}
      onwheel={onWheel}
    ></canvas>
  </div>
</div>
