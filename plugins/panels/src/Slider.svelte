<script lang="ts">
  // @neoworks-dev/ui has no slider (WheelColumn is a scroll picker, FloatingScrollbar a
  // scrollbar), so this is the one hand-built control here. Tokens only, no hex.
  // The thumb position comes from `value`, which is the engine's stack — dragging emits
  // `onInput` and never stores anything locally.
  import { clamp, quantize, type SliderRange } from "./panels";

  const {
    value,
    range,
    disabled = false,
    label,
    onInput,
    onCommit,
    onReset,
  }: {
    value: number;
    range: SliderRange;
    disabled?: boolean;
    label: string;
    onInput: (value: number) => void;
    onCommit: (value: number) => void;
    onReset: () => void;
  } = $props();

  let track = $state<HTMLDivElement | null>(null);
  let dragging = $state(false);

  const percent = $derived(((clamp(value, range) - range.min) / (range.max - range.min)) * 100);

  function valueAt(clientX: number): number {
    if (!track) return value;
    const rect = track.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return quantize(range.min + ratio * (range.max - range.min), range);
  }

  function onPointerDown(event: PointerEvent): void {
    if (disabled) return;
    dragging = true;
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
    onCommit(valueAt(event.clientX));
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (disabled) return;
    let direction = 0;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") direction = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") direction = 1;
    if (direction === 0) return;
    event.preventDefault();
    const stride = event.shiftKey ? range.step * 10 : range.step;
    onCommit(quantize(value + direction * stride, range));
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
  class="group relative h-4 flex-1 cursor-ew-resize touch-none select-none"
  class:cursor-not-allowed={disabled}
  class:opacity-40={disabled}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  ondblclick={onReset}
  onkeydown={onKeyDown}
>
  <div class="absolute top-1/2 h-0.5 w-full -translate-y-1/2 rounded-full bg-raised"></div>
  <div
    class="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-action"
    style:width="{percent}%"
  ></div>
  <div
    class="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line-strong bg-elevated shadow-sm transition-colors group-hover:border-action"
    class:border-action={dragging}
    style:left="{percent}%"
  ></div>
</div>
