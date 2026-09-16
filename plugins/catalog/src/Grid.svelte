<script lang="ts">
  // Grid view: a centre pane that covers the viewer with the page the filmstrip is
  // showing. `G` toggles it, the size slider scales the cells, double-click or Enter opens
  // a photo and hands the centre region back to the viewer.
  //
  // The size slider is a native range input: the design system has no slider, and the
  // panel column's is bound to an op parameter.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import XIcon from "phosphor-svelte/lib/XIcon";
  import { filterLabel, gridSizeRange, gridTemplate } from "./catalog";
  import PhotoCell from "./PhotoCell.svelte";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const catalog = ctx.catalog;
  const viewer = ctx.viewer;

  const collectionName = $derived(
    catalog.collections.find((entry) => entry.collectionId === catalog.filter.collectionId)?.name,
  );

  function activate(photoId: number): void {
    catalog.select(photoId, { shift: false, ctrl: false });
    void catalog.openSelected();
  }
</script>

{#if catalog.gridVisible}
  <div class="absolute inset-0 z-overlay flex flex-col bg-canvas" data-pane="grid">
    <header class="flex items-center gap-3 border-b border-line bg-elevated px-3 py-2 text-xs">
      <span class="font-semibold text-default">
        {filterLabel(catalog.filter, collectionName)}
      </span>
      <span class="tabular-nums text-muted">{catalog.total} photos</span>
      <label class="ml-auto flex items-center gap-2 text-muted">
        Size
        <input
          type="range"
          class="w-40 accent-action"
          min={gridSizeRange.min}
          max={gridSizeRange.max}
          step={gridSizeRange.step}
          value={catalog.gridSize}
          data-grid-size={catalog.gridSize}
          oninput={(event) => catalog.setGridSize(Number(event.currentTarget.value))}
        />
        <span class="w-10 tabular-nums text-dim">{catalog.gridSize}px</span>
      </label>
      <Tooltip text="Back to the photo — G" placement="bottom">
        <Button size="sm" variant="ghost" icon={XIcon} onclick={() => catalog.toggleGrid()}
          >Done</Button
        >
      </Tooltip>
    </header>

    <div
      class="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto p-3"
      style:grid-template-columns={gridTemplate(catalog.gridSize)}
      role="listbox"
      aria-label="Grid"
      tabindex="-1"
    >
      {#each catalog.photos as photo (photo.photoId)}
        <PhotoCell
          {photo}
          url={catalog.thumbnailUrl(photo)}
          selected={catalog.selection.includes(photo.photoId)}
          open={viewer.photoId === photo.photoId}
          cellClass="aspect-[4/3] w-full"
          onselect={(event) =>
            catalog.select(photo.photoId, {
              shift: event.shiftKey,
              ctrl: event.ctrlKey || event.metaKey,
            })}
          onactivate={() => activate(photo.photoId)}
        />
      {/each}
      {#if catalog.photos.length === 0}
        <p class="text-xs text-faint">Nothing imported yet — use Import in the library pane.</p>
      {/if}
    </div>

    <footer class="border-t border-line bg-elevated px-3 py-1 text-2xs text-dim">
      Double-click or Enter opens · arrows move · 0–5 rate · P pick · X reject
    </footer>
  </div>
{/if}
