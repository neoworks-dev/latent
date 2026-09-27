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
  import {
    bandHighSpec,
    bandLowSpec,
    bandOf,
    componentDetail,
    featherSpec,
    isAiKind,
    isBandKind,
    kindSpec,
    movedBand,
    opacitySpec,
    smoothnessSpec,
  } from "./masks";

  const { component }: { component: MaskComponent } = $props();
  const masks = kernelContext().masks;

  const spec = $derived(kindSpec(component.kind));
  const detail = $derived(componentDetail(component));
  const selected = $derived(masks.selectedComponentId === component.id);
  const feather = $derived(component.feather ?? 0);
  const opacity = $derived(component.opacity ?? 100);
  const failure = $derived(masks.errorOf(component));
  // The engine only ever stores a string here (`normalize` rejects anything else).
  const storedPrompt = $derived(String(component.params?.prompt ?? ""));
  // The words being edited, seeded from the stored ones until the user types.
  let draftPrompt = $state<string | null>(null);
  const band = $derived(bandOf(component));
  const smoothness = $derived(Number(component.params?.smoothness ?? 0.1));

  const modes = [
    { mode: "add" as const, icon: UniteIcon, label: "Add" },
    { mode: "subtract" as const, icon: SubtractIcon, label: "Subtract" },
    { mode: "intersect" as const, icon: IntersectIcon, label: "Intersect" },
  ];

  function write(patch: Partial<MaskComponent>, transient = false): void {
    void masks.patch(component.id, patch, transient);
  }

  function writeBand(edge: "low" | "high", percent: number, transient = false): void {
    void masks.patchParams(component.id, { range: movedBand(band, edge, percent) }, transient);
  }

  function writeSmoothness(percent: number, transient = false): void {
    void masks.patchParams(component.id, { smoothness: percent / 100 }, transient);
  }

  /** New words for a text mask: stored first, so the detection and the label both read them. */
  async function searchAgain(): Promise<void> {
    const prompt = (draftPrompt ?? storedPrompt).trim();
    draftPrompt = null;
    if (prompt === "") return;
    await masks.patchParams(component.id, { prompt });
    await masks.detect(component.id, { prompt });
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
      <span class="shrink-0">{spec.noun}</span>
      {#if detail}
        <span class="truncate text-faint" data-component-detail>{detail}</span>
      {/if}
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
      {#if component.kind === "text"}
        <form
          class="flex items-center gap-1"
          onsubmit={(event) => {
            event.preventDefault();
            void searchAgain();
          }}
        >
          <input
            class="min-w-0 flex-1 rounded-sm border border-line-strong bg-input px-1.5 py-1
                   text-xs text-default"
            placeholder="the cat"
            value={draftPrompt ?? storedPrompt}
            oninput={(event) => (draftPrompt = event.currentTarget.value)}
            data-component-prompt={component.id}
          />
          <Button size="sm" type="submit">Detect</Button>
        </form>
      {/if}
      {#if isBandKind(component.kind)}
        <!-- The band this component keeps. The raster is the channel itself, so moving an
             edge is a shader pass, never another model run. -->
        <p class="text-[10px] text-faint">
          {component.kind === "depth" ? "0 = farthest · 100 = nearest" : "0 = black · 100 = white"}
        </p>
        <BoxedSlider
          value={band[0] * 100}
          spec={bandLowSpec}
          range={{ min: 0, max: 100, step: 1 }}
          label="From"
          onInput={(next) => writeBand("low", next, true)}
          onCommit={(next) => writeBand("low", next)}
          onReset={() => writeBand("low", 50)}
        />
        <BoxedSlider
          value={band[1] * 100}
          spec={bandHighSpec}
          range={{ min: 0, max: 100, step: 1 }}
          label="To"
          onInput={(next) => writeBand("high", next, true)}
          onCommit={(next) => writeBand("high", next)}
          onReset={() => writeBand("high", 100)}
        />
        <BoxedSlider
          value={smoothness * 100}
          spec={smoothnessSpec}
          range={{ min: 0, max: 100, step: 1 }}
          label="Smoothness"
          onInput={(next) => writeSmoothness(next, true)}
          onCommit={(next) => writeSmoothness(next)}
          onReset={() => writeSmoothness(10)}
        />
      {/if}
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
