<script lang="ts">
  // The filmstrip's own bar: the quick filters and the sort. What the library's column used
  // to carry, minus the folder tree and the collections — those pick *which* photos and
  // belong with the grid, these narrow what the strip under them is showing. The search box
  // is in the window's header.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import SortAscendingIcon from "phosphor-svelte/lib/SortAscendingIcon";
  import SortDescendingIcon from "phosphor-svelte/lib/SortDescendingIcon";
  import SquaresFourIcon from "phosphor-svelte/lib/SquaresFourIcon";
  import { isSortKey, quickFilters, sameFilter, sortOptions } from "./catalog";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const catalog = ctx.catalog;
  const sortLabel = $derived(
    sortOptions.find((option) => option.value === catalog.sort)?.label ?? catalog.sort,
  );

  function cycleSort(): void {
    const index = sortOptions.findIndex((option) => option.value === catalog.sort);
    const next = sortOptions[(index + 1) % sortOptions.length];
    if (next) catalog.setSort(next.value, catalog.descending);
  }
</script>

<div
  class="flex items-center gap-2 border-b border-line px-3 py-1 text-xs"
  data-pane="strip-filter"
>
  <Tooltip text="Grid view — G" placement="top">
    <Button
      size="sm"
      variant={catalog.gridVisible ? "surface" : "ghost"}
      icon={SquaresFourIcon}
      onclick={() => catalog.toggleGrid()}
    />
  </Tooltip>

  <div
    class="ml-auto flex gap-0.5 rounded-md bg-raised p-0.5"
    role="group"
    aria-label="Quick filters"
  >
    {#each quickFilters as entry (entry.label)}
      {@const active = sameFilter(entry.filter, catalog.filter)}
      <button
        type="button"
        class="rounded-sm px-2 py-1 text-muted transition-colors duration-fast hover:text-default"
        class:bg-hover={active}
        class:text-default={active}
        aria-pressed={active}
        data-quick-filter={entry.label}
        onclick={() => catalog.setFilter(entry.filter)}
      >
        {entry.label}
      </button>
    {/each}
  </div>

  <!-- One button rather than a select: the bar is a strip of controls beside the photos,
       and the same five orders cycle in the space a dropdown would take. -->
  <div class="flex items-center gap-1" data-sort={catalog.sort}>
    <Tooltip text="Sort by {sortLabel} — click for the next" placement="top">
      <Button size="sm" variant="ghost" onclick={cycleSort}>{sortLabel}</Button>
    </Tooltip>
    <Tooltip text={catalog.descending ? "Newest first" : "Oldest first"} placement="top">
      <Button
        size="sm"
        variant="ghost"
        icon={catalog.descending ? SortDescendingIcon : SortAscendingIcon}
        onclick={() => catalog.setSort(catalog.sort, !catalog.descending)}
      />
    </Tooltip>
  </div>
</div>
