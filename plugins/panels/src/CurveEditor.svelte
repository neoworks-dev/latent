<script lang="ts">
  // Lightroom's Curve, hand-built: one square graph with a tab per curve rather than the
  // four separate arrays the engine describes. @neoworks-dev/ui has no 2-D point editor —
  // its nearest controls, Select and WheelColumn, are pickers — and a curve is a
  // drag-to-shape control with its own hit testing, so this is the third hand-built
  // control beside Slider and ValueField. Tokens only, no hex: the graph is an SVG whose
  // strokes are `var(--color-…)`.
  //
  // It owns no edit state. The points are read back out of `viewer.stack` on every render
  // and every gesture is a `setParam` — transient while the pointer is down, committed on
  // release, so one drag is one history step. The one exception is `dragPoints`: that is
  // the gesture's own list, alive only between pointerdown and pointerup, because a
  // transient write round-trips through the engine and a move that lands before the reply
  // would otherwise be applied to a list one edit behind.
  import { kernelContext } from "@latent/contracts";
  import type { OpDefinition, OpParamSpec } from "@latent/protocol";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
  import {
    clampSplit,
    clampUnit,
    curveArrowDelta,
    curveJson,
    curvePoints,
    curveReadout,
    insertPoint,
    isIdentityLut,
    lutPath,
    movePoint,
    nudgePoint,
    parametricCurveLut,
    parametricOf,
    pointCurveLut,
    pointNear,
    removePoint,
    samePoints,
    sharedLut,
    withAnchors,
    type CurvePoint,
    type SplitName,
  } from "./curve";
  import { curveStroke, paramValue, sliderRange, type CurveParams } from "./panels";
  import ParamControl from "./ParamControl.svelte";

  const {
    op,
    curve,
    opId = null,
  }: {
    op: OpDefinition;
    curve: CurveParams;
    /** One stack entry instead of the first op of this name, as `ParamControl` takes. */
    opId?: string | null;
  } = $props();
  const viewer = kernelContext().viewer;

  /** The graph's own coordinate box; the SVG scales it to whatever width the column has. */
  const BOX = 256;

  /** Lightroom's 4×4 graph: three lines each way, no histogram behind them. */
  const GRID = [0.25, 0.5, 0.75];

  /** How near the pointer has to be to grab a point instead of adding one, in curve space. */
  const HIT_TOLERANCE = 0.045;

  /** The tab, which is a channel name or Lightroom's parametric curve. */
  let tab = $state("parametric");
  let selected = $state<number | null>(null);
  let dragPoints = $state<CurvePoint[] | null>(null);
  let graph = $state<SVGSVGElement | null>(null);

  let dragIndex: number | null = null;
  /**
   * The curve as it was when the pointer went down. The release is compared against this,
   * not against the stack: the stack has already taken the drag's transient writes, so it
   * cannot tell "released without moving" from "released at the end of a drag".
   */
  let gestureStart: CurvePoint[] | null = null;
  let splitDrag: SplitName | null = null;
  // Measured once per gesture: a column that reflows mid-drag (a section folding, a
  // scrollbar appearing) must not move the graph out from under the pointer.
  let dragRect: DOMRect | null = null;

  const disabled = $derived(viewer.photoId === null);
  const channel = $derived(tab === "parametric" ? null : tab);

  // The op as the engine has it, with the described defaults filling in whatever is not in
  // the stack yet — the rule every generated control follows.
  const params = $derived(
    Object.fromEntries(
      op.params.map((spec): [string, unknown] => [
        spec.name,
        paramValue(viewer.stack, op, spec, opId),
      ]),
    ),
  );
  const regions = $derived(parametricOf(params));
  // The active channel's points. The parametric tab has no channel, and so no points.
  const storedPoints = $derived(curvePoints(channel === null ? null : params[channel]));
  const points = $derived(dragPoints ?? storedPoints);

  const lut = $derived(channel ? pointCurveLut(withAnchors(points)) : parametricCurveLut(regions));
  const path = $derived(lutPath(lut, BOX));

  // What the pixels went through before this curve gets them: the regions on the RGB tab,
  // the regions plus the RGB curve on a channel tab. Drawn faintly, so a red curve that
  // looks flat is visibly not the whole story.
  const ghost = $derived.by(() => {
    if (!channel) return null;
    const below = channel === "rgb" ? parametricCurveLut(regions) : sharedLut(params);
    if (isIdentityLut(below)) return null;
    return lutPath(below, BOX);
  });

  const stroke = $derived(curveStroke(tab));
  const readout = $derived(selected === null ? null : (points[selected] ?? null));
  const edited = $derived.by(() => {
    if (channel) return curveJson(points).length > 0;
    const parametric = [...curve.regions, ...curve.splits.map((split) => split.spec)];
    return parametric.some((spec) => params[spec.name] !== spec.default);
  });

  function write(next: Record<string, unknown>, transient: boolean): void {
    if (opId) {
      void viewer.setOpParams(opId, next, transient);
      return;
    }
    void viewer.setParam(op.name, next, transient);
  }

  function writePoints(next: CurvePoint[], transient: boolean): void {
    if (!channel) return;
    dragPoints = transient ? next : null;
    write({ [channel]: curveJson(next) }, transient);
  }

  function selectTab(next: string): void {
    tab = next;
    selected = null;
    dragPoints = null;
  }

  /** Pointer position in curve space: 0..1 across the graph, y up as Lightroom draws it. */
  function positionOf(event: PointerEvent | MouseEvent): CurvePoint {
    const rect = dragRect ?? graph?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clampUnit((event.clientX - rect.left) / rect.width),
      y: clampUnit(1 - (event.clientY - rect.top) / rect.height),
    };
  }

  function onPointerDown(event: PointerEvent): void {
    if (disabled || !channel) return;
    dragRect = graph?.getBoundingClientRect() ?? null;
    const position = positionOf(event);
    const current = withAnchors(points);
    const hit = pointNear(current, position.x, position.y, HIT_TOLERANCE);
    // Alt on a point removes it — Lightroom's modifier — and never starts a drag.
    if (hit !== null && event.altKey) {
      endGesture();
      selected = null;
      writePoints(removePoint(current, hit), false);
      return;
    }
    graph?.setPointerCapture(event.pointerId);
    gestureStart = current;
    if (hit !== null) {
      dragIndex = hit;
      selected = hit;
      dragPoints = current;
      return;
    }
    const added = insertPoint(current, position);
    dragIndex = added.index;
    selected = added.index;
    writePoints(added.points, true);
  }

  function onPointerMove(event: PointerEvent): void {
    if (dragIndex === null) return;
    const position = positionOf(event);
    writePoints(movePoint(withAnchors(points), dragIndex, position.x, position.y), true);
  }

  function onPointerUp(event: PointerEvent): void {
    if (dragIndex === null) return;
    const position = positionOf(event);
    const next = movePoint(withAnchors(points), dragIndex, position.x, position.y);
    const start = gestureStart;
    endGesture();
    // A press that selected a point and released without moving it is not an edit, and
    // must not leave a history step behind.
    if (start && samePoints(next, start)) {
      dragPoints = null;
      return;
    }
    writePoints(next, false);
  }

  function endGesture(): void {
    dragIndex = null;
    dragRect = null;
    gestureStart = null;
  }

  /** A double-click on a point removes it; on empty space it does nothing. */
  function onDoubleClick(event: MouseEvent): void {
    if (disabled || !channel) return;
    const position = positionOf(event);
    const current = withAnchors(points);
    const hit = pointNear(current, position.x, position.y, HIT_TOLERANCE);
    if (hit === null) return;
    selected = null;
    writePoints(removePoint(current, hit), false);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (disabled || !channel || selected === null) return;
    const current = withAnchors(points);
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      const next = removePoint(current, selected);
      selected = null;
      writePoints(next, false);
      return;
    }
    const delta = curveArrowDelta(event.key, event.shiftKey);
    if (!delta) return;
    event.preventDefault();
    writePoints(nudgePoint(current, selected, delta.x, delta.y), false);
  }

  /** The tab's own reset: one channel back to linear, or the parametric half to neutral. */
  function reset(): void {
    selected = null;
    dragPoints = null;
    if (channel) {
      write({ [channel]: [] }, false);
      return;
    }
    const neutral = [
      ...curve.regions.map((spec): [string, unknown] => [spec.name, spec.default]),
      ...curve.splits.map((split): [string, unknown] => [split.name, split.spec.default]),
    ];
    write(Object.fromEntries(neutral), false);
  }

  /** The splits share the graph's x axis, so they are measured against the graph's box. */
  function splitValueAt(clientX: number, name: SplitName): number {
    const rect = dragRect ?? graph?.getBoundingClientRect();
    if (!rect) return 0;
    const ratio = clampUnit((clientX - rect.left) / rect.width);
    return clampSplit(name, Math.round(ratio * 100), regions);
  }

  function onSplitDown(event: PointerEvent, name: SplitName): void {
    if (disabled) return;
    splitDrag = name;
    dragRect = graph?.getBoundingClientRect() ?? null;
    const target = event.currentTarget;
    if (target instanceof HTMLElement) target.setPointerCapture(event.pointerId);
    write({ [name]: splitValueAt(event.clientX, name) }, true);
  }

  function onSplitMove(event: PointerEvent, name: SplitName): void {
    if (splitDrag !== name) return;
    write({ [name]: splitValueAt(event.clientX, name) }, true);
  }

  function onSplitUp(event: PointerEvent, name: SplitName): void {
    if (splitDrag !== name) return;
    const value = splitValueAt(event.clientX, name);
    splitDrag = null;
    dragRect = null;
    write({ [name]: value }, false);
  }

  function onSplitKeyDown(
    event: KeyboardEvent,
    split: { name: SplitName; spec: OpParamSpec },
  ): void {
    if (disabled) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const range = sliderRange(split.spec);
    const stride = event.shiftKey ? range.step * 10 : range.step;
    const moved = Number(params[split.name]) + (event.key === "ArrowLeft" ? -stride : stride);
    write({ [split.name]: clampSplit(split.name, moved, regions) }, false);
  }
</script>

<div class="flex flex-col" data-curve-editor={op.name}>
  <div class="flex flex-col gap-1 px-3 pt-2 pb-1">
    <div class="flex items-center gap-1">
      <span class="flex-1 text-xs font-semibold text-default">{op.label}</span>
      <Tooltip text="Reset this curve" placement="left">
        <Button
          size="sm"
          variant="ghost"
          icon={ArrowCounterClockwiseIcon}
          disabled={disabled || !edited}
          onclick={reset}
        />
      </Tooltip>
    </div>
    <div class="flex items-center gap-1" role="tablist" aria-label="{op.label} channel">
      <button
        type="button"
        role="tab"
        class="rounded-sm px-1.5 py-1 text-xs leading-none text-muted transition-colors
               hover:text-default aria-selected:bg-raised aria-selected:text-default"
        aria-selected={tab === "parametric"}
        onclick={() => selectTab("parametric")}
        data-curve-tab="parametric">Parametric</button
      >
      <span class="flex-1"></span>
      {#each curve.points as spec (spec.name)}
        <button
          type="button"
          role="tab"
          class="flex size-5 items-center justify-center rounded-full transition-colors
                 hover:bg-hover aria-selected:bg-raised"
          aria-selected={tab === spec.name}
          aria-label={spec.label ?? spec.name}
          title={spec.label ?? spec.name}
          onclick={() => selectTab(spec.name)}
          data-curve-tab={spec.name}
        >
          <span
            class="block size-2.5 rounded-full border"
            style:border-color={curveStroke(spec.name)}
            style:background-color={tab === spec.name ? curveStroke(spec.name) : "transparent"}
          ></span>
        </button>
      {/each}
    </div>

    <div class="relative">
      <!--
        `application` is the ARIA role for a custom graphical editor, and it is the one a
        screen reader needs to hand the arrow keys to the graph rather than to the page.
        Svelte's checker classes it as structure, so the focus and the handlers below both
        read as warnings; they are the role working, not an unlabelled div.
      -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <svg
        bind:this={graph}
        viewBox="0 0 {BOX} {BOX}"
        role="application"
        aria-label="{op.label} graph"
        tabindex={disabled ? -1 : 0}
        class="aspect-square w-full touch-none select-none rounded-sm border border-line bg-input
               outline-none focus-visible:border-action"
        class:cursor-crosshair={channel !== null && !disabled}
        class:opacity-40={disabled}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        ondblclick={onDoubleClick}
        onkeydown={onKeyDown}
      >
        <g stroke="var(--color-line-faint)" stroke-width="1">
          {#each GRID as fraction (fraction)}
            <line x1={fraction * BOX} y1="0" x2={fraction * BOX} y2={BOX} />
            <line x1="0" y1={fraction * BOX} x2={BOX} y2={fraction * BOX} />
          {/each}
        </g>
        <line
          x1="0"
          y1={BOX}
          x2={BOX}
          y2="0"
          stroke="var(--color-line)"
          stroke-width="1"
          stroke-dasharray="3 4"
        />
        {#if !channel}
          <!-- Where the four regions meet, so a split handle has something to point at. -->
          {#each curve.splits as split (split.name)}
            {@const at = (Number(params[split.name]) / 100) * BOX}
            <line
              x1={at}
              y1="0"
              x2={at}
              y2={BOX}
              stroke="var(--color-line-strong)"
              stroke-width="1"
              stroke-dasharray="2 3"
            />
          {/each}
        {/if}
        {#if ghost}
          <path d={ghost} fill="none" stroke="var(--color-line-strong)" stroke-width="1.5" />
        {/if}
        <path d={path} fill="none" {stroke} stroke-width="2" stroke-linejoin="round" />
        {#if channel}
          {#each points as point, index (index)}
            <circle
              cx={point.x * BOX}
              cy={(1 - point.y) * BOX}
              r={index === selected ? 6 : 5}
              fill={index === selected ? stroke : "var(--color-canvas)"}
              {stroke}
              stroke-width="2"
              data-curve-point={index}
            />
          {/each}
        {/if}
      </svg>
      {#if readout}
        <span
          class="pointer-events-none absolute right-1.5 bottom-1.5 rounded-sm bg-canvas px-1 py-0.5
                 text-[10px] leading-none tabular-nums text-muted"
          data-curve-readout={channel}>{curveReadout(readout)}</span
        >
      {/if}
    </div>

    {#if !channel}
      <!-- Lightroom's three split handles, on the graph's own x axis and just under it. -->
      <div class="relative h-3.5" data-curve-splits>
        <div class="absolute top-1.5 h-px w-full bg-line"></div>
        {#each curve.splits as split (split.name)}
          {@const value = Number(params[split.name])}
          <span
            role="slider"
            tabindex={disabled ? -1 : 0}
            aria-label={split.spec.label ?? split.name}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={value}
            aria-disabled={disabled}
            class="absolute top-0.5 block size-2.5 -translate-x-1/2 rotate-45 cursor-ew-resize
                   touch-none border border-default bg-raised"
            style:left="{value}%"
            onpointerdown={(event) => onSplitDown(event, split.name)}
            onpointermove={(event) => onSplitMove(event, split.name)}
            onpointerup={(event) => onSplitUp(event, split.name)}
            onpointercancel={(event) => onSplitUp(event, split.name)}
            onkeydown={(event) => onSplitKeyDown(event, split)}
            data-curve-split={split.name}
          ></span>
        {/each}
      </div>
    {/if}
  </div>

  {#if !channel}
    {#each curve.regions as spec (spec.name)}
      <ParamControl {op} {spec} {opId} />
    {/each}
  {/if}
</div>
