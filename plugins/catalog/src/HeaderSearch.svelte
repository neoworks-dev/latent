<script lang="ts">
  // The search box in the window's header. Hand-built: the design system has no text field,
  // so it is a bare input in a token-styled shell.
  import { kernelContext } from "@latent/contracts";
  import MagnifyingGlassIcon from "phosphor-svelte/lib/MagnifyingGlassIcon";

  const { paneId: _paneId }: { paneId: string } = $props();
  const catalog = kernelContext().catalog;
</script>

<div
  class="flex w-full max-w-xl items-center gap-2 rounded-md border border-line bg-input px-2 py-1
         text-xs focus-within:border-line-strong"
  data-pane="search"
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
