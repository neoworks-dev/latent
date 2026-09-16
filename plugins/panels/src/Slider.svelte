<script lang="ts">
  // @neoworks-dev/ui has no slider (WheelColumn is a scroll picker, FloatingScrollbar a
  // scrollbar), so this is one of two hand-built controls here. Tokens only, no hex.
  // The thumb position comes from `value`, which is the engine's stack — dragging emits
  // `onInput` and never stores anything locally.
  import {
    detented,
    fillBounds,
    isBipolar,
    keyboardDelta,
    percentOf,
    quantize,
    type SliderRange,
  } from "./panels";

  const {
    value,
    range,
    disabled = false,
    label,
    tint = null,
    onInput,
    onCommit,
    onReset,
  }: {
    value: number;
    range: SliderRange;
    disabled?: boolean;
    label: string;
    /** CSS gradient painted on the track instead of the plain fill, for white balance. */
    tint?: string | null;
    onInput: (value: number) => void;
    onCommit: (value: number) => void;
    onReset: () => void;
  } = $props();

  let track = $state<HTMLDivElement | null>(null);
  let dragging = $state(false);

  const thumbPercent = $derived(percentOf(value, range));
  const fill = $derived(fillBounds(value, range));
  const centrePercent = $derived(percentOf(0, range));

  // Measured once per drag: a panel that reflows mid-drag (a scrollbar appearing, a
  // section folding) must not move the track out from under the pointer.
  let dragRect: DOMRect | null = null;

  // The hit area spans the track edge to edge, so a click at 60% of the box is 60% of
  // the range — no padding to correct for.
  function valueAt(clientX: number): number {
    const rect = dragRect ?? track?.getBoundingClientRect();
    if (!rect) return value;
    const ratio = (clientX - rect.left) / rect.width;
    return detented(quantize(range.min + ratio * (range.max - range.min), range), range);
  }

  function onPointerDown(event: PointerEvent): void {
    if (disabled) return;
    dragging = true;
    dragRect = track?.getBoundingClientRect() ?? null;
    const target = event.currentTarget;
    if (target instanceof HTMLElement) target.setPointerCapture(event.pointerId);
    onInput(valueAt(event.clientX));
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    onInput(valueAt(event.clientX));
  }

  function onPointerUp(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    const committed = valueAt(event.clientX);
    dragRect = null;
    onCommit(committed);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (disabled) return;
    const delta = keyboardDelta(event.key, event.shiftKey, range);
    if (delta === null) return;
    event.preventDefault();
    onCommit(quantize(value + delta, range));
  }
</script>

<div
  bind:this={track}
  role="slider"
  tabindex={disabled ? -1 : 0}
  aria-label={label}
  aria-valuemin={range.min}
  aria-valuemax={range.max}
  aria-valuenow={value}
  aria-disabled={disabled}
  class="group relative h-6 w-full cursor-ew-resize touch-none select-none rounded-sm"
  class:cursor-not-allowed={disabled}
  class:opacity-40={disabled}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  ondblclick={onReset}
  onkeydown={onKeyDown}
>
  <div
    class="absolute top-1/2 h-0.5 w-full -translate-y-1/2 rounded-full bg-line-strong"
    style:background-image={tint}
  ></div>
  {#if !tint}
    <div
      class="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-action"
      style:left="{fill.left}%"
      style:width="{fill.width}%"
    ></div>
  {/if}
  <!-- The detent notch is a gap cut in the track, so it reads on the white fill and on a
       tinted gradient alike. It paints over the fill, which starts in the same place. -->
  {#if isBipolar(range)}
    <div
      class="absolute top-1/2 h-1 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-elevated"
      style:left="{centrePercent}%"
    ></div>
  {/if}
  <div
    class="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border
           border-default bg-canvas shadow-sm transition-transform group-hover:scale-110"
    class:scale-110={dragging}
    style:left="{thumbPercent}%"
  ></div>
</div>
