<script lang="ts">
  // The Info mode of the right rail: the catalog row of the photo the viewer has open.
  // Label/value rows are two spans, not ListRow — ListRow is a 44 px card with its own
  // surface, and this is a dense metadata table like Lightroom's Info panel.
  import { kernelContext } from "@latent/contracts";
  import { infoRows } from "./catalog";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const catalog = ctx.catalog;
  const viewer = ctx.viewer;

  const photo = $derived(
    catalog.photos.find((row) => row.photoId === viewer.photoId) ?? catalog.openRow,
  );

  // A photo opened from outside the listed page (the `?photo=` hook, a script) has no row
  // in `photos`; one `catalog.get` fills it in.
  $effect(() => {
    const photoId = viewer.photoId;
    if (photoId === null) return;
    void catalog.loadRow(photoId);
  });
</script>

<div class="flex flex-col gap-2 px-3 pt-1 pb-3 text-xs" data-pane="info">
  {#if photo}
    <p class="truncate text-sm font-semibold text-default" title={photo.path}>{photo.filename}</p>
    <dl class="flex flex-col">
      {#each infoRows(photo) as row (row.label)}
        <div class="flex items-baseline gap-3 border-b border-line-faint py-1 last:border-b-0">
          <dt class="w-20 shrink-0 text-dim">{row.label}</dt>
          <dd
            class="min-w-0 flex-1 truncate text-right text-default"
            title={row.title ?? row.value}
          >
            {row.value}
          </dd>
        </div>
      {/each}
    </dl>
  {:else}
    <p class="text-faint">No photo open.</p>
  {/if}
</div>
