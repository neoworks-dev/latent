<script lang="ts">
  // Lightroom's filmstrip: a fixed-height strip of square cells under the viewer. Hand-
  // built on purpose — the design system has no horizontal thumbnail strip (CLAUDE.md
  // lists the filmstrip as hand-built UI). The cell itself is `PhotoCell`, shared with the
  // grid; everything it shows comes from the engine's catalog rows.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import CaretLeftIcon from "phosphor-svelte/lib/CaretLeftIcon";
  import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
  import SquaresFourIcon from "phosphor-svelte/lib/SquaresFourIcon";
  import { filterLabel } from "./catalog";
  import PhotoCell from "./PhotoCell.svelte";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const catalog = ctx.catalog;
  const viewer = ctx.viewer;

  let strip = $state<HTMLDivElement | null>(null);

  const collectionName = $derived(
    catalog.collections.find((entry) => entry.collectionId === catalog.filter.collectionId)?.name,
  );
  const range = $derived(`${catalog.offset + 1}–${catalog.offset + catalog.photos.length}`);
  const current = $derived(catalog.selection.at(-1));

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

  // Arrow keys move the selection through cells that may be off screen; the strip follows.
  $effect(() => {
    const photoId = current;
    if (!strip || photoId === undefined) return;
    const cell = strip.querySelector(`[data-photo-id="${photoId}"]`);
    cell?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
      {range} of {catalog.total}
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
      <Tooltip text="Previous page" placement="top">
        <Button
          size="sm"
          variant="ghost"
          icon={CaretLeftIcon}
          disabled={catalog.offset === 0}
          onclick={() => catalog.page(-1)}
        />
      </Tooltip>
      <Tooltip text="Next page" placement="top">
        <Button
          size="sm"
          variant="ghost"
          icon={CaretRightIcon}
          disabled={catalog.offset + catalog.pageSize >= catalog.total}
          onclick={() => catalog.page(1)}
        />
      </Tooltip>
    </span>
  </div>

  <div
    bind:this={strip}
    class="flex min-h-0 flex-1 gap-1.5 overflow-x-auto overflow-y-hidden px-3 pb-2"
    role="listbox"
    aria-label="Filmstrip"
    aria-orientation="horizontal"
    tabindex="-1"
    onwheel={onWheel}
  >
    {#each catalog.photos as photo (photo.photoId)}
      <PhotoCell
        {photo}
        url={catalog.thumbnailUrl(photo)}
        selected={catalog.selection.includes(photo.photoId)}
        open={viewer.photoId === photo.photoId}
        cellClass="h-full w-[104px] shrink-0"
        onselect={(event) => click(event, photo.photoId)}
        onactivate={() => void catalog.open(photo.photoId)}
      />
    {/each}
    {#if catalog.photos.length === 0}
      <p class="self-center text-xs text-faint">
        Nothing imported yet — use Import in the library pane.
      </p>
    {/if}
  </div>
</div>
