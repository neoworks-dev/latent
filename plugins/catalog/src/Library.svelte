<script lang="ts">
  // Left column: where the filmstrip's photos come from. Import, search, quick filters,
  // sort, the folder tree and collections. Every row is a `catalog.list` filter — nothing
  // here filters client-side.
  //
  // Hand-built controls, and why: the design system has no text field (search and the
  // collection name box are bare inputs in a token-styled shell), no segmented control
  // (the quick filters are buttons in one raised track), and no menu (the collection
  // overflow is a small popover). Tree and collection rows are 24 px dense rows rather
  // than `ListRow`, which is a 44 px card with its own surface.
  import { kernelContext } from "@latent/contracts";
  import type { MergeKind } from "@latent/protocol";
  import { Button, SectionHeader, Select, Tooltip } from "@neoworks-dev/ui";
  import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
  import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
  import DotsThreeIcon from "phosphor-svelte/lib/DotsThreeIcon";
  import FilesIcon from "phosphor-svelte/lib/FilesIcon";
  import FolderOpenIcon from "phosphor-svelte/lib/FolderOpenIcon";
  import MagnifyingGlassIcon from "phosphor-svelte/lib/MagnifyingGlassIcon";
  import PlusIcon from "phosphor-svelte/lib/PlusIcon";
  import SortAscendingIcon from "phosphor-svelte/lib/SortAscendingIcon";
  import SortDescendingIcon from "phosphor-svelte/lib/SortDescendingIcon";
  import { folderRows, folderTree, isSortKey, sortOptions, type CatalogFilter } from "./catalog";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const catalog = ctx.catalog;

  const rows = $derived(folderRows(folderTree(catalog.folders), catalog.collapsedFolders));
  // Photo Merge is not the catalog's feature: the library only says which photos and which
  // kind, on a kernel event. Whoever owns the dialog listens for it.
  const mergeKinds: { kind: MergeKind; label: string }[] = [
    { kind: "hdr", label: "HDR" },
    { kind: "panorama", label: "Panorama" },
    { kind: "hdrPanorama", label: "HDR Pano" },
  ];
  const quickFilters: { label: string; filter: CatalogFilter }[] = [
    { label: "All", filter: {} },
    { label: "Picks", filter: { flag: "pick" } },
    { label: "Rejects", filter: { flag: "reject" } },
    { label: "3★+", filter: { minRating: 3 } },
  ];

  let newCollection = $state("");
  let renamingId = $state<number | null>(null);
  let renameText = $state("");
  let menuId = $state<number | null>(null);

  // The quick filters are the only objects that produce these shapes, so comparing the
  // serialised filter is enough to know which row is the current one.
  function isActive(filter: CatalogFilter): boolean {
    return JSON.stringify(filter) === JSON.stringify(catalog.filter);
  }

  /** Enter commits whichever text field has focus: the new-collection box or a rename. */
  function submitOnEnter(event: KeyboardEvent): void {
    if (event.key !== "Enter") return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement)) return;
    target.blur();
    if (renamingId !== null) return;
    void createCollection();
  }

  function startMerge(kind: MergeKind): void {
    ctx.emit("catalog/merge", kind, [...catalog.selection]);
  }

  async function importFiles(): Promise<void> {
    const paths = await window.latentDesktop?.pickFiles();
    await catalog.importPaths(paths ?? [], false);
  }

  async function importFolder(): Promise<void> {
    const directory = await window.latentDesktop?.pickDirectory();
    if (!directory) return;
    await catalog.importPaths([directory], true);
  }

  async function createCollection(): Promise<void> {
    const name = newCollection.trim();
    if (!name) return;
    newCollection = "";
    await catalog.createCollection(name);
  }

  function startRename(collectionId: number, name: string): void {
    menuId = null;
    renamingId = collectionId;
    renameText = name;
  }

  async function commitRename(): Promise<void> {
    const collectionId = renamingId;
    const name = renameText.trim();
    renamingId = null;
    if (collectionId === null || !name) return;
    await catalog.renameCollection(collectionId, name);
  }

  function runMenu(action: () => Promise<void>): void {
    menuId = null;
    void action();
  }

  // An open popover closes on the next click anywhere else. Raw listener, with its
  // inverse — Svelte reverts it when the pane unmounts.
  $effect(() => {
    if (menuId === null) return;
    const close = (): void => {
      menuId = null;
    };
    window.addEventListener("click", close, { capture: true });
    return () => window.removeEventListener("click", close, { capture: true });
  });
</script>

<div class="flex h-full flex-col gap-3 overflow-y-auto px-3 pt-1 pb-3 text-xs">
  <div class="flex gap-1">
    <Tooltip text="Import selected raw files" placement="bottom">
      <Button size="sm" icon={FilesIcon} onclick={() => void importFiles()}>Files…</Button>
    </Tooltip>
    <Tooltip text="Import a folder and everything under it" placement="bottom">
      <Button size="sm" icon={FolderOpenIcon} onclick={() => void importFolder()}>Folder…</Button>
    </Tooltip>
  </div>

  <div
    class="flex items-center gap-2 rounded-md border border-line bg-input px-2 py-1.5
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
      <button
        type="button"
        class="flex-1 rounded-sm px-2 py-1 text-muted transition-colors duration-fast
               hover:text-default"
        class:bg-hover={isActive(entry.filter)}
        class:text-default={isActive(entry.filter)}
        aria-pressed={isActive(entry.filter)}
        data-quick-filter={entry.label}
        onclick={() => catalog.setFilter(entry.filter)}
      >
        {entry.label}
      </button>
    {/each}
  </div>

  <!-- Lightroom's Photo > Photo Merge, which only means anything on two or more photos. -->
  {#if catalog.selection.length >= 2}
    <div data-photo-merge={catalog.selection.length}>
      <SectionHeader title="Photo Merge" />
      <div class="flex gap-1">
        {#each mergeKinds as entry (entry.kind)}
          <span data-merge-start={entry.kind}>
            <Button size="sm" variant="ghost" onclick={() => startMerge(entry.kind)}>
              {entry.label}
            </Button>
          </span>
        {/each}
      </div>
    </div>
  {/if}

  <div class="flex items-center gap-1" data-sort={catalog.sort}>
    <span class="text-dim">Sort</span>
    <div class="min-w-0 flex-1">
      <Select
        value={catalog.sort}
        options={sortOptions}
        onChange={(value) => {
          if (typeof value === "string" && isSortKey(value)) {
            catalog.setSort(value, catalog.descending);
          }
        }}
      />
    </div>
    <Tooltip text={catalog.descending ? "Newest first" : "Oldest first"} placement="bottom">
      <Button
        size="sm"
        variant="ghost"
        icon={catalog.descending ? SortDescendingIcon : SortAscendingIcon}
        onclick={() => catalog.setSort(catalog.sort, !catalog.descending)}
      />
    </Tooltip>
  </div>

  <div>
    <SectionHeader title="Folders" />
    {#each rows as row (row.node.path)}
      <div class="flex items-center" style:padding-left="{row.node.depth * 12}px">
        {#if row.hasChildren}
          <button
            type="button"
            class="rounded-sm p-0.5 text-faint hover:text-default"
            aria-expanded={row.expanded}
            title="Fold {row.node.label}"
            data-folder-toggle={row.node.path}
            onclick={() => catalog.toggleFolder(row.node.path)}
          >
            {#if row.expanded}
              <CaretDownIcon size={11} weight="bold" />
            {:else}
              <CaretRightIcon size={11} weight="bold" />
            {/if}
          </button>
        {:else}
          <span class="w-4"></span>
        {/if}
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 py-1 text-left
                 text-muted hover:bg-hover hover:text-default"
          class:bg-raised={catalog.filter.folder === row.node.path}
          class:text-default={catalog.filter.folder === row.node.path}
          data-folder={row.node.path}
          onclick={() => catalog.setFilter({ folder: row.node.path })}
        >
          <span class="truncate">{row.node.label}</span>
          <span class="ml-auto shrink-0 tabular-nums text-faint">{row.node.count}</span>
        </button>
      </div>
    {/each}
    {#if rows.length === 0}
      <p class="px-2 text-faint">No folders yet.</p>
    {/if}
  </div>

  <div>
    <SectionHeader title="Collections" />
    <div class="flex flex-col">
      {#each catalog.collections as collection (collection.collectionId)}
        {#if renamingId === collection.collectionId}
          <input
            class="w-full rounded-sm border border-line-strong bg-input px-2 py-1 text-default
                   outline-none"
            bind:value={renameText}
            onblur={() => void commitRename()}
            onkeydown={submitOnEnter}
            data-collection-rename={collection.collectionId}
          />
        {:else}
          <div class="relative flex items-center">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 py-1 text-left
                     text-muted hover:bg-hover hover:text-default"
              class:bg-raised={catalog.filter.collectionId === collection.collectionId}
              class:text-default={catalog.filter.collectionId === collection.collectionId}
              data-collection={collection.collectionId}
              onclick={() => catalog.setFilter({ collectionId: collection.collectionId })}
            >
              <span class="truncate">{collection.name}</span>
              <span class="ml-auto shrink-0 tabular-nums text-faint">{collection.count}</span>
            </button>
            <button
              type="button"
              class="rounded-sm px-1 text-faint hover:text-default"
              title="Collection actions"
              aria-haspopup="menu"
              data-collection-menu={collection.collectionId}
              onclick={(event) => {
                event.stopPropagation();
                menuId = menuId === collection.collectionId ? null : collection.collectionId;
              }}
            >
              <DotsThreeIcon size={14} weight="bold" />
            </button>
            {#if menuId === collection.collectionId}
              <div
                class="absolute top-full right-0 z-overlay flex w-44 flex-col rounded-md border
                       border-line bg-elevated py-1 shadow-lg"
                role="menu"
                data-collection-actions={collection.collectionId}
              >
                <button
                  type="button"
                  class="px-3 py-1.5 text-left text-muted hover:bg-hover hover:text-default"
                  role="menuitem"
                  onclick={() => startRename(collection.collectionId, collection.name)}
                >
                  Rename…
                </button>
                <button
                  type="button"
                  class="px-3 py-1.5 text-left text-muted hover:bg-hover hover:text-default
                         disabled:opacity-40"
                  role="menuitem"
                  disabled={catalog.selection.length === 0}
                  onclick={() => runMenu(() => catalog.addSelectionTo(collection.collectionId))}
                >
                  Add selected
                </button>
                <button
                  type="button"
                  class="px-3 py-1.5 text-left text-muted hover:bg-hover hover:text-default
                         disabled:opacity-40"
                  role="menuitem"
                  disabled={catalog.selection.length === 0}
                  onclick={() =>
                    runMenu(() => catalog.removeSelectionFrom(collection.collectionId))}
                >
                  Remove selected
                </button>
                <button
                  type="button"
                  class="px-3 py-1.5 text-left text-red hover:bg-hover"
                  role="menuitem"
                  onclick={() => runMenu(() => catalog.deleteCollection(collection.collectionId))}
                >
                  Delete
                </button>
              </div>
            {/if}
          </div>
        {/if}
      {/each}
      <div class="mt-1 flex gap-1">
        <input
          class="min-w-0 flex-1 rounded-md border border-line bg-input px-2 py-1.5 text-default
                 outline-none focus:border-line-strong placeholder:text-faint"
          placeholder="New collection"
          bind:value={newCollection}
          onkeydown={submitOnEnter}
        />
        <Button size="sm" variant="ghost" icon={PlusIcon} onclick={() => void createCollection()}>
          Create
        </Button>
      </div>
    </div>
  </div>

  {#if catalog.error}
    <p class="text-red">{catalog.error}</p>
  {/if}
</div>
