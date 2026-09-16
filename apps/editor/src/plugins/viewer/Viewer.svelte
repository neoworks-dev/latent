<script lang="ts">
  import { kernelContext } from "@latent/contracts";
  import { Button } from "@neoworks-dev/ui";
  import { FramePainter } from "./painter";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const viewer = ctx.viewer;

  let canvas = $state<HTMLCanvasElement | null>(null);

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
  <canvas bind:this={canvas} class="min-h-0 w-full min-w-0 flex-1 object-contain"></canvas>
</div>
