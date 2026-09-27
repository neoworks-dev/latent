<script lang="ts">
  // The end of a turn that changed the photo, finished or stopped: every control it left
  // somewhere else, once each, and one Undo for the lot.
  import { kernelContext } from "@latent/contracts";
  import type { HistoryStep } from "@latent/protocol";
  import { Button } from "@neoworks-dev/ui";
  import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
  import { netChangeRows, type ChangeRow } from "./assistant";
  import ChangeList from "./ChangeList.svelte";

  const {
    steps,
    undone,
    onUndo,
    onReveal,
  }: {
    steps: HistoryStep[];
    undone: boolean;
    onUndo: () => void;
    onReveal: (row: ChangeRow) => void;
  } = $props();
  const ctx = kernelContext();

  const rows = $derived(netChangeRows(steps, ctx.panels.ops));
</script>

<div class="flex flex-col gap-1 rounded-md border border-line p-2" data-assistant-summary>
  <div class="flex items-center gap-2">
    <span class="flex-1 text-muted">
      {rows.length === 1 ? "1 edit" : `${rows.length} edits`} this turn
    </span>
    {#if undone}
      <span class="text-faint">Undone</span>
    {:else}
      <Button
        size="sm"
        variant="ghost"
        icon={ArrowCounterClockwiseIcon}
        disabled={ctx.assistant.running}
        onclick={onUndo}>Undo</Button
      >
    {/if}
  </div>
  {#if !undone}
    <ChangeList {rows} {onReveal} />
  {/if}
</div>
