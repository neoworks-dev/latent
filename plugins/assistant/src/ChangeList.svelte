<script lang="ts">
  // Controls the agent moved — "Highlights 0 → −80" — one row each. A click shows the
  // control in the sidebar.
  import type { ChangeRow } from "./assistant";

  const { rows, onReveal }: { rows: ChangeRow[]; onReveal: (row: ChangeRow) => void } = $props();
</script>

<div class="flex flex-col" data-change-list>
  {#each rows as row, index (index)}
    <button
      type="button"
      class="-mx-1.5 flex items-baseline justify-between gap-3 rounded-sm px-1.5 py-0.5 text-left
             hover:bg-hover"
      title="Show in the sidebar"
      data-change-op={row.op}
      data-change-param={row.param ?? ""}
      onclick={() => onReveal(row)}
    >
      <span class="truncate text-default">{row.title}</span>
      <span class="shrink-0 font-mono text-2xs text-muted tabular-nums">{row.detail}</span>
    </button>
  {/each}
</div>
