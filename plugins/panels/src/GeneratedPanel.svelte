<script lang="ts">
  // One collapsible section per `section` the engine describes, in Lightroom's order. The
  // whole Edit column is a single pane so the sections scroll together and their headers
  // stick to the top of that scroller.
  //
  // With `opId` it is one op instead of the column: the Masks pane draws the selected
  // layer's own sliders under its component list, writing to that stack entry.
  import { kernelContext } from "@latent/contracts";
  import type { OpDefinition } from "@latent/protocol";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
  import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
  import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
  import SelectionBackgroundIcon from "phosphor-svelte/lib/SelectionBackgroundIcon";
  import CurveEditor from "./CurveEditor.svelte";
  import MixerEditor from "./MixerEditor.svelte";
  import {
    curveParams,
    defaultParams,
    generatedParams,
    groupEdited,
    layerBadge,
    mixerParams,
    type PanelGroup,
  } from "./panels";
  import ParamControl from "./ParamControl.svelte";

  const {
    paneId: _paneId,
    opId = null,
  }: {
    paneId?: string;
    /** Draw only this stack entry's controls, with no section chrome around them. */
    opId?: string | null;
  } = $props();
  const ctx = kernelContext();
  const panels = ctx.panels;
  const viewer = ctx.viewer;

  const single = $derived(viewer.stack.find((entry) => entry.id === opId));
  const singleDefinition = $derived(panels.ops.find((op) => op.name === single?.op));

  let column = $state<HTMLDivElement | null>(null);

  // Selecting a layer in the Layers or Masks column points the Edit column at it.
  $effect(() => {
    const selected = viewer.selectedOpId;
    const element = column;
    if (opId || !selected || !element) return;
    const entry = viewer.stack.find((candidate) => candidate.id === selected);
    if (!entry) return;
    element.querySelector(`[data-op="${entry.op}"]`)?.scrollIntoView({ block: "nearest" });
  });

  function resetGroup(group: PanelGroup): void {
    // The viewer exposes no whole-stack write, so this is one update per op. The update
    // queue merges a single op's parameters into one call; each op is its own history step.
    for (const op of group.ops) void viewer.setParam(op.name, defaultParams(op), false);
  }

  function openMask(badgeOpId: string): void {
    viewer.selectOp(badgeOpId);
    ctx.panes.setMode("masks");
  }
</script>

<!--
  One op's controls. Two ops are drawn by a hand-built editor instead of by a row per
  parameter, because Lightroom shows them as one control: the tone curve is one graph with
  a tab per channel rather than four arrays in a row, and the colour mixer is eight rows
  with a tab per channel rather than twenty-four sliders. Each editor takes its whole op.
-->
{#snippet controls(definition: OpDefinition, entryId: string | null)}
  {@const curve = curveParams(definition)}
  {@const mixer = mixerParams(definition)}
  {#if curve}
    <CurveEditor op={definition} {curve} opId={entryId} />
  {/if}
  {#if mixer}
    <MixerEditor op={definition} {mixer} opId={entryId} />
  {/if}
  {#each generatedParams(definition) as spec (spec.name)}
    <ParamControl op={definition} {spec} opId={entryId} />
  {/each}
{/snippet}

{#if opId}
  <div class="flex flex-col py-1" data-pane="op-panel" data-op-panel={opId}>
    {#if single && singleDefinition}
      {@render controls(singleDefinition, opId)}
    {:else}
      <p class="px-3 py-2 text-xs text-faint">This op has no generated controls.</p>
    {/if}
  </div>
{:else}
  <div bind:this={column} class="flex flex-col pb-4" data-pane="edit">
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
              {@const badge = layerBadge(viewer.stack, op)}
              {#if badge}
                <!-- The op is a layer: it carries a mask, an opacity below full, or both.
                     Clicking hands the column over to Masks with this op selected. -->
                <div class="px-3 pt-1">
                  <button
                    type="button"
                    class="flex w-full items-center gap-1.5 rounded-sm bg-raised px-1.5 py-0.5
                           text-[10px] text-muted transition-colors hover:text-default"
                    onclick={() => openMask(badge.opId)}
                    title="Edit this mask"
                    data-mask-badge={op.name}
                  >
                    <SelectionBackgroundIcon size={11} weight="bold" />
                    {#if badge.components > 0}
                      <span>{badge.components} mask{badge.components === 1 ? "" : "s"}</span>
                    {:else}
                      <span>Layer</span>
                    {/if}
                    {#if badge.opacity < 100}
                      <span class="ml-auto tabular-nums" data-mask-badge-opacity={op.name}>
                        {Math.round(badge.opacity)}%
                      </span>
                    {/if}
                  </button>
                </div>
              {/if}
              {@render controls(op, null)}
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  </div>
{/if}
