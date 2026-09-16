<script lang="ts">
  import { kernelContext } from "@latent/contracts";
  import { Button } from "@neoworks-dev/ui";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const viewer = ctx.viewer;

  let canvas = $state<HTMLCanvasElement | null>(null);
  let imageData: ImageData | null = null;

  $effect(() => {
    const frame = viewer.lastFrame;
    if (!frame || !canvas) return;
    const { width, height } = frame.header;
    if (canvas.width !== width || canvas.height !== height || !imageData) {
      canvas.width = width;
      canvas.height = height;
      imageData = new ImageData(width, height);
    }
    imageData.data.set(frame.pixels);
    canvas.getContext("2d")?.putImageData(imageData, 0, 0);
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
    <span class="ml-auto tabular-nums">{viewer.latencyMs.toFixed(1)} ms</span>
  </div>
  <canvas bind:this={canvas} class="min-h-0 w-full min-w-0 flex-1 object-contain"></canvas>
</div>
