<script lang="ts">
  // The filmstrip's own bar: search, the quick filters and the sort. What the library's
  // column used to carry, minus the folder tree and the collections — those pick *which*
  // photos and belong with the grid, these narrow what the strip under them is showing.
  //
  // Hand-built search box: the design system has no text field, so it is a bare input in a
  // token-styled shell, the same one the library uses.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import MagnifyingGlassIcon from "phosphor-svelte/lib/MagnifyingGlassIcon";
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
    class="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-input px-2 py-1
           focus-within:border-line-strong"
  >
    <MagnifyingGlassIcon size={13} class="shrink-0 text-faint" />
    <input
      class="min-w-0 flex-1 bg-transparent text-default outline-none placeholder:text-faint"
      placeholder="Search filename or camera"
      value={catalog.filter.query ?? ""}
      oninput={(event) => catalog.setQuery(event.currentTarget.value)}
      data-catalog-search
    />
    {#if catalog.filter.query}
      <button
        type="button"
        class="rounded-sm px-1 text-faint hover:text-default"
        title="Clear search"
        data-clear-search
        onclick={() => catalog.setQuery("")}
      >
        ×
      </button>
    {/if}
  </div>

  <div class="flex gap-0.5 rounded-md bg-raised p-0.5" role="group" aria-label="Quick filters">
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
