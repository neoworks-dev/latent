<script lang="ts">
  // The undo stack, newest first, as Lightroom's History panel: one row per step saying
  // what moved and where it went, and clicking one takes the photo back to it. The list is
  // the engine's (`history.list`) — the UI holds no snapshots of its own.
  //
  // A step that moved several ops at once — a preset — unfolds into one row per op, and each
  // of those can be put back on its own without losing the rest of the step.
  import { kernelContext } from "@latent/contracts";
  import { Tooltip } from "@neoworks-dev/ui";
  import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
  import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
  import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
  import { SvelteSet } from "svelte/reactivity";
  import { historyRows } from "./history";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const viewer = ctx.viewer;
  const develop = ctx.develop;

  const rows = $derived(historyRows(develop.steps, ctx.panels.ops));
  const unfolded = new SvelteSet<number>();

  // The cursor moves once per committed edit — a whole slider drag is one — so this reads
  // the undo step rather than `revision`, which every transient tick of that drag bumps.
  $effect(() => {
    const photoId = viewer.photoId;
    void viewer.historyIndex;
    void viewer.historyDepth;
    void develop.refresh(photoId);
  });

  function jump(index: number): void {
    const photoId = viewer.photoId;
    if (photoId === null) return;
    void develop.jump(photoId, index);
  }

  function unfold(index: number): void {
    if (!unfolded.delete(index)) unfolded.add(index);
  }

  function revert(index: number, opId: string): void {
    const photoId = viewer.photoId;
    if (photoId === null) return;
    void develop.revertOp(photoId, index, opId);
  }
</script>

<div class="flex flex-col px-1 pb-2 text-xs" data-pane="history">
  {#each rows as row (row.index)}
    <div class="flex flex-col">
      <div class="flex items-center">
        {#if row.children.length > 0}
          <button
            type="button"
            class="rounded-sm p-0.5 text-faint hover:text-default"
            aria-expanded={unfolded.has(row.index)}
            title="Unfold {row.title}"
            data-history-unfold={row.index}
            onclick={() => unfold(row.index)}
          >
            {#if unfolded.has(row.index)}
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
          class="flex min-w-0 flex-1 items-baseline gap-2 rounded-sm px-2 py-1 text-left
                 text-muted hover:bg-hover hover:text-default"
          class:bg-raised={row.index === develop.index}
          class:text-default={row.index === develop.index}
          aria-current={row.index === develop.index}
          data-history-step={row.index}
          onclick={() => jump(row.index)}
        >
          <span class="min-w-0 flex-1 truncate">{row.title}</span>
          <!-- Steps above the cursor are the redo tail: they are still reachable, but they
               are not what the photo looks like, so they are drawn back. -->
          <span
            class="shrink-0 tabular-nums text-faint"
            class:opacity-50={row.index > develop.index}
          >
            {row.detail}
          </span>
        </button>
      </div>

      <!-- The ops of one batch. Clicking one is not a jump: the whole point is to keep the
           rest of the step, so each row only offers to put its own op back. -->
      {#if unfolded.has(row.index)}
        {#each row.children as child (child.opId)}
          <!-- The revert sits in the left gutter, under the caret: the right edge of the
               column is where the scrollbar's hit area lives. -->
          <div class="flex items-center gap-1 pl-4 text-faint">
            <Tooltip text="Revert {child.title}" placement="right">
              <button
                type="button"
                class="rounded-sm p-1 hover:bg-hover hover:text-default"
                data-history-revert={child.opId}
                onclick={() => revert(row.index, child.opId ?? "")}
              >
                <ArrowCounterClockwiseIcon size={11} weight="bold" />
              </button>
            </Tooltip>
            <span class="min-w-0 flex-1 truncate">{child.title}</span>
            <span class="shrink-0 pr-2 tabular-nums">{child.detail}</span>
          </div>
        {/each}
      {/if}
    </div>
  {/each}
  {#if rows.length === 0}
    <p class="px-2 py-1 text-faint">Nothing yet.</p>
  {/if}
</div>
