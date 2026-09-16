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
  // Pan lives outside reactive state: it changes per pointer event and only the engine's
  // next frame shows it. `spaceHeld` is the Space-drag modifier, the middle button the
  // other way in.
  let pan: { pointerId: number; x: number; y: number } | null = null;
  let spaceHeld = false;

  /** A wheel notch is a ratio, so zooming in and out by one step is symmetric. */
  const ZOOM_STEP = 1.2;

  function boxOf(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const element = overlayCanvas ?? canvas;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function zoomAtPointer(event: WheelEvent): void {
    const at = boxOf(event);
    if (!at) return;
    viewer.zoomBy(event.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP, at.x, at.y);
  }

  /** Space or the middle button starts a pan instead of handing the drag to a tool. */
  function startPan(event: PointerEvent): boolean {
    if (!spaceHeld && event.button !== 1) return false;
    const at = boxOf(event);
    if (!at) return false;
    pan = { pointerId: event.pointerId, x: at.x, y: at.y };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    return true;
  }

  function movePan(event: PointerEvent): boolean {
    if (!pan || pan.pointerId !== event.pointerId) return false;
    const at = boxOf(event);
    if (!at) return false;
    viewer.panBy(at.x - pan.x, at.y - pan.y);
    pan = { pointerId: event.pointerId, x: at.x, y: at.y };
    return true;
  }

  function endPan(event: PointerEvent): boolean {
    if (!pan || pan.pointerId !== event.pointerId) return false;
    pan = null;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    return true;
  }

  // The overlay is a second canvas in the same box: 2D, transparent, never in the frame
  // path. It hands itself to the viewer's overlay service, which owns what is drawn on it.
  $effect(() => {
    const element = overlayCanvas;
    if (!element) return;
    return overlay.attachCanvas(element);
  });

  function dispatch(kind: "down" | "move" | "up" | "cancel", event: PointerEvent): void {
    if (panGesture(kind, event)) {
      event.preventDefault();
      return;
    }
    const element = overlayCanvas;
    if (!element) return;
    if (kind === "down") element.setPointerCapture(event.pointerId);
    if (kind === "up" || kind === "cancel") element.releasePointerCapture(event.pointerId);
    if (overlay.dispatch(kind, event, element.getBoundingClientRect())) event.preventDefault();
  }

  /** Pan first, whatever is on the overlay: it is how the viewport is driven. */
  function panGesture(kind: "down" | "move" | "up" | "cancel", event: PointerEvent): boolean {
    if (kind === "down") return startPan(event);
    if (kind === "move") return movePan(event);
    return endPan(event);
  }

  function onWheel(event: WheelEvent): void {
    const element = overlayCanvas;
    // Ctrl+wheel is always zoom, even while a tool owns the wheel for its own size.
    if (event.ctrlKey || !element) {
      event.preventDefault();
      zoomAtPointer(event);
      return;
    }
    // Otherwise a tool gets first refusal; an unclaimed wheel zooms rather than scrolling
    // a page that does not scroll.
    event.preventDefault();
    if (overlay.dispatch("wheel", event, element.getBoundingClientRect())) return;
    zoomAtPointer(event);
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

  // Zoom shortcuts, and Space as the pan modifier. On the window because the viewer's
  // canvas is not focusable and a photo editor's zoom keys work wherever the pointer is —
  // except inside a text field, where `+` is a character.
  $effect(() => {
    const typing = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    const onKeyDown = (event: KeyboardEvent): void => {
      if (typing(event.target)) return;
      if (event.code === "Space") {
        spaceHeld = true;
        return;
      }
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key === "0") viewer.zoomToFit();
      else if (meta && event.key === "1") viewer.zoomToActual();
      else if (!meta && (event.key === "z" || event.key === "Z")) viewer.toggleZoom();
      else if (!meta && (event.key === "+" || event.key === "=")) viewer.zoomBy(ZOOM_STEP);
      else if (!meta && (event.key === "-" || event.key === "_")) viewer.zoomBy(1 / ZOOM_STEP);
      else return;
      event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === "Space") spaceHeld = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
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
    <span class="ml-auto tabular-nums" data-zoom-level>{viewer.zoom}</span>
    <span class="tabular-nums" data-latency>
      {viewer.latencyMs.toFixed(1)} ms ({viewer.engineMs.toFixed(1)} engine)
    </span>
  </div>
  <!-- The wheel and the pan drag live on the box, not on the overlay: the overlay is off
       the page whenever no tool is attached, and zooming has to work then too. -->
  <div
    class="relative min-h-0 w-full min-w-0 flex-1"
    role="presentation"
    onwheel={onWheel}
    onpointerdown={(event) => void (startPan(event) && event.preventDefault())}
    onpointermove={(event) => void movePan(event)}
    onpointerup={(event) => void endPan(event)}
    onpointercancel={(event) => void endPan(event)}
  >
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
