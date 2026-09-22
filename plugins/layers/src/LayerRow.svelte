<script lang="ts">
  // One layer. The row is not a ListRow: that is a 44 px card with its own surface, and
  // this is a dense list line with a thumbnail, four controls and a drag handle, the way
  // Luminar's layer list reads.
  import { kernelContext } from "@latent/contracts";
  import { KindIcon } from "@latent/plugin-masks";
  import { ValueField } from "@latent/plugin-panels";
  import type { Op } from "@latent/protocol";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import CopyIcon from "phosphor-svelte/lib/CopyIcon";
  import DotsSixVerticalIcon from "phosphor-svelte/lib/DotsSixVerticalIcon";
  import EyeIcon from "phosphor-svelte/lib/EyeIcon";
  import EyeSlashIcon from "phosphor-svelte/lib/EyeSlashIcon";
  import TrashIcon from "phosphor-svelte/lib/TrashIcon";
  import { groupSummary, isGroup, maskSummary, opacityOf, paramSummary, rowTitle } from "./layers";

  const {
    op,
    displayIndex,
    selected,
    onSelect,
    onToggle,
    onDuplicate,
    onDelete,
    onDragStart,
    onDragEnd,
  }: {
    op: Op;
    displayIndex: number;
    selected: boolean;
    onSelect: () => void;
    /** True when Alt was held: solo this layer instead of toggling it. */
    onToggle: (alt: boolean) => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onDragStart: (event: PointerEvent) => void;
    onDragEnd: (event: PointerEvent) => void;
  } = $props();

  const ctx = kernelContext();
  const viewer = ctx.viewer;
  const layers = ctx.layers;
  const panels = ctx.panels;

  const definition = $derived(panels.ops.find((entry) => entry.name === op.op));
  const layer = $derived(isGroup(op));
  const title = $derived(rowTitle(op, definition));
  // A layer has no parameters of its own: what it does is what is under its mask.
  const summary = $derived(layer ? groupSummary(op, panels.ops) : paramSummary(op, definition));
  const masks = $derived(maskSummary(op));
  const opacity = $derived(opacityOf(op));
  const thumbnail = $derived(layers.thumbnail(op));
  const firstKind = $derived(op.mask?.components[0]?.kind);

  /** The readout is a slider in spirit: a spec so it prints and scrubs like the others. */
  const opacitySpec = {
    name: "opacity",
    label: "Opacity",
    type: "number" as const,
    min: 0,
    max: 100,
    step: 1,
    default: 100,
    unit: "%",
  };
</script>

<!-- Two lines, not one: at 320 px a single line leaves an op's name four characters wide.
     Line one is what the layer is, line two is how it applies. -->
<li
  class="flex items-start gap-1.5 border-b border-line-faint px-1.5 py-1.5"
  class:bg-raised={selected}
  class:opacity-50={layers.dragging === op.id}
  data-layer-row={op.id}
  data-op={op.op}
  data-display-index={displayIndex}
  data-enabled={op.enabled}
  data-opacity={opacity}
>
  <span
    class="cursor-grab touch-none pt-2.5 text-faint"
    role="button"
    tabindex="-1"
    aria-label="Reorder {op.op}"
    data-layer-handle={op.id}
    onpointerdown={onDragStart}
    onpointerup={onDragEnd}
    onpointercancel={onDragEnd}
  >
    <DotsSixVerticalIcon size={14} />
  </span>

  <!-- The mask as the engine rasterised it, not an icon standing in for one. -->
  <span
    class="mt-0.5 flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm
           border border-line bg-canvas"
    data-mask-thumb={op.id}
  >
    {#if thumbnail}
      <img src={thumbnail} alt="" class="size-full object-cover" data-mask-thumb-image={op.id} />
    {:else if firstKind}
      <KindIcon kind={firstKind} size={12} />
    {:else}
      <span class="text-[9px] text-faint">all</span>
    {/if}
  </span>

  <div class="flex min-w-0 flex-1 flex-col">
    <div class="flex items-center gap-1">
      <button
        type="button"
        class="min-w-0 flex-1 truncate rounded-sm py-0.5 text-left text-default"
        onclick={onSelect}
        data-layer-select={op.id}
      >
        {title}
      </button>
      <Tooltip text="Visible (Alt: solo)" placement="left">
        <span data-layer-eye={op.id}>
          <Button
            size="sm"
            variant="ghost"
            icon={op.enabled ? EyeIcon : EyeSlashIcon}
            onclick={(event) => onToggle(event.altKey)}
          />
        </span>
      </Tooltip>
      <Tooltip text="Duplicate" placement="left">
        <span data-layer-duplicate={op.id}>
          <Button size="sm" variant="ghost" icon={CopyIcon} onclick={onDuplicate} />
        </span>
      </Tooltip>
      <Tooltip text="Delete" placement="left">
        <span data-layer-delete={op.id}>
          <Button size="sm" variant="ghost" icon={TrashIcon} onclick={onDelete} />
        </span>
      </Tooltip>
    </div>
    <div class="flex items-center gap-2">
      <span class="min-w-0 flex-1 truncate text-[10px] text-faint">
        {summary}{#if masks}{summary ? " · " : ""}{masks} mask{/if}
      </span>
      <ValueField
        value={opacity}
        spec={opacitySpec}
        range={{ min: 0, max: 100, step: 1 }}
        label="Opacity of {op.op}"
        onInput={(next) => void viewer.setOpacity(op.id, next, true)}
        onCommit={(next) => void viewer.setOpacity(op.id, next, false)}
      />
    </div>
    <!-- The adjustments under this layer's mask. They are not rows of their own: the stack
         order that matters is the layers', and an adjustment belongs to its mask. -->
    {#if layer && (op.ops ?? []).length > 0}
      <ul class="mt-1 flex flex-col gap-0.5" data-layer-children={op.id}>
        {#each op.ops ?? [] as child (child.id)}
          <li class="flex items-center gap-1 pl-1 text-[10px]" data-layer-child={child.id}>
            <Button
              size="sm"
              variant="ghost"
              icon={child.enabled ? EyeIcon : EyeSlashIcon}
              onclick={() => void viewer.setEnabled(child.id, !child.enabled)}
            />
            <button
              type="button"
              class="min-w-0 flex-1 truncate rounded-sm py-0.5 text-left text-muted
                     transition-colors hover:text-default"
              data-layer-child-select={child.id}
              onclick={() => viewer.selectOp(child.id)}
            >
              {panels.ops.find((entry) => entry.name === child.op)?.label ?? child.op}
            </button>
            <Button
              size="sm"
              variant="ghost"
              icon={TrashIcon}
              onclick={() => void viewer.removeOp(child.id)}
            />
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</li>
