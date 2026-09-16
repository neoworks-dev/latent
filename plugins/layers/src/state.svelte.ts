// The mask thumbnails the Layers column draws, and nothing else: the rows themselves come
// straight off `viewer.stack`. A thumbnail is one `mask.preview` per mask, cached by the
// mask's own signature, so a slider move on a layer does not re-ask for its thumbnail.
import type { EngineClient, ViewerService } from "@latent/contracts";
import { MaskPreviewQueue, maskSignature } from "@latent/plugin-masks";
import type { Op } from "@latent/protocol";
import { SvelteMap } from "svelte/reactivity";

/** Long edge of a row's thumbnail, in device-independent pixels. */
const THUMBNAIL_WIDTH = 48;

export class LayersState {
  /** Mask signature → a data URL of the mask, small enough to sit in an `<img>`. */
  readonly thumbnails = new SvelteMap<string, string>();
  /** Which row is being dragged, so the column can dim it. */
  dragging = $state<string | null>(null);

  private readonly queue: MaskPreviewQueue;
  // Plain Set: `sync` runs inside an `$effect`, and a SvelteSet's `has`/`add` would make
  // that effect depend on the very bookkeeping it writes — an endless re-run.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private readonly requested = new Set<string>();

  constructor(
    engine: EngineClient,
    private readonly viewer: ViewerService,
  ) {
    this.queue = new MaskPreviewQueue(engine);
  }

  dispose(): void {
    this.queue.dispose();
    this.thumbnails.clear();
    this.requested.clear();
  }

  thumbnail(op: Op): string | undefined {
    return this.thumbnails.get(maskSignature(op, null));
  }

  /**
   * Asks for the thumbnails the column is missing, one at a time behind the shared preview
   * queue. Reads reactive state on purpose: the column calls it from an `$effect`.
   */
  sync(stack: Op[]): void {
    const photoId = this.viewer.photoId;
    if (photoId === null) return;
    for (const op of stack) {
      if ((op.mask?.components.length ?? 0) === 0) continue;
      const signature = maskSignature(op, null);
      if (this.requested.has(signature)) continue;
      this.requested.add(signature);
      void this.load(photoId, op.id, signature);
    }
  }

  private async load(photoId: number, opId: string, signature: string): Promise<void> {
    try {
      // No viewId: a row thumbnail is not laid over the frame, so the photo's own proxy
      // aspect is the right one.
      const preview = await this.queue.request({ photoId, opId });
      if (!preview) return;
      this.thumbnails.set(signature, toDataUrl(preview.width, preview.height, preview.coverage));
    } catch {
      // A mask whose only component is still detecting has no raster yet; the next stack
      // change gives it a new signature and this asks again.
      this.requested.delete(signature);
    }
  }
}

/**
 * The r8 raster as a small grey thumbnail. Drawn once per mask and kept as a data URL: an
 * `<img>` costs the column nothing to redraw, a canvas per row would cost a context each.
 */
function toDataUrl(width: number, height: number, coverage: Uint8Array): string {
  const full = document.createElement("canvas");
  full.width = width;
  full.height = height;
  const context = full.getContext("2d");
  if (!context) return "";
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < coverage.length; index++) {
    const value = coverage[index] ?? 0;
    const offset = index * 4;
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  }
  context.putImageData(new ImageData(pixels, width, height), 0, 0);

  const small = document.createElement("canvas");
  small.width = THUMBNAIL_WIDTH;
  small.height = Math.max(1, Math.round((THUMBNAIL_WIDTH * height) / width));
  const target = small.getContext("2d");
  if (!target) return "";
  target.drawImage(full, 0, 0, small.width, small.height);
  return small.toDataURL("image/png");
}
