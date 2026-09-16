<script lang="ts">
  // The readout is a control, not a label: drag it to scrub, click it to type. The design
  // system has no numeric field (Select/DatePicker are pickers), so it is hand-built.
  // Like the slider it owns no value — `value` is the engine's stack, always.
  import type { OpParamSpec } from "@latent/protocol";
  import {
    editableText,
    formatValue,
    keyboardDelta,
    parseValue,
    quantize,
    scrubbedValue,
    type SliderRange,
  } from "./panels";

  const {
    value,
    spec,
    range,
    disabled = false,
    label,
    onInput,
    onCommit,
  }: {
    value: number;
    spec: OpParamSpec;
    range: SliderRange;
    disabled?: boolean;
    label: string;
    onInput: (value: number) => void;
    onCommit: (value: number) => void;
  } = $props();

  let editing = $state(false);
  let draft = $state("");
  let input = $state<HTMLInputElement | null>(null);
  let scrubStartX = $state(0);
  let scrubStartValue = $state(0);
  let scrubbing = $state(false);
  let pressed = $state(false);

  /** Below this a press is a click that opens the editor, above it a scrub. */
  const SCRUB_THRESHOLD_PX = 3;

  $effect(() => {
    if (!editing || !input) return;
    input.focus();
    input.select();
  });

  function beginEdit(): void {
    draft = editableText(value, spec);
    editing = true;
  }

  function commitDraft(): void {
    if (!editing) return;
    editing = false;
    const parsed = parseValue(draft, range);
    if (parsed === null) return;
    onCommit(parsed);
  }

  function cancelEdit(): void {
    editing = false;
  }

  function onPointerDown(event: PointerEvent): void {
    if (disabled || editing) return;
    pressed = true;
    scrubbing = false;
    scrubStartX = event.clientX;
    scrubStartValue = value;
    const target = event.currentTarget;
    if (target instanceof HTMLElement) target.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!pressed) return;
    const deltaX = event.clientX - scrubStartX;
    if (!scrubbing && Math.abs(deltaX) < SCRUB_THRESHOLD_PX) return;
    scrubbing = true;
    onInput(scrubbedValue(scrubStartValue, deltaX, range, event));
  }

  function onPointerUp(event: PointerEvent): void {
    if (!pressed) return;
    pressed = false;
    if (!scrubbing) {
      beginEdit();
      return;
    }
    scrubbing = false;
    onCommit(scrubbedValue(scrubStartValue, event.clientX - scrubStartX, range, event));
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (disabled) return;
    const delta = keyboardDelta(event.key, event.shiftKey, range);
    if (delta === null) return;
    event.preventDefault();
    onCommit(quantize(value + delta, range));
  }

  function onEditKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter") commitDraft();
    if (event.key === "Escape") cancelEdit();
  }
</script>

{#if editing}
  <input
    bind:this={input}
    bind:value={draft}
    type="text"
    inputmode="decimal"
    aria-label={label}
    class="w-20 shrink-0 rounded-sm border border-line-strong bg-input px-1 py-0.5 text-right
           text-xs leading-none tabular-nums text-default"
    onkeydown={onEditKeyDown}
    onblur={commitDraft}
  />
{:else}
  <button
    type="button"
    aria-label={label}
    title="Drag to scrub, click to type"
    class="w-20 shrink-0 cursor-ew-resize touch-none rounded-sm px-1 py-1 text-right text-xs
           leading-none tabular-nums text-default transition-colors hover:bg-hover"
    class:cursor-not-allowed={disabled}
    class:opacity-40={disabled}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onkeydown={onKeyDown}
    data-readout={spec.name}>{formatValue(value, spec)}</button
  >
{/if}
