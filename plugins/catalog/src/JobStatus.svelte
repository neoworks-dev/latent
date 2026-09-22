<script lang="ts">
  // The footer status line: what the catalog is showing, and what the engine is busy with.
  // Driven purely by job.progress; StatusBadge, LoadingSpinner and Button come from the
  // design system. Cancel is a `job.cancel` write — the badge only changes once the
  // engine's last job.progress says the job stopped.
  //
  // An import and the thumbnail job it queues behind itself are one badge, not two: the
  // child names its parent, so it is nested rather than shown as a second, unrelated bar.
  import { kernelContext } from "@latent/contracts";
  import { Button, LoadingSpinner, StatusBadge, Tooltip } from "@neoworks-dev/ui";
  import ArrowArcLeftIcon from "phosphor-svelte/lib/ArrowArcLeftIcon";
  import ArrowArcRightIcon from "phosphor-svelte/lib/ArrowArcRightIcon";
  import ClockCounterClockwiseIcon from "phosphor-svelte/lib/ClockCounterClockwiseIcon";
  import XIcon from "phosphor-svelte/lib/XIcon";
  import { filterLabel, jobGroups } from "./catalog";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const catalog = ctx.catalog;
  // The viewer's readouts share this line rather than floating over the picture: which
  // photo is open, where the zoom is, and what the last frame cost.
  const viewer = ctx.viewer;

  const running = $derived(catalog.jobs.filter((job) => !job.finished));
  const groups = $derived(jobGroups(catalog.jobs));

  /**
   * How far the job a badge can cancel has got, 0..1, or null when it has no count to
   * show. The design system has no progress bar and this is the only place that wants
   * one — a preview prewarm runs for minutes, and a spinner does not say how many.
   */
  function fraction(cancelJobId: number | null): number | null {
    const job = catalog.jobs.find((entry) => entry.jobId === cancelJobId);
    if (!job || job.total <= 0) return null;
    return Math.min(1, job.done / job.total);
  }
</script>

<div
  class="flex items-center gap-2 border-t border-line bg-elevated px-3 py-1 text-2xs text-muted"
  data-jobs-running={running.length}
>
  <span>{filterLabel(catalog.filter)}</span>
  <span class="tabular-nums">{catalog.total} photos</span>
  <span class="truncate text-dim" data-photo-status>{viewer.status}</span>
  <span class="ml-auto flex items-center gap-2">
    <!-- The undo step, not the engine's `revision`: that counts every write it accepted,
         one per tick of a slider drag, and a whole drag is one step here. -->
    <Tooltip text="Undo step — Ctrl+Z / Ctrl+Shift+Z" placement="top">
      <span
        class="flex items-center gap-1 tabular-nums"
        data-revision={viewer.revision}
        data-history-step={viewer.historyIndex}
      >
        <ClockCounterClockwiseIcon size={12} weight="bold" />
        {viewer.historyIndex} / {Math.max(0, viewer.historyDepth - 1)}
      </span>
    </Tooltip>
    <span class="flex items-center" data-history-buttons>
      <Button
        size="sm"
        variant="ghost"
        icon={ArrowArcLeftIcon}
        disabled={!viewer.canUndo}
        onclick={() => void viewer.undo()}
      />
      <Button
        size="sm"
        variant="ghost"
        icon={ArrowArcRightIcon}
        disabled={!viewer.canRedo}
        onclick={() => void viewer.redo()}
      />
    </span>
    <span class="tabular-nums" data-zoom-level>{viewer.zoom}</span>
    <span class="tabular-nums" data-latency>
      {viewer.latencyMs.toFixed(1)} ms ({viewer.engineMs.toFixed(1)} engine)
    </span>
    {#each groups as group (group.jobId)}
      {#if group.state === "cancelled"}
        <StatusBadge tone="amber">{group.label}</StatusBadge>
      {:else if group.state !== "running"}
        <StatusBadge tone="green">{group.label}</StatusBadge>
      {:else}
        <LoadingSpinner size={12} label="jobs" />
        <StatusBadge tone="blue">{group.label}</StatusBadge>
        {@const progress = fraction(group.cancelJobId)}
        {#if progress !== null}
          <span
            class="h-1 w-24 overflow-hidden rounded-full bg-raised"
            role="progressbar"
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={group.label}
            data-job-progress={Math.round(progress * 100)}
          >
            <span
              class="block h-full rounded-full bg-action transition-[width] duration-fast"
              style:width="{progress * 100}%"
            ></span>
          </span>
        {/if}
        <!-- Cancel stops the job that is still going; the import before its thumbnails. -->
        {#if group.cancelJobId !== null}
          {@const cancelJobId = group.cancelJobId}
          <!-- Button takes no arbitrary attributes, so the test hook sits on the wrapper. -->
          <span data-cancel-job={cancelJobId}>
            <Button
              size="sm"
              variant="ghost"
              icon={XIcon}
              onclick={() => void catalog.cancelJob(cancelJobId)}
            >
              Cancel
            </Button>
          </span>
        {/if}
      {/if}
    {/each}
  </span>
</div>
