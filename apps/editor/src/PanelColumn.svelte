<script lang="ts">
  // One column of cards — the left one or the right one. Both work the same way: the panes
  // registered for the region, in the order the user dragged them into, each foldable and
  // each able to leave the column entirely. The rules are in `panels.ts` and the placement
  // in `PanelLayout`; this draws them and scrolls while a card is dragged near an end.
  import type { PaneDefinition } from "@latent/contracts";
  import { FloatingScrollbar } from "@neoworks-dev/ui";
  import type { PanelLayout } from "./lib/kernel/layout.svelte";
  import { autoScrollStep } from "./panels";
  import PanelCard from "./PanelCard.svelte";

  const {
    side,
    panes,
    layout,
    mode,
  }: {
    side: "left" | "right";
    /** The docked panes, already in draw order. */
    panes: PaneDefinition[];
    layout: PanelLayout;
    /** The rail mode, so a card belonging to another one is drawn quiet. */
    mode: string;
  } = $props();

  let column = $state<HTMLElement | null>(null);
  let scroller = $state<HTMLDivElement | undefined>(undefined);
  const ids = $derived(panes.map((pane) => pane.id));

  /** Each docked card's vertical middle, in window pixels: what a reorder is measured by. */
  export function midpoints(): number[] {
    const element = column;
    if (!element) return [];
    return ids.map((id) => {
      const card = element.querySelector(`[data-pane-card="${id}"]`);
      if (!card) return 0;
      const rect = card.getBoundingClientRect();
      return rect.y + rect.height / 2;
    });
  }

  // A card dragged at either end of the column pulls it along, so a list taller than the
  // window can be reordered without letting go. One listener for the whole drag, on the
  // window, because the pointer is captured by the card being dragged.
  $effect(() => {
    if (layout.dragging === null) return;
    const viewport = scroller;
    if (!viewport) return;
    const onMove = (event: PointerEvent): void => {
      const box = viewport.getBoundingClientRect();
      const step = autoScrollStep(event.clientY, { top: box.top, bottom: box.bottom });
      if (step !== 0) viewport.scrollBy(0, step);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  });
</script>

<aside
  bind:this={column}
  class="pointer-events-auto min-h-0 overflow-hidden rounded-lg border border-line bg-elevated
         shadow-lg"
  data-floating={side}
>
  <!-- The column scrolls far more often than the window does; the design system's
       scrollbar floats over the content instead of taking a track out of a card that is
       only a few hundred pixels wide. -->
  <FloatingScrollbar class="h-full" bind:viewport={scroller}>
    {#each panes as pane, index (pane.id)}
      <!-- Where a card held over the column would land. Drawn between the cards rather
           than as a gap, so nothing below it moves until the drop. -->
      {#if layout.dropIndex === index}
        <div class="h-0.5 bg-action" data-drop-indicator={index}></div>
      {/if}
      <PanelCard
        {pane}
        {layout}
        inactive={pane.mode !== undefined && pane.mode !== mode}
        docked={ids}
        {midpoints}
      />
    {/each}
    {#if layout.dropIndex === panes.length}
      <div class="h-0.5 bg-action" data-drop-indicator={panes.length}></div>
    {/if}
  </FloatingScrollbar>
</aside>
