<script lang="ts">
  // The Reset in one generated section's title bar. The shell's card draws the heading and
  // the fold; this is the part only the panel knows — whether the section has been edited,
  // and what "back to default" means for the ops in it.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
  import SelectionBackgroundIcon from "phosphor-svelte/lib/SelectionBackgroundIcon";
  import { defaultParams, groupEdited, maskTargetLabel, sectionOf } from "./panels";

  const { paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const group = $derived(ctx.panels.groups.find((entry) => entry.key === sectionOf(paneId)));
  // A selected mask is where this section's sliders go, so it is also what "edited" and
  // "reset" mean here: the mask's values, not the photo's.
  const target = $derived(ctx.viewer.maskTarget);
  const targetLabel = $derived(maskTargetLabel(ctx.viewer.stack, target));
  const edited = $derived(group ? groupEdited(ctx.viewer.stack, group, target) : false);

  function reset(): void {
    if (!group) return;
    // The viewer exposes no whole-stack write, so this is one update per op. The update
    // queue merges a single op's parameters into one call; each op is its own history step.
    for (const op of group.ops) void ctx.viewer.setParam(op.name, defaultParams(op), false);
  }
</script>

<span class="flex items-center gap-1">
  {#if targetLabel}
    <!-- Where these sliders are writing. Without it the column looks global while it is not. -->
    <button
      type="button"
      class="flex items-center gap-1 rounded-sm bg-raised px-1.5 py-0.5 text-[10px] text-muted
             transition-colors hover:text-default"
      title="These sliders apply to {targetLabel}"
      data-mask-target-chip={targetLabel}
      onclick={() => ctx.panes.setRailPane("masks")}
    >
      <SelectionBackgroundIcon size={11} weight="bold" />
      <span>{targetLabel}</span>
    </button>
  {/if}
  {#if edited}
    <span class="size-1.5 rounded-full bg-action" title="Edited" data-edited={group?.key}></span>
  {/if}
  <Tooltip text="Reset {group?.label ?? 'section'}" placement="left">
    <Button
      size="sm"
      variant="ghost"
      icon={ArrowCounterClockwiseIcon}
      disabled={!edited}
      onclick={reset}
    />
  </Tooltip>
</span>
