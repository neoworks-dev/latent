<script lang="ts">
  // One mask component: what it is, how it combines with the ones above it, and the two
  // sliders every kind has. The mode picker is three toggle buttons rather than a Select —
  // it is a three-way switch that has to read at a glance while a mask is being built, and
  // Lightroom draws it the same way.
  import { kernelContext } from "@latent/contracts";
  import type { MaskComponent } from "@latent/protocol";
  import { BoxedSlider } from "@latent/plugin-panels";
  import { Button, LoadingSpinner, StatusBadge, Tooltip } from "@neoworks-dev/ui";
  import ArrowsClockwiseIcon from "phosphor-svelte/lib/ArrowsClockwiseIcon";
  import IntersectIcon from "phosphor-svelte/lib/IntersectIcon";
  import SelectionInverseIcon from "phosphor-svelte/lib/SelectionInverseIcon";
  import SubtractIcon from "phosphor-svelte/lib/SubtractIcon";
  import TrashIcon from "phosphor-svelte/lib/TrashIcon";
  import UniteIcon from "phosphor-svelte/lib/UniteIcon";
  import KindIcon from "./KindIcon.svelte";
  import { featherSpec, isAiKind, kindSpec, opacitySpec } from "./masks";

  const { component, index }: { component: MaskComponent; index: number } = $props();
  const masks = kernelContext().masks;

  const spec = $derived(kindSpec(component.kind));
  const selected = $derived(masks.selectedComponentId === component.id);
  const feather = $derived(component.feather ?? 0);
  const opacity = $derived(component.opacity ?? 100);
  const failure = $derived(masks.errorOf(component));

  const modes = [
    { mode: "add" as const, icon: UniteIcon, label: "Add" },
    { mode: "subtract" as const, icon: SubtractIcon, label: "Subtract" },
    { mode: "intersect" as const, icon: IntersectIcon, label: "Intersect" },
  ];

  function write(patch: Partial<MaskComponent>, transient = false): void {
    void masks.patch(component.id, patch, transient);
  }
</script>

<li
  class="border-b border-line-faint last:border-b-0"
  class:bg-raised={selected}
  data-mask-component={component.id}
  data-kind={component.kind}
  data-state={component.state ?? "ready"}
  data-mode={component.mode}
>
  <div class="flex items-center gap-1.5 px-2 py-1">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1 text-left text-xs
             text-default"
      onclick={() => masks.selectComponent(selected ? null : component.id)}
      data-select-component={component.id}
    >
      <KindIcon kind={component.kind} size={13} />
      <span class="truncate">{spec.label}</span>
      <span class="text-faint">{index + 1}</span>
    </button>

    {#if component.state === "pending"}
      <span data-component-pending={component.id}><LoadingSpinner size={12} /></span>
    {:else if component.state === "failed"}
      <Tooltip text={failure ?? "detection failed"} placement="left">
        <StatusBadge tone="red">Failed</StatusBadge>
      </Tooltip>
    {:else if component.state === "stale"}
      <StatusBadge tone="amber">Stale</StatusBadge>
    {/if}

    {#if isAiKind(component.kind)}
      <Tooltip text="Run detection again" placement="left">
        <Button
          size="sm"
          variant="ghost"
          icon={ArrowsClockwiseIcon}
          onclick={() => void masks.detect(component.id)}
        />
      </Tooltip>
    {/if}
    <Tooltip text="Invert" placement="left">
      <Button
        size="sm"
        variant={component.invert ? "surface" : "ghost"}
        icon={SelectionInverseIcon}
        onclick={() => write({ invert: !component.invert })}
      />
    </Tooltip>
    <Tooltip text="Delete mask" placement="left">
      <Button
        size="sm"
        variant="ghost"
        icon={TrashIcon}
        onclick={() => void masks.remove(component.id)}
      />
    </Tooltip>
  </div>

  {#if selected}
    <div class="flex flex-col gap-1 px-3 pb-2">
      <div class="flex items-center gap-1" role="group" aria-label="Combine mode">
        {#each modes as entry (entry.mode)}
          <Tooltip text={entry.label} placement="top">
            <Button
              size="sm"
              variant={component.mode === entry.mode ? "surface" : "ghost"}
              icon={entry.icon}
              onclick={() => write({ mode: entry.mode })}
            />
          </Tooltip>
        {/each}
        <span class="ml-auto text-[10px] text-faint">{component.mode}</span>
      </div>

      <BoxedSlider
        value={feather}
        spec={featherSpec}
        range={{ min: 0, max: 100, step: 1 }}
        label="Feather"
        onInput={(next) => write({ feather: next }, true)}
        onCommit={(next) => write({ feather: next })}
        onReset={() => write({ feather: 0 })}
      />
      <BoxedSlider
        value={opacity}
        spec={opacitySpec}
        range={{ min: 0, max: 100, step: 1 }}
        label="Opacity"
        onInput={(next) => write({ opacity: next }, true)}
        onCommit={(next) => write({ opacity: next })}
        onReset={() => write({ opacity: 100 })}
      />
    </div>
  {/if}
</li>
