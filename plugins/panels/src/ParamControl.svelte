<script lang="ts">
  import { kernelContext } from "@latent/contracts";
  import type { OpDefinition, OpParamSpec } from "@latent/protocol";
  import { Checkbox, Select } from "@neoworks-dev/ui";
  import { controlKind, formatValue, rowLabel, sliderRange } from "./panels";
  import Slider from "./Slider.svelte";

  const { op, spec }: { op: OpDefinition; spec: OpParamSpec } = $props();
  const viewer = kernelContext().viewer;

  const kind = $derived(controlKind(spec));
  const range = $derived(sliderRange(spec));
  const label = $derived(rowLabel(op, spec));
  const options = $derived((spec.values ?? []).map((value) => ({ value, label: value })));

  // The stack is the truth: the control shows whatever the engine last reported, and
  // falls back to the described default while the op is not in the stack.
  const current = $derived(
    viewer.stack.find((entry) => entry.op === op.name)?.params[spec.name] ?? spec.default,
  );
  const disabled = $derived(viewer.photoId === null);

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

<div class="flex h-7 items-center gap-2 text-xs" data-op={op.name} data-param={spec.name}>
  <span class="w-24 shrink-0 truncate text-muted">{label}</span>
  {#if kind === "slider"}
    <Slider
      value={Number(current)}
      {range}
      {disabled}
      {label}
      onInput={(next) => write(next, true)}
      onCommit={(next) => write(next, false)}
      onReset={reset}
    />
    <button
      type="button"
      class="w-14 shrink-0 cursor-default text-right tabular-nums text-default"
      title="Double-click to reset"
      ondblclick={reset}
      data-readout={spec.name}>{formatValue(Number(current), spec)}</button
    >
  {:else if kind === "checkbox"}
    <span class="flex-1"></span>
    <Checkbox checked={Boolean(current)} {disabled} onchange={toggle} />
  {:else if kind === "select"}
    <div class="flex-1">
      <Select value={String(current)} {options} {disabled} onChange={chooseOption} />
    </div>
  {:else}
    <span class="flex-1 text-faint">{spec.type} — hand-built panel</span>
  {/if}
</div>
