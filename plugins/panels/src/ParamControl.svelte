<script lang="ts">
  import { kernelContext } from "@latent/contracts";
  import type { OpDefinition, OpParamSpec } from "@latent/protocol";
  import { Checkbox, Select } from "@neoworks-dev/ui";
  import { controlKind, paramValue, pendingNote, rowLabel, sliderRange, trackTint } from "./panels";
  import Slider from "./Slider.svelte";
  import ValueField from "./ValueField.svelte";

  const { op, spec }: { op: OpDefinition; spec: OpParamSpec } = $props();
  const viewer = kernelContext().viewer;

  const kind = $derived(controlKind(spec));
  const range = $derived(sliderRange(spec));
  const label = $derived(rowLabel(op, spec));
  const options = $derived((spec.values ?? []).map((value) => ({ value, label: value })));

  // The stack is the truth: the control shows whatever the engine last reported, and
  // falls back to the described default while the op is not in the stack.
  const current = $derived(paramValue(viewer.stack, op, spec));
  const disabled = $derived(viewer.photoId === null);
  const tint = $derived(trackTint(spec));

  function write(value: unknown, transient: boolean): void {
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
</script>

<div class="px-3 py-0.5" data-op={op.name} data-param={spec.name}>
  {#if kind === "slider"}
    <div class="flex items-center justify-between gap-2">
      <button
        type="button"
        class="truncate rounded-sm py-1 text-left text-xs leading-none text-muted
               transition-colors hover:text-default"
        title="Double-click to reset"
        ondblclick={reset}
        data-label={spec.name}>{label}</button
      >
      <ValueField
        value={Number(current)}
        {spec}
        {range}
        {disabled}
        {label}
        onInput={(next) => write(next, true)}
        onCommit={(next) => write(next, false)}
      />
    </div>
    <Slider
      value={Number(current)}
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
        <span class="text-xs text-faint" data-pending={spec.name}>{pendingNote(spec)}</span>
      {:else}
        <span class="text-xs text-faint">{spec.type} — hand-built panel</span>
      {/if}
    </div>
  {/if}
</div>
