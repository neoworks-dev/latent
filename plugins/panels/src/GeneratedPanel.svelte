<script lang="ts">
  // The controls of one described section — Light, Color, Effects. One pane per section
  // rather than one for the whole column: a card is what the shell can fold, reorder and
  // drag out of the column, and a section that is not a card can do none of those.
  //
  // With `opId` it is one op instead: the Masks pane draws the selected layer's own
  // sliders under its component list, writing to that stack entry.
  import { kernelContext } from "@latent/contracts";
  import type { OpDefinition } from "@latent/protocol";
  import SelectionBackgroundIcon from "phosphor-svelte/lib/SelectionBackgroundIcon";
  import CurveEditor from "./CurveEditor.svelte";
  import MixerEditor from "./MixerEditor.svelte";
  import {
    curveParams,
    generatedParams,
    layerBadge,
    layerEntryId,
    mixerParams,
    opEntry,
    sectionOf,
  } from "./panels";
  import ParamControl from "./ParamControl.svelte";

  const {
    paneId = "",
    opId = null,
  }: {
    /**
     * The pane this is drawn in. The Edit column registers one pane per described section
     * — `edit:light`, `edit:color` — so each is its own card and can be dragged out; the
     * part after the colon is the group this instance draws.
     */
    paneId?: string;
    /** Draw only this stack entry's controls, with no section chrome around them. */
    opId?: string | null;
  } = $props();
  const ctx = kernelContext();
  const panels = ctx.panels;
  const viewer = ctx.viewer;

  const single = $derived(opId ? opEntry(viewer.stack, opId) : undefined);
  const singleDefinition = $derived(panels.ops.find((op) => op.name === single?.op));
  const group = $derived(panels.groups.find((entry) => entry.key === sectionOf(paneId)));
  // The Masks panel holds a mask selected: these sliders are that mask's. A parameter it
  // already holds is read and written on its own stack entry; one it does not goes through
  // `setParam`, which the viewer routes into the layer and adds it there.
  const target = $derived(viewer.maskTarget);

  let column = $state<HTMLDivElement | null>(null);

  // Selecting a layer in the Layers or Masks column scrolls the Edit card holding that op
  // into view. Each card draws one section, so only the card that has the op reacts.
  $effect(() => {
    const selected = viewer.selectedOpId;
    const element = column;
    if (opId || !selected || !element) return;
    const entry = viewer.stack.find((candidate) => candidate.id === selected);
    if (!entry) return;
    element.querySelector(`[data-op="${entry.op}"]`)?.scrollIntoView({ block: "nearest" });
  });

  function openMask(badgeOpId: string): void {
    viewer.selectOp(badgeOpId);
    // A generative op carries a mask without being a layer, so it is only selected: nothing
    // but a layer can catch this column's writes.
    const entry = viewer.stack.find((candidate) => candidate.id === badgeOpId);
    if (entry?.op === "group") viewer.setMaskTarget(badgeOpId);
    ctx.panes.setRailPane("masks");
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
{:else if group}
  <!-- One section. The card around it is the shell's: its title bar is the drag handle and
       the fold, and the Reset beside it comes from `headerActions`. -->
  <div
    bind:this={column}
    class="flex flex-col py-1.5"
    data-pane="edit"
    data-section={group.key}
    data-mask-target={target ?? ""}
  >
    {#each group.ops as op (op.name)}
      {@const badge = target ? null : layerBadge(viewer.stack, op)}
      {#if badge}
        <!-- The slider above is the global one. This says the same adjustment is also inside
             a mask — a different stack entry — and hands the column over to Masks. -->
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
            {#if badge.layers > 0}
              <span>in {badge.layers} mask{badge.layers === 1 ? "" : "s"}</span>
            {:else if badge.components > 0}
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
      {@render controls(op, layerEntryId(viewer.stack, target, op.name))}
    {/each}
  </div>
{/if}
