<script lang="ts">
  // One tool call in the chat: what the agent did, in words, and every control it moved —
  // "Highlights 0 → −80" — read off the engine's own history rather than off the script, so
  // it is what changed and not what the agent meant to change. A row click shows the control
  // in the sidebar. The picture a preview returned is shown; the script itself folds out.
  import { kernelContext } from "@latent/contracts";
  import { LoadingSpinner } from "@neoworks-dev/ui";
  import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
  import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
  import CheckIcon from "phosphor-svelte/lib/CheckIcon";
  import XIcon from "phosphor-svelte/lib/XIcon";
  import { changeRows, toolInput, toolLabel, type ChangeRow, type ToolItem } from "./assistant";
  import ChangeList from "./ChangeList.svelte";

  const { item, onReveal }: { item: ToolItem; onReveal: (row: ChangeRow) => void } = $props();
  const panels = kernelContext().panels;

  let unfolded = $state(false);

  const rows = $derived(changeRows(item.steps ?? [], panels.ops));
  const code = $derived(toolInput(item.input));
  const foldable = $derived(code !== null || item.status === "failed");
</script>

<div class="flex flex-col gap-1" data-tool-call={item.id} data-tool-status={item.status}>
  <button
    type="button"
    class="flex items-center gap-1.5 text-left text-muted enabled:hover:text-default"
    disabled={!foldable}
    aria-expanded={unfolded}
    onclick={() => (unfolded = !unfolded)}
  >
    {#if item.status === "running"}
      <LoadingSpinner size={12} label="running" />
    {:else if item.status === "failed"}
      <XIcon size={12} weight="bold" class="text-red" />
    {:else}
      <CheckIcon size={12} weight="bold" class="text-green" />
    {/if}
    <span class="truncate">{toolLabel(item.title, item.input)}</span>
    {#if foldable}
      {#if unfolded}
        <CaretDownIcon size={10} class="text-faint" />
      {:else}
        <CaretRightIcon size={10} class="text-faint" />
      {/if}
    {/if}
  </button>

  {#if rows.length > 0}
    <div class="ml-[18px]" data-tool-changes>
      <ChangeList {rows} {onReveal} />
    </div>
  {/if}

  {#if unfolded}
    <div class="ml-[18px] flex flex-col gap-1">
      {#if code}
        <pre
          class="max-h-48 overflow-auto rounded-md bg-input p-2 font-mono text-2xs whitespace-pre-wrap
                 text-muted">{code}</pre>
      {/if}
      {#if item.status === "failed" && item.output}
        <pre
          class="max-h-32 overflow-auto rounded-md bg-red-soft p-2 font-mono text-2xs whitespace-pre-wrap
                 text-red">{item.output}</pre>
      {/if}
    </div>
  {/if}

  <!-- Always open: a mask the agent drew is only worth checking while it is working with it. -->
  {#if item.image}
    <img
      src={item.image}
      alt="What the agent looked at"
      class="ml-[18px] max-h-64 self-start rounded-md border border-line object-contain"
      data-tool-image
    />
  {/if}
</div>
