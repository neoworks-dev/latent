<script lang="ts">
  // One card of the right column, docked or floating. The title bar is the drag handle:
  // dragging inside the column reorders, dragging clear of it detaches, and dropping a
  // floating card back over the column re-docks it. The rules live in `panels.ts`; this
  // only turns pointer events into calls.
  import type { PaneDefinition } from "@latent/contracts";
  import { SectionHeader, Tooltip } from "@neoworks-dev/ui";
  import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
  import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
  import PushPinIcon from "phosphor-svelte/lib/PushPinIcon";
  import type { PanelLayout } from "./lib/kernel/layout.svelte";

  const {
    pane,
    layout,
    floating = false,
    inactive = false,
    docked,
    midpoints,
  }: {
    pane: PaneDefinition;
    layout: PanelLayout;
    /** Drawn loose over the viewer rather than in the column. */
    floating?: boolean;
    /**
     * The rail is on another mode, so this card's controls are not the ones in play. It
     * stays where the user put it and keeps its handle; only the body goes quiet.
     */
    inactive?: boolean;
    /** The column's ids in draw order, and their vertical middles: what a reorder needs. */
    docked: string[];
    midpoints: () => number[];
  } = $props();

  let card = $state<HTMLElement | null>(null);
  const Pane = $derived(pane.component);
  const Actions = $derived(pane.headerActions);
  const open = $derived(!layout.isCollapsed(pane.id));

  function onPointerDown(event: PointerEvent): void {
    // Left button only: the wheel and the context menu are not a drag.
    if (event.button !== 0 || !card) return;
    const rect = card.getBoundingClientRect();
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    layout.begin(pane.id, event.pointerId, event.clientX, event.clientY, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }

  function onPointerMove(event: PointerEvent): void {
    layout.move(event.pointerId, event.clientX, event.clientY, docked, midpoints());
  }

  function onPointerUp(event: PointerEvent): void {
    layout.end(event.pointerId, docked, midpoints(), event.clientY);
  }
</script>

<section
  bind:this={card}
  class="border-b border-line last:border-b-0"
  class:pt-2={!floating && !pane.untitled}
  class:overflow-hidden={floating}
  class:rounded-lg={floating}
  class:border={floating}
  class:bg-elevated={floating}
  class:shadow-lg={floating}
  class:opacity-80={layout.dragging === pane.id}
  data-pane-card={pane.id}
  data-floating-panel={floating}
  data-open={open}
>
  <!-- The title bar is the handle. `touch-none` because a drag on a touch screen would
       otherwise scroll the column instead of moving the card. A pane that draws its own
       headings has none, and so neither reorders nor detaches. -->
  {#if !pane.untitled}
    <div
      class="flex cursor-grab touch-none items-center gap-1 px-3"
      class:cursor-grabbing={layout.dragging === pane.id}
      role="presentation"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      data-panel-handle={pane.id}
    >
      <!-- The caret folds the card; the rest of the bar is the drag handle. -->
      <button
        type="button"
        class="shrink-0 rounded-sm p-1 text-faint transition-colors hover:text-default"
        aria-expanded={open}
        aria-label="{open ? 'Collapse' : 'Expand'} {pane.title}"
        onpointerdown={(event) => event.stopPropagation()}
        onclick={() => layout.toggleCollapsed(pane.id)}
        data-section-toggle={pane.id}
      >
        {#if open}
          <CaretDownIcon size={11} weight="bold" />
        {:else}
          <CaretRightIcon size={11} weight="bold" />
        {/if}
      </button>
      <div class="min-w-0 flex-1">
        <SectionHeader title={pane.title} />
      </div>
      {#if Actions}
        <!-- The pane's own controls — a generated panel's Reset. Its own press must not
             start a drag, so it stops the event before the handle sees it. -->
        <span onpointerdown={(event) => event.stopPropagation()} role="presentation">
          <Actions paneId={pane.id} />
        </span>
      {/if}
      {#if floating}
        <Tooltip text="Put back in the column" placement="left">
          <button
            type="button"
            class="shrink-0 rounded-sm p-1 text-faint transition-colors hover:text-default"
            aria-label="Dock {pane.title}"
            onclick={() => layout.dock(pane.id)}
            data-panel-dock={pane.id}
          >
            <PushPinIcon size={12} weight="bold" />
          </button>
        </Tooltip>
      {/if}
    </div>
  {/if}
  {#if open || pane.untitled}
    <!-- Greyed and inert when the rail has moved on: the card is still where it was put,
         but its controls belong to a tool that is not selected. -->
    <div
      class:pointer-events-none={inactive}
      class:opacity-40={inactive}
      aria-disabled={inactive}
      data-pane-inactive={inactive}
    >
      <Pane paneId={pane.id} />
    </div>
  {/if}
</section>
