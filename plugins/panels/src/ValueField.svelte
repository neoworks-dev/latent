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
  import ScrubCursor from "./ScrubCursor.svelte";
  import { pointerLockDisabled, ScrubDrag, wrapAround } from "./scrub";

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
  /** Where the drawn cursor is while the real one is locked, in window pixels. */
  let cursor = $state({ x: 0, y: 0 });
  let locked = $state(false);
  let input = $state<HTMLInputElement | null>(null);
  let scrubStartValue = $state(0);

  // The same locked drag the boxed slider uses: the cursor is frozen for the scrub, so
  // running out of screen does not run out of value.
  const drag = new ScrubDrag();

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
    scrubStartValue = value;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    target.setPointerCapture(event.pointerId);
    // The lock is what lets the scrub outlive the edge of the screen; the driver's
    // synthetic moves are the one case it has to be left off.
    drag.begin(pointerLockDisabled(location.search) ? null : target, document);
    cursor = { x: event.clientX, y: event.clientY };
  }

  function onPointerMove(event: PointerEvent): void {
    // The drawn cursor keeps going where the real one cannot, out one side of the window
    // and in at the other.
    cursor = {
      x: wrapAround(cursor.x + event.movementX, window.innerWidth),
      y: wrapAround(cursor.y + event.movementY, window.innerHeight),
    };
    const moved = drag.move(event.movementX, document.pointerLockElement !== null);
    if (moved === null) return;
    locked = document.pointerLockElement !== null;
    onInput(scrubbedValue(scrubStartValue, moved, range, event));
  }

  function onPointerUp(event: PointerEvent): void {
    const moved = drag.end();
    locked = false;
    if (moved === null) {
      if (disabled || editing) return;
      beginEdit();
      return;
    }
    onCommit(scrubbedValue(scrubStartValue, moved, range, event));
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
{#if locked}
  <ScrubCursor x={cursor.x} y={cursor.y} />
{/if}
