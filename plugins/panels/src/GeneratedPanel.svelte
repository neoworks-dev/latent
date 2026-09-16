<script lang="ts">
  // One collapsible section per `section` the engine describes, in Lightroom's order. The
  // whole Edit column is a single pane so the sections scroll together and their headers
  // stick to the top of that scroller.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
  import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
  import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
  import { defaultParams, groupEdited, type PanelGroup } from "./panels";
  import ParamControl from "./ParamControl.svelte";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const panels = ctx.panels;
  const viewer = ctx.viewer;

  function resetGroup(group: PanelGroup): void {
    // The viewer exposes no whole-stack write, so this is one update per op. The update
    // queue merges a single op's parameters into one call; each op is its own history step.
    for (const op of group.ops) void viewer.setParam(op.name, defaultParams(op), false);
  }
</script>

<div class="flex flex-col pb-4" data-pane="edit">
  {#each panels.groups as group (group.key)}
    {@const open = panels.isOpen(group.key)}
    {@const edited = groupEdited(viewer.stack, group)}
    <section data-section={group.key} data-open={open}>
      <header
        class="sticky top-0 z-raised flex items-center gap-1 border-b border-line-faint
               bg-elevated pr-2 pl-1"
      >
        <button
          type="button"
          class="flex flex-1 items-center gap-1.5 rounded-sm py-2 text-left text-xs
                 font-semibold text-default"
          aria-expanded={open}
          onclick={() => panels.toggle(group.key)}
          data-section-toggle={group.key}
        >
          {#if open}
            <CaretDownIcon size={12} weight="bold" />
          {:else}
            <CaretRightIcon size={12} weight="bold" />
          {/if}
          {group.label}
          {#if edited}
            <span class="size-1.5 rounded-full bg-action" title="Edited" data-edited={group.key}
            ></span>
          {/if}
        </button>
        <Tooltip text="Reset {group.label}" placement="left">
          <Button
            size="sm"
            variant="ghost"
            icon={ArrowCounterClockwiseIcon}
            disabled={!edited}
            onclick={() => resetGroup(group)}
          />
        </Tooltip>
      </header>
      {#if open}
        <div class="flex flex-col py-1.5">
          {#each group.ops as op (op.name)}
            {#each op.params as spec (spec.name)}
              <ParamControl {op} {spec} />
            {/each}
          {/each}
        </div>
      {/if}
    </section>
  {/each}
</div>
