<script lang="ts">
  // Lightroom's histogram, at the top of the right column in every rail mode. Hand-built:
  // @neoworks-dev/ui has no chart, and the graph is three filled paths screened over each
  // other, which is a shape rather than a control. Tokens only, no hex.
  //
  // The numbers are the engine's, off `view.render` — the histogram of the frame that is
  // on the canvas, not of the stack. Nothing here is computed from pixels: the UI never
  // sees them as anything but a texture upload.
  import { kernelContext } from "@latent/contracts";
  import { Tooltip } from "@neoworks-dev/ui";
  import { BOX, channelPath, clippingLabel, clippingOf } from "./histogram";

  const { paneId: _paneId }: { paneId: string } = $props();
  const viewer = kernelContext().viewer;
  const histogram = $derived(viewer.histogram);
  const clipping = $derived(histogram === null ? null : clippingOf(histogram));
</script>

<div class="relative px-3 pb-3">
  <div class="relative h-24 w-full overflow-hidden rounded-lg border border-line bg-canvas">
    {#if histogram === null}
      <p class="flex h-full items-center justify-center text-xs text-faint">no frame yet</p>
    {:else}
      <svg
        class="h-full w-full"
        viewBox="0 0 {BOX.width} {BOX.height}"
        preserveAspectRatio="none"
        role="img"
        aria-label="Histogram of the frame on screen"
        data-histogram
      >
        <!-- Screened, so the overlaps read as the additive colour the way Lightroom's do:
             red over green is yellow, all three are white. -->
        <path d={channelPath(histogram, "r")} fill="var(--ctx-red)" style:mix-blend-mode="screen" />
        <path
          d={channelPath(histogram, "g")}
          fill="var(--ctx-green)"
          style:mix-blend-mode="screen"
        />
        <path
          d={channelPath(histogram, "b")}
          fill="var(--ctx-blue)"
          style:mix-blend-mode="screen"
        />
      </svg>
    {/if}
  </div>

  {#if clipping !== null}
    <span class="absolute top-1 left-4">
      <Tooltip text="Shadow clipping — {clippingLabel(clipping.shadowsPct)} of the frame">
        <svg
          class="h-2.5 w-2.5"
          viewBox="0 0 10 10"
          role="img"
          aria-label="Shadow clipping"
          data-clipping="shadows"
          data-clipped={clipping.shadows}
        >
          <polygon
            points="0,0 10,0 0,10"
            fill={clipping.shadows ? "var(--ctx-blue)" : "var(--color-faint)"}
          />
        </svg>
      </Tooltip>
    </span>
    <span class="absolute top-1 right-4">
      <Tooltip text="Highlight clipping — {clippingLabel(clipping.highlightsPct)} of the frame">
        <svg
          class="h-2.5 w-2.5"
          viewBox="0 0 10 10"
          role="img"
          aria-label="Highlight clipping"
          data-clipping="highlights"
          data-clipped={clipping.highlights}
        >
          <polygon
            points="0,0 10,0 10,10"
            fill={clipping.highlights ? "var(--ctx-red)" : "var(--color-faint)"}
          />
        </svg>
      </Tooltip>
    </span>
  {/if}
</div>
