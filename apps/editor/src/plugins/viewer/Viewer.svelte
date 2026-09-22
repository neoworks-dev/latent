<script lang="ts">
  import { kernelContext } from "@latent/contracts";
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
  /** Reactive twin of `pan`, for the cursor and for the tool-versus-pan test. */
  let panning = $state(false);

  /** A wheel notch is a ratio, so zooming in and out by one step is symmetric. */
  const ZOOM_STEP = 1.2;

  /**
   * Where the photo is drawn inside this canvas, in the canvas' own CSS pixels. The canvas
   * fills the viewer and the panels float over it, so the picture is only ever part of it:
   * a script driving a tool has to aim at the photo rather than at the box.
   */
  const overlayRect = $derived(
    [overlay.rect.x, overlay.rect.y, overlay.rect.width, overlay.rect.height]
      .map((value) => Math.round(value))
      .join(","),
  );

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

  /**
   * A drag pans the picture: Space and the middle button always, the left button whenever
   * no tool claimed it first (`dispatch` asks the overlay before it asks for a pan). It is
   * the only way to move a zoomed photo, so it cannot be behind a modifier.
   */
  function startPan(event: PointerEvent): boolean {
    if (!spaceHeld && event.button !== 1 && event.button !== 0) return false;
    const at = boxOf(event);
    if (!at) return false;
    pan = { pointerId: event.pointerId, x: at.x, y: at.y };
    panning = true;
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
    panning = false;
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
    // The box below listens for the same events, and a left button starts a pan there. This
    // handler decides tool-versus-pan on its own, so the event must not reach it a second
    // time: the bubbled pointerdown would take the capture and every move after it would
    // pan the picture instead of reaching the tool that claimed the drag.
    event.stopPropagation();
    // Space and the middle button outrank every tool: they are the viewport's own gesture.
    if ((spaceHeld || event.button === 1 || panning) && panGesture(kind, event)) {
      event.preventDefault();
      return;
    }
    const element = overlayCanvas;
    if (!element) return;
    if (kind === "down") element.setPointerCapture(event.pointerId);
    if (kind === "up" || kind === "cancel") element.releasePointerCapture(event.pointerId);
    if (overlay.dispatch(kind, event, element.getBoundingClientRect())) {
      event.preventDefault();
      return;
    }
    // The tool did not want it, so the drag is a pan — a mask tool that ignores the empty
    // margin around the photo still lets the photo be moved there.
    if (panGesture(kind, event)) event.preventDefault();
  }

  function panGesture(kind: "down" | "move" | "up" | "cancel", event: PointerEvent): boolean {
    if (kind === "down") return startPan(event);
    if (kind === "move") return movePan(event);
    return endPan(event);
  }

  function onWheel(event: WheelEvent): void {
    // Same reason as `dispatch`: the wheel is handled once, here or on the box, never twice.
    event.stopPropagation();
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

  // The cards the shell floats over the canvas. The engine fits the photo into what they
  // leave clear, so the whole picture is visible between them; zoomed in it fills the
  // canvas and runs on behind them.
  $effect(() => {
    viewer.setInsets(ctx.panes.safeArea);
  });

  // The GL context lives as long as this canvas does, and the viewer draws through it
  // directly — no frame ever passes through reactive state.
  $effect(() => {
    const element = canvas;
    if (!element) return;
    const painter = new FramePainter(element);
    const detach = viewer.attachFrameSink(painter);
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

<div class="relative h-full">
  <!-- The wheel and the pan drag live on the box, not on the overlay: the overlay is off
       the page whenever no tool is attached, and zooming has to work then too. -->
  <div
    class="absolute inset-0"
    class:cursor-grab={!panning}
    class:cursor-grabbing={panning}
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
      data-overlay-rect={overlayRect}
      onpointerdown={(event) => dispatch("down", event)}
      onpointermove={(event) => dispatch("move", event)}
      onpointerup={(event) => dispatch("up", event)}
      onpointercancel={(event) => dispatch("cancel", event)}
      onwheel={onWheel}
    ></canvas>
  </div>
</div>
