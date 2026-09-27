<script lang="ts">
  // The history tree, newest first, drawn as a git log: one row per step saying what moved
  // and where it went, a graph on the left showing which step it was made from, and
  // clicking one takes the photo back to it. An edit made after an undo starts a branch
  // instead of throwing the undone steps away, and a branch can be merged back into the
  // step on screen. The tree is the engine's (`history.list`) — the UI holds no snapshots
  // of its own.
  //
  // A step that moved several ops at once — a preset — unfolds into one row per op, and each
  // of those can be put back on its own without losing the rest of the step.
  import { kernelContext } from "@latent/contracts";
  import { Tooltip } from "@neoworks-dev/ui";
  import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
  import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
  import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
  import GitMergeIcon from "phosphor-svelte/lib/GitMergeIcon";
  import { SvelteSet } from "svelte/reactivity";
  import { ancestorsOf, graphWidth, historyGraph, historyRows, type GraphEdge } from "./history";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const viewer = ctx.viewer;
  const develop = ctx.develop;

  /** A row's height and a lane's width, in CSS pixels: the graph is drawn to both. */
  const ROW = 24;
  const LANE = 12;
  const LANE_COLORS = [
    "var(--ctx-blue)",
    "var(--ctx-green)",
    "var(--ctx-amber)",
    "var(--ctx-violet)",
    "var(--ctx-pink)",
    "var(--ctx-red)",
  ];

  const rows = $derived(historyRows(develop.steps, ctx.panels.ops));
  const graph = $derived(historyGraph(develop.steps));
  const graphByIndex = $derived(new Map(graph.map((row) => [row.index, row])));
  const graphPixels = $derived(graphWidth(graph) * LANE);
  /** The steps the photo on screen is made of; every other row is another branch. */
  const current = $derived(ancestorsOf(develop.steps, develop.index));
  const branched = $derived(develop.steps.length > current.size);
  const unfolded = new SvelteSet<number>();

  // The cursor moves once per committed edit — a whole slider drag is one — so this reads
  // the undo step rather than `revision`, which every transient tick of that drag bumps.
  $effect(() => {
    const photoId = viewer.photoId;
    void viewer.historyIndex;
    void viewer.historyDepth;
    void develop.refresh(photoId);
  });

  function laneX(lane: number): number {
    return lane * LANE + LANE / 2;
  }

  function laneColor(lane: number): string {
    return LANE_COLORS[lane % LANE_COLORS.length] ?? "currentColor";
  }

  /** Half a row of graph, starting at `top`: straight down, or an S-bend between lanes. */
  function edgePath(edge: GraphEdge, top: number): string {
    const from = laneX(edge.from);
    const to = laneX(edge.to);
    const half = ROW / 2;
    if (from === to) return `M${from} ${top}V${top + half}`;
    return `M${from} ${top}C${from} ${top + half / 2} ${to} ${top + half / 2} ${to} ${top + half}`;
  }

  function jump(index: number): void {
    const photoId = viewer.photoId;
    if (photoId === null) return;
    void develop.jump(photoId, index);
  }

  function merge(index: number): void {
    const photoId = viewer.photoId;
    if (photoId === null) return;
    void develop.merge(photoId, index);
  }

  function unfold(index: number): void {
    if (!unfolded.delete(index)) unfolded.add(index);
  }

  function revert(index: number, opId: string): void {
    const photoId = viewer.photoId;
    if (photoId === null) return;
    void develop.revertOp(photoId, index, opId);
  }
</script>

<div class="flex flex-col px-1 pb-2 text-xs" data-pane="history">
  {#each rows as row (row.index)}
    {@const lanes = graphByIndex.get(row.index)}
    {@const inPhoto = current.has(row.index)}
    <div class="flex flex-col">
      <div class="flex h-6 items-center">
        {#if row.children.length > 0}
          <button
            type="button"
            class="rounded-sm p-0.5 text-faint hover:text-default"
            aria-expanded={unfolded.has(row.index)}
            title="Unfold {row.title}"
            data-history-unfold={row.index}
            onclick={() => unfold(row.index)}
          >
            {#if unfolded.has(row.index)}
              <CaretDownIcon size={11} weight="bold" />
            {:else}
              <CaretRightIcon size={11} weight="bold" />
            {/if}
          </button>
        {:else}
          <span class="w-4"></span>
        {/if}
        <svg
          class="shrink-0"
          width={graphPixels}
          height={ROW}
          aria-hidden="true"
          data-history-lane={lanes?.lane}
        >
          {#if lanes}
            {#each lanes.top as edge, position (position)}
              <path
                d={edgePath(edge, 0)}
                fill="none"
                stroke={laneColor(edge.from)}
                stroke-width="1.5"
              />
            {/each}
            {#each lanes.bottom as edge, position (position)}
              <path
                d={edgePath(edge, ROW / 2)}
                fill="none"
                stroke={laneColor(edge.to)}
                stroke-width="1.5"
              />
            {/each}
            <!-- The step on screen is a filled dot, every other one a ring. -->
            <circle
              cx={laneX(lanes.lane)}
              cy={ROW / 2}
              r={row.index === develop.index ? 4 : 3}
              fill={row.index === develop.index ? laneColor(lanes.lane) : "var(--color-elevated)"}
              stroke={laneColor(lanes.lane)}
              stroke-width="1.5"
            />
          {/if}
        </svg>
        <!-- A branch the photo is not on can be merged into it. The slot is kept on every
             row once there is a branch, so the titles stay in one column. -->
        {#if branched}
          <span class="flex w-5 shrink-0 justify-center">
            {#if !inPhoto}
              <Tooltip text="Merge into the current step" placement="right">
                <button
                  type="button"
                  class="rounded-sm p-0.5 text-faint hover:bg-hover hover:text-default"
                  data-history-merge={row.index}
                  onclick={() => merge(row.index)}
                >
                  <GitMergeIcon size={11} weight="bold" />
                </button>
              </Tooltip>
            {/if}
          </span>
        {/if}
        <button
          type="button"
          class="flex min-w-0 flex-1 items-baseline gap-2 rounded-sm px-2 py-1 text-left
                 text-muted hover:bg-hover hover:text-default"
          class:bg-raised={row.index === develop.index}
          class:text-default={row.index === develop.index}
          aria-current={row.index === develop.index}
          data-history-step={row.index}
          onclick={() => jump(row.index)}
        >
          <!-- Steps on another branch are still reachable, but they are not what the photo
               looks like, so they are drawn back. -->
          <span class="min-w-0 flex-1 truncate" class:opacity-50={!inPhoto}>{row.title}</span>
          <span class="shrink-0 tabular-nums text-faint" class:opacity-50={!inPhoto}>
            {row.detail}
          </span>
        </button>
      </div>

      <!-- The ops of one batch. Clicking one is not a jump: the whole point is to keep the
           rest of the step, so each row only offers to put its own op back. The graph's
           lanes run on past them to the step below. -->
      {#if unfolded.has(row.index)}
        <div class="flex">
          <span class="w-4 shrink-0"></span>
          <svg
            class="shrink-0 self-stretch"
            width={graphPixels}
            viewBox="0 0 {graphPixels} 1"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {#if lanes}
              {#each lanes.bottom as edge, position (position)}
                <path
                  d="M{laneX(edge.to)} 0V1"
                  stroke={laneColor(edge.to)}
                  stroke-width="1.5"
                  vector-effect="non-scaling-stroke"
                />
              {/each}
            {/if}
          </svg>
          <div class="flex min-w-0 flex-1 flex-col">
            {#each row.children as child (child.opId)}
              <!-- The revert sits in the left gutter: the right edge of the column is where
                   the scrollbar's hit area lives. -->
              <div class="flex items-center gap-1 text-faint">
                <Tooltip text="Revert {child.title}" placement="right">
                  <button
                    type="button"
                    class="rounded-sm p-1 hover:bg-hover hover:text-default"
                    data-history-revert={child.opId}
                    onclick={() => revert(row.index, child.opId ?? "")}
                  >
                    <ArrowCounterClockwiseIcon size={11} weight="bold" />
                  </button>
                </Tooltip>
                <span class="min-w-0 flex-1 truncate">{child.title}</span>
                <span class="shrink-0 pr-2 tabular-nums">{child.detail}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/each}
  {#if rows.length === 0}
    <p class="px-2 py-1 text-faint">Nothing yet.</p>
  {/if}
</div>
