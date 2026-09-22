<script lang="ts">
  // The cursor a locked scrub draws for itself. Pointer lock hides the real one and freezes
  // it in place, so without this a long drag looks like nothing is happening; with it the
  // arrow keeps travelling and comes back in at the other side of the window, which is what
  // Figma does and what makes a wrap legible rather than mysterious.
  import ArrowsHorizontalIcon from "phosphor-svelte/lib/ArrowsHorizontalIcon";

  const { x, y }: { x: number; y: number } = $props();
</script>

<span
  class="pointer-events-none fixed z-toast -translate-x-1/2 -translate-y-1/2 text-default
         drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
  style:left="{x}px"
  style:top="{y}px"
  aria-hidden="true"
  data-scrub-cursor
>
  <ArrowsHorizontalIcon size={18} weight="bold" />
</span>
