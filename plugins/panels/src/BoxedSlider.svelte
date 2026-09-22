<script lang="ts">
  // The column's slider: one box that is the track, the label and the readout at once.
  // @neoworks-dev/ui has no slider or numeric field, so this is hand-built like the curve
  // and the mixer. Tokens only, no hex.
  //
  // It owns no value. `value` is whatever the engine last reported; a drag emits `onInput`
  // and the release `onCommit`, so the stack stays the only truth. The one piece of local
  // state is `draft`, the text being typed, which is not a value until Enter.
  //
  // Drag scrubs relative to where the press started rather than jumping to the pointer:
  // the box is as wide as the column, so an absolute track would make every pixel worth a
  // large step, and the whole box — label included — is the hit area.
  import type { OpParamSpec } from "@latent/protocol";
  import {
    detented,
    editableText,
    fillBounds,
    formatValue,
    isBipolar,
    keyboardDelta,
    parseValue,
    percentOf,
    quantize,
    scrubbedValue,
    type SliderRange,
  } from "./panels";
  import ScrubCursor from "./ScrubCursor.svelte";
  import { pointerLockDisabled, ScrubDrag, wrapAround } from "./scrub";

  const {
    value,
    range,
    label,
    spec = null,
    disabled = false,
    tint = null,
    onInput,
    onCommit,
    onReset = null,
  }: {
    value: number;
    range: SliderRange;
    /** Drawn inside the box, on the left. Also the control's accessible name. */
    label: string;
    /** Formats the readout — signs, decimals, unit. Absent for a slider with no op behind it. */
    spec?: OpParamSpec | null;
    disabled?: boolean;
    /** CSS gradient painted across the box instead of the plain fill, for white balance. */
    tint?: string | null;
    onInput: (value: number) => void;
    onCommit: (value: number) => void;
    /** Draws the reset dot beside the box. A slider with nothing to reset to leaves it out. */
    onReset?: (() => void) | null;
  } = $props();

  // The drag, with its pointer lock: the cursor freezes for the length of the scrub and
  // the raw movement keeps coming, so a slow drag across a wide range never runs out of
  // monitor. Taken as soon as the press becomes a drag — see `scrub.ts` for why not later.
  const drag = new ScrubDrag();

  let editing = $state(false);
  let draft = $state("");
  /** Where the drawn cursor is while the real one is locked, in window pixels. */
  let cursor = $state({ x: 0, y: 0 });
  let locked = $state(false);
  let input = $state<HTMLInputElement | null>(null);
  let scrubbing = $state(false);
  let startValue = $state(0);

  // A slider with no spec behind it still reads like the rest of the column: the range
  // carries the decimals and the sign, which is everything `formatValue` needs.
  const readoutSpec = $derived<OpParamSpec>(
    spec ?? {
      name: label,
      type: "number",
      min: range.min,
      max: range.max,
      step: range.step,
      default: null,
    },
  );
  // Whether the dot is filled. A slider with no spec has no default to compare against, so
  // its dot stays hollow and still resets — where to is the caller's business.
  const atDefault = $derived(value === readoutSpec.default);
  const fill = $derived(fillBounds(value, range));
  const markerPercent = $derived(percentOf(value, range));
  const centrePercent = $derived(percentOf(0, range));

  $effect(() => {
    if (!editing || !input) return;
    input.focus();
    input.select();
  });

  function onPointerDown(event: PointerEvent): void {
    if (disabled || editing) return;
    startValue = value;
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
    scrubbing = true;
    locked = document.pointerLockElement !== null;
    onInput(detented(scrubbedValue(startValue, moved, range, event), range));
  }

  function onPointerUp(event: PointerEvent): void {
    const moved = drag.end();
    scrubbing = false;
    locked = false;
    if (moved === null) {
      if (disabled || editing) return;
      draft = editableText(value, readoutSpec);
      editing = true;
      return;
    }
    onCommit(detented(scrubbedValue(startValue, moved, range, event), range));
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (disabled) return;
    const delta = keyboardDelta(event.key, event.shiftKey, range);
    if (delta === null) return;
    event.preventDefault();
    onCommit(quantize(value + delta, range));
  }

  function commitDraft(): void {
    if (!editing) return;
    editing = false;
    const parsed = parseValue(draft, range);
    if (parsed === null) return;
    onCommit(parsed);
  }

  function onEditKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter") commitDraft();
    if (event.key === "Escape") editing = false;
  }
</script>

<div class="flex items-center gap-1.5" data-slider={label}>
  <div
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label={label}
    aria-valuemin={range.min}
    aria-valuemax={range.max}
    aria-valuenow={value}
    aria-disabled={disabled}
    class="relative flex h-6 min-w-0 flex-1 cursor-ew-resize items-center gap-2 overflow-hidden
           rounded-sm border border-line bg-input px-2 touch-none select-none
           hover:border-line-strong"
    class:cursor-not-allowed={disabled}
    class:opacity-40={disabled}
    class:border-line-strong={scrubbing}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onkeydown={onKeyDown}
  >
    <!-- The filled part of the range, from the centre out on a bipolar slider. A tinted
         slider paints its gradient across the whole box instead, since the gradient is
         what the value means there (a temperature, a hue). -->
    {#if tint}
      <div class="absolute inset-0 opacity-30" style:background-image={tint}></div>
    {:else}
      <div
        class="absolute inset-y-0 bg-action/20"
        style:left="{fill.left}%"
        style:width="{fill.width}%"
      ></div>
    {/if}
    {#if isBipolar(range)}
      <div class="absolute inset-y-1 w-px bg-line-strong" style:left="{centrePercent}%"></div>
    {/if}
    <!-- Where the value sits: the one bright mark in the row, so a column of boxes reads
         as a column of sliders at a glance. -->
    <div
      class="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-action"
      style:left="{markerPercent}%"
    ></div>
    {#if editing}
      <input
        bind:this={input}
        bind:value={draft}
        type="text"
        inputmode="decimal"
        aria-label={label}
        class="relative w-full bg-transparent text-right text-xs leading-none tabular-nums
               text-default outline-none"
        onkeydown={onEditKeyDown}
        onblur={commitDraft}
      />
    {:else}
      <span
        class="relative truncate text-xs leading-none text-muted"
        data-label={spec?.name ?? label}>{label}</span
      >
      <span
        class="relative ml-auto shrink-0 text-xs leading-none tabular-nums text-default"
        data-readout={spec?.name ?? label}>{formatValue(value, readoutSpec)}</span
      >
    {/if}
  </div>
  {#if onReset}
    <button
      type="button"
      class="size-3 shrink-0 rounded-full border border-line-strong transition-colors
             hover:border-action disabled:opacity-30"
      class:bg-action={!atDefault}
      aria-label="Reset {label}"
      title="Reset {label}"
      disabled={disabled || atDefault}
      onclick={onReset}
      data-reset={spec?.name ?? label}
    ></button>
  {/if}
</div>
{#if locked}
  <ScrubCursor x={cursor.x} y={cursor.y} />
{/if}
