<script lang="ts">
  // The footer status line: what the catalog is showing, and what the engine is busy with.
  // Driven purely by job.progress; StatusBadge, LoadingSpinner and Button come from the
  // design system. Cancel is a `job.cancel` write — the badge only changes once the
  // engine's last job.progress says the job stopped.
  //
  // An import and the thumbnail job it queues behind itself are one badge, not two: the
  // child names its parent, so it is nested rather than shown as a second, unrelated bar.
  import { kernelContext } from "@latent/contracts";
  import { Button, LoadingSpinner, StatusBadge } from "@neoworks-dev/ui";
  import XIcon from "phosphor-svelte/lib/XIcon";
  import { filterLabel, jobGroups } from "./catalog";

  const { paneId: _paneId }: { paneId: string } = $props();
  const catalog = kernelContext().catalog;

  const running = $derived(catalog.jobs.filter((job) => !job.finished));
  const groups = $derived(jobGroups(catalog.jobs));
</script>

<div
  class="flex items-center gap-2 border-t border-line bg-elevated px-3 py-1 text-2xs text-muted"
  data-jobs-running={running.length}
>
  <span>{filterLabel(catalog.filter)}</span>
  <span class="tabular-nums">{catalog.total} photos</span>
  <span class="ml-auto flex items-center gap-2">
    {#each groups as group (group.jobId)}
      {#if group.state === "cancelled"}
        <StatusBadge tone="amber">{group.label}</StatusBadge>
      {:else if group.state !== "running"}
        <StatusBadge tone="green">{group.label}</StatusBadge>
      {:else}
        <LoadingSpinner size={12} label="jobs" />
        <StatusBadge tone="blue">{group.label}</StatusBadge>
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
