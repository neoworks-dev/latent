<script lang="ts">
  // Grid view: a centre pane that covers the viewer with every photo the filter matches,
  // under capture-date titles. `G` toggles it, the size slider scales the cells,
  // double-click or Enter opens a photo and hands the centre region back to the viewer.
  //
  // The whole catalog is one scroll, so the cells are windowed: the layout is arithmetic
  // over every row (`gridSections`), the DOM holds the rows near the scrollport
  // (`gridWindow`), and only those cells' thumbnails are ever asked for.
  //
  // The size slider is a native range input: the design system has no slider, and the
  // panel column's is bound to an op parameter.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import { untrack } from "svelte";
  import XIcon from "phosphor-svelte/lib/XIcon";
  import {
    filterLabel,
    gridGap,
    gridHeaderHeight,
    gridSections,
    gridSizeRange,
    gridWindow,
  } from "./catalog";
  import Library from "./Library.svelte";
  import PhotoCell from "./PhotoCell.svelte";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const catalog = ctx.catalog;
  const viewer = ctx.viewer;
  // The grid is a card like any other: it fills the hole the floating panels leave rather
  // than the whole window, so the filmstrip and the columns stay readable beside it.
  const area = $derived(ctx.panes.safeArea);

  // The rows are laid out against the scroller's content box, so the widths have to come
  // from a measured element rather than the pane's safe area: the library aside and the
  // scrollbar are both inside it.
  let contentWidth = $state(0);
  let viewportHeight = $state(0);
  let scrollTop = $state(0);

  // The layout is the whole catalog — arithmetic over the rows the engine listed, cheap
  // enough to redo when the pane is resized or the size slider moves. Only the rows near
  // the scrollport are drawn.
  const sections = $derived(gridSections(catalog.photos, contentWidth, catalog.gridSize));
  const lastSection = $derived(sections.at(-1));
  const contentHeight = $derived(lastSection ? lastSection.top + lastSection.height : 0);
  const windowed = $derived(gridWindow(sections, scrollTop, viewportHeight));

  // What the drawn cells need decoded. Untracked: the call reads the thumbnail cache it
  // also writes, and a tracked read of it would re-run this effect on every frame that
  // arrives.
  $effect(() => {
    const photos = windowed.flatMap((entry) =>
      entry.rows.flatMap((row) => row.cells.map((cell) => cell.photo)),
    );
    untrack(() => catalog.needThumbnails("grid", photos));
  });

  const collectionName = $derived(
    catalog.collections.find((entry) => entry.collectionId === catalog.filter.collectionId)?.name,
  );

  function activate(photoId: number): void {
    catalog.select(photoId, { shift: false, ctrl: false });
    void catalog.openSelected();
  }
</script>

{#if catalog.gridVisible}
  <!-- Above the floating cards, not under them: a card left over the middle of the window
       would otherwise sit on top of the page of photos it is nothing to do with. -->
  <div
    class="absolute z-modal flex flex-col overflow-hidden rounded-lg border border-line
           bg-canvas shadow-lg"
    style:left="{area.left}px"
    style:top="{area.top}px"
    style:right="{area.right}px"
    style:bottom="{area.bottom}px"
    data-pane="grid"
  >
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

    <div class="flex min-h-0 flex-1">
      <!-- Where the photos come from, beside the photos themselves: import, the folder
           tree and the collections choose what the grid is showing. -->
      <aside class="w-64 shrink-0 overflow-y-auto border-r border-line" data-grid-library>
        <Library paneId="library" />
      </aside>
      <!-- A stable gutter, not `overflow-y-auto`'s: the rows are measured against this
           box, and a scrollbar that comes and goes with the row count would relayout them
           into it and back out again. -->
      <!-- No padding on the top edge: the titles stick to `top: 0`, which is the scrollport
           edge and not the content box, so the space above the first one has to be the
           title's own or a row shows through above a stuck title. -->
      <div
        class="min-h-0 flex-1 overflow-y-auto px-3 pb-3"
        style:scrollbar-gutter="stable"
        role="listbox"
        aria-label="Grid"
        tabindex="-1"
        bind:clientHeight={viewportHeight}
        onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
      >
        <!-- Every box in here is placed at the offset the layout gave it rather than
             stacked in flow: the rows off screen are not drawn, so there is no flow for
             the rest to sit in. The height is the whole catalog's, which is what the
             scrollbar measures. -->
        <div class="relative" style:height="{contentHeight}px" bind:clientWidth={contentWidth}>
          {#each windowed as entry (entry.section.key)}
            <section
              class="absolute inset-x-0"
              style:top="{entry.section.top}px"
              style:height="{entry.section.height}px"
              data-grid-section={entry.section.key}
            >
              <!-- Bled over the scroller's side padding so the day you are looking at stays
                   named, opaque, while its rows go past under it. Its height is the
                   layout's `gridHeaderHeight`, not whatever the text measures to. -->
              <h2
                class="sticky top-0 z-raised -mx-3 flex items-baseline gap-2 bg-canvas px-3 pt-3
                       pb-1 text-xs font-semibold text-default"
                style:height="{gridHeaderHeight}px"
              >
                {entry.section.title}
                <span class="font-normal tabular-nums text-muted">{entry.section.count}</span>
              </h2>
              {#each entry.rows as row (row.cells[0].photo.photoId)}
                <div
                  class="absolute inset-x-0 flex"
                  style:gap="{gridGap}px"
                  style:top="{row.top - entry.section.top}px"
                  style:height="{row.height}px"
                >
                  {#each row.cells as cell (cell.photo.photoId)}
                    <PhotoCell
                      photo={cell.photo}
                      url={catalog.thumbnailUrl(cell.photo)}
                      selected={catalog.selection.includes(cell.photo.photoId)}
                      open={viewer.photoId === cell.photo.photoId}
                      cellClass="h-full shrink-0"
                      cellStyle="width: {cell.width}px"
                      onselect={(event) =>
                        catalog.select(cell.photo.photoId, {
                          shift: event.shiftKey,
                          ctrl: event.ctrlKey || event.metaKey,
                        })}
                      onactivate={() => activate(cell.photo.photoId)}
                    />
                  {/each}
                </div>
              {/each}
            </section>
          {/each}
        </div>
        {#if catalog.photos.length === 0}
          <p class="pt-3 text-xs text-faint">
            Nothing imported yet — use Files… or Folder… beside.
          </p>
        {/if}
      </div>
    </div>

    <footer class="border-t border-line bg-elevated px-3 py-1 text-2xs text-dim">
      Double-click or Enter opens · arrows move · 0–5 rate · P pick · X reject
    </footer>
  </div>
{/if}
