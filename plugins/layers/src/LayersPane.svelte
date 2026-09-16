<script lang="ts">
  // The stack top-down, Luminar's Layers column. One row per op: what it is, what its mask
  // covers, whether it is on, how strongly it applies. Every control writes the stack and
  // waits for the engine's answer — the list is a view of `viewer.stack` and nothing else.
  import { kernelContext } from "@latent/contracts";
  import { duplicateOp, dropIndex, layerRows, removeOp, reorderByDisplay, soloed } from "./layers";
  import LayerRow from "./LayerRow.svelte";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const viewer = ctx.viewer;
  const layers = ctx.layers;

  const rows = $derived(layerRows(viewer.stack));

  let list = $state<HTMLUListElement | null>(null);
  // Measured once per drag: the column re-renders while a row is being dragged and a live
  // measurement would move the drop target out from under the pointer.
  let bounds: { top: number; bottom: number }[] = [];
  let dragFrom = -1;

  function beginDrag(displayIndex: number, event: PointerEvent): void {
    const element = list;
    if (!element) return;
    bounds = [...element.querySelectorAll("[data-layer-row]")].map((row) => {
      const box = row.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    });
    dragFrom = displayIndex;
    layers.dragging = rows[displayIndex]?.op.id ?? null;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }

  function endDrag(event: PointerEvent): void {
    if (dragFrom < 0) return;
    const to = dropIndex(bounds, event.clientY);
    const from = dragFrom;
    dragFrom = -1;
    layers.dragging = null;
    if (to === from) return;
    void viewer.setStack(reorderByDisplay(viewer.stack, from, to));
  }

  function select(opId: string): void {
    viewer.selectOp(opId);
  }

  function toggle(opId: string, enabled: boolean, alt: boolean): void {
    if (alt) {
      void viewer.setStack(soloed(viewer.stack, opId));
      return;
    }
    void viewer.setEnabled(opId, enabled);
  }

  // The thumbnails follow the stack: one preview per mask, cached by its signature.
  $effect(() => {
    layers.sync(viewer.stack);
  });
</script>

<div class="flex flex-col pb-4 text-xs" data-pane="layers" data-layer-count={rows.length}>
  {#if rows.length === 0}
    <p class="px-3 py-3 text-muted">No adjustments yet. Move a slider in the Edit column.</p>
  {:else}
    <ul bind:this={list} class="flex flex-col">
      {#each rows as row, displayIndex (row.op.id)}
        <LayerRow
          op={row.op}
          {displayIndex}
          selected={viewer.selectedOpId === row.op.id}
          onSelect={() => select(row.op.id)}
          onToggle={(alt) => toggle(row.op.id, !row.op.enabled, alt)}
          onDuplicate={() => void viewer.setStack(duplicateOp(viewer.stack, row.op.id))}
          onDelete={() => void viewer.setStack(removeOp(viewer.stack, row.op.id))}
          onDragStart={(event) => beginDrag(displayIndex, event)}
          onDragEnd={endDrag}
        />
      {/each}
    </ul>
  {/if}
</div>
