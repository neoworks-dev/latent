<script lang="ts">
  import { kernelContext } from "@latent/contracts";
  import type { OpDefinition, OpParamSpec } from "@latent/protocol";
  import { Checkbox, Select } from "@neoworks-dev/ui";
  import {
    controlKind,
    controlValue,
    isHighlighted,
    pendingNote,
    rowLabel,
    sliderRange,
    trackTint,
  } from "./panels";
  import BoxedSlider from "./BoxedSlider.svelte";

  const {
    op,
    spec,
    opId = null,
    rowName = null,
  }: {
    op: OpDefinition;
    spec: OpParamSpec;
    /**
     * One stack entry to read and write instead of the first op of this name. The Masks
     * column passes it so a local adjustment edits its own masked op, not the base one.
     */
    opId?: string | null;
    /**
     * The row's label, when the caller groups the parameters itself. The colour mixer's
     * Hue tab labels its rows "Red", not "Red hue" — the tab already said which channel.
     */
    rowName?: string | null;
  } = $props();
  const ctx = kernelContext();
  const viewer = ctx.viewer;
  const panels = ctx.panels;

  let row = $state<HTMLDivElement | null>(null);
  let flashing = $state(false);

  const kind = $derived(controlKind(spec));
  const range = $derived(sliderRange(spec));
  const label = $derived(rowName ?? rowLabel(op, spec));
  const options = $derived((spec.values ?? []).map((value) => ({ value, label: value })));

  // The stack is the truth: the control shows whatever the engine last reported, and
  // falls back to the described default while the op is not in the stack — or while the
  // selected mask does not hold it, which is where the next write would go.
  const current = $derived(controlValue(viewer.stack, op, spec, opId, viewer.maskTarget));
  const disabled = $derived(viewer.photoId === null);
  const tint = $derived(trackTint(spec));

  function write(value: unknown, transient: boolean): void {
    if (opId) {
      void viewer.setOpParams(opId, { [spec.name]: value }, transient);
      return;
    }
    void viewer.setParam(op.name, { [spec.name]: value }, transient);
  }

  function reset(): void {
    write(spec.default, false);
  }

  function chooseOption(value: string | string[]): void {
    if (typeof value !== "string") return;
    write(value, false);
  }

  function toggle(event: Event): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement)) return;
    write(target.checked, false);
  }

  $effect(() => {
    const target = panels.highlighted;
    const element = row;
    if (!element) return;
    if (!isHighlighted(target, { op: op.name, param: spec.name, opId }, Date.now())) return;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    flashing = true;
    const timer = setTimeout(() => (flashing = false), 1600);
    return () => clearTimeout(timer);
  });
</script>

<!-- More room on the right than the left: the reset dot hangs off the end of the box and
     would otherwise sit under the column's edge. -->
<div
  bind:this={row}
  class="rounded-md py-[3px] pr-3 pl-2 transition-colors duration-700"
  class:bg-blue-soft={flashing}
  data-op={op.name}
  data-param={spec.name}
  data-highlighted={flashing}
>
  {#if kind === "slider"}
    <BoxedSlider
      value={Number(current)}
      {spec}
      {range}
      {disabled}
      {label}
      {tint}
      onInput={(next) => write(next, true)}
      onCommit={(next) => write(next, false)}
      onReset={reset}
    />
  {:else}
    <div class="flex h-7 items-center justify-between gap-2">
      <span class="truncate text-xs text-muted">{label}</span>
      {#if kind === "checkbox"}
        <Checkbox checked={Boolean(current)} {disabled} onchange={toggle} />
      {:else if kind === "select"}
        <div class="w-40">
          <Select value={String(current)} {options} {disabled} onChange={chooseOption} />
        </div>
      {:else if kind === "pending"}
        <span class="text-xs text-faint" data-pending={spec.name}>{pendingNote}</span>
      {:else}
        <span class="text-xs text-faint">{spec.type} — hand-built panel</span>
      {/if}
    </div>
  {/if}
</div>
