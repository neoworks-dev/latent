<script lang="ts">
  // Lightroom's filmstrip: a fixed-height strip of square cells under the viewer. Hand-
  // built on purpose — the design system has no horizontal thumbnail strip (CLAUDE.md
  // lists the filmstrip as hand-built UI). The cell itself is `PhotoCell`, shared with the
  // grid; everything it shows comes from the engine's catalog rows.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import { untrack } from "svelte";
  import SquaresFourIcon from "phosphor-svelte/lib/SquaresFourIcon";
  import { filterLabel, stripCellWidth, stripGap, stripWindow } from "./catalog";
  import PhotoCell from "./PhotoCell.svelte";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const catalog = ctx.catalog;
  const viewer = ctx.viewer;

  let strip = $state<HTMLDivElement | null>(null);
  let viewportWidth = $state(0);
  let scrollLeft = $state(0);

  const collectionName = $derived(
    catalog.collections.find((entry) => entry.collectionId === catalog.filter.collectionId)?.name,
  );
  const current = $derived(catalog.selection.at(-1));

  // The strip holds the whole catalog, so it draws the cells in the scrollport and a
  // strip's width either side. Fixed-width cells placed at `index * pitch` inside a track
  // as wide as the catalog: the scrollbar is the catalog's, the DOM is the window's.
  const pitch = stripCellWidth + stripGap;
  const range = $derived(stripWindow(catalog.photos.length, scrollLeft, viewportWidth));
  const visible = $derived(catalog.photos.slice(range.start, range.end));
  const trackWidth = $derived(Math.max(0, catalog.photos.length * pitch - stripGap));

  // Untracked for the same reason the grid's is: the call reads the thumbnail cache it
  // also writes.
  $effect(() => {
    const photos = visible;
    untrack(() => catalog.needThumbnails("filmstrip", photos));
  });

  function click(event: MouseEvent, photoId: number): void {
    catalog.select(photoId, { shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey });
  }

  // A strip scrolls sideways: a vertical wheel over it is a horizontal scroll, which is
  // what every trackpad and mouse sends over a filmstrip.
  function onWheel(event: WheelEvent): void {
    if (!strip || event.deltaY === 0) return;
    event.preventDefault();
    strip.scrollLeft += event.deltaY;
  }

  // Arrow keys move the selection through cells that are not drawn at all, so the strip
  // scrolls to the selected photo's index rather than to its element.
  $effect(() => {
    const photoId = current;
    if (!strip || photoId === undefined) return;
    const index = catalog.photos.findIndex((photo) => photo.photoId === photoId);
    if (index < 0) return;
    const left = index * pitch;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (left + stripCellWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = left + stripCellWidth - strip.clientWidth;
    }
  });
</script>

<div
  class="flex h-[136px] flex-col border-t border-line bg-elevated"
  data-pane="filmstrip"
  data-thumbnails-loaded={catalog.thumbnails.size}
>
  <div class="flex items-center gap-2 px-3 py-1 text-xs">
    <span class="font-semibold text-default">{filterLabel(catalog.filter, collectionName)}</span>
    <span class="tabular-nums text-muted" data-photo-count={catalog.total}>
      {catalog.total} photos
    </span>
    {#if catalog.selection.length > 1}
      <span class="text-dim" title="Delete removes these rows from the catalog; the files stay">
        {catalog.selection.length} selected
      </span>
    {/if}
    <span class="ml-auto flex items-center gap-1">
      <Tooltip text="Grid view — G" placement="top">
        <Button
          size="sm"
          variant="ghost"
          icon={SquaresFourIcon}
          onclick={() => catalog.toggleGrid()}>Grid</Button
        >
      </Tooltip>
    </span>
  </div>

  <div
    bind:this={strip}
    class="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-3 pb-2"
    role="listbox"
    aria-label="Filmstrip"
    aria-orientation="horizontal"
    tabindex="-1"
    bind:clientWidth={viewportWidth}
    onwheel={onWheel}
    onscroll={(event) => (scrollLeft = event.currentTarget.scrollLeft)}
  >
    <!-- A wrapper per cell rather than an absolutely positioned `PhotoCell`: the cell's own
         root is `relative` — its rating overlay hangs off it — and a second position class
         on the same element is a coin toss the stylesheet's order decides. -->
    <div class="relative h-full" style:width="{trackWidth}px">
      {#each visible as photo, index (photo.photoId)}
        <div
          class="absolute top-0 h-full"
          style:left="{(range.start + index) * pitch}px"
          style:width="{stripCellWidth}px"
        >
          <PhotoCell
            {photo}
            url={catalog.thumbnailUrl(photo)}
            selected={catalog.selection.includes(photo.photoId)}
            open={viewer.photoId === photo.photoId}
            cellClass="h-full w-full"
            onselect={(event) => click(event, photo.photoId)}
            onactivate={() => void catalog.open(photo.photoId)}
          />
        </div>
      {/each}
    </div>
    {#if catalog.photos.length === 0}
      <p class="pt-6 text-xs text-faint">Nothing imported yet — use Import in the library pane.</p>
    {/if}
  </div>
</div>
