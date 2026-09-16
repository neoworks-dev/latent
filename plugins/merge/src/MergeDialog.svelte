<script lang="ts">
  // Lightroom's Photo Merge dialog: a centre pane that draws nothing until it is opened,
  // then covers the viewer the way the catalog's grid does. Kind switch, the Lightroom
  // options for that kind, a live preview fed by `merge.preview`, and the bar of the merge
  // job itself.
  //
  // Hand-built controls, and why: the design system has no slider and no segmented control.
  // The slider is the panel column's own (`@latent/plugin-panels`), so Boundary Warp feels
  // like every other slider in the app; the kind switch is three buttons in one raised
  // track, the same shape the library's quick filters use.
  import { kernelContext } from "@latent/contracts";
  import { Slider } from "@latent/plugin-panels";
  import { Button, Card, Checkbox, LoadingSpinner, SectionHeader, Select } from "@neoworks-dev/ui";
  import ImagesIcon from "phosphor-svelte/lib/ImagesIcon";
  import XIcon from "phosphor-svelte/lib/XIcon";
  import {
    boundaryWarpRange,
    deghostOptions,
    isDeghost,
    isProjection,
    kindLabels,
    kindSuffixes,
    mergeKinds,
    progressFraction,
    progressLabel,
    projectionOptions,
    showsHdrOptions,
    showsPanoramaOptions,
  } from "./merge";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const merge = ctx.merge;
  const catalog = ctx.catalog;

  const bar = $derived(merge.merging ? merge.mergeJob : null);

  function onAutoAlign(event: Event): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement)) return;
    merge.setOptions({ autoAlign: target.checked });
  }

  function onAutoCrop(event: Event): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement)) return;
    merge.setOptions({ autoCrop: target.checked });
  }

  function onDeghost(value: string | string[]): void {
    if (typeof value === "string" && isDeghost(value)) merge.setOptions({ deghost: value });
  }

  function onProjection(value: string | string[]): void {
    if (typeof value === "string" && isProjection(value)) merge.setOptions({ projection: value });
  }
</script>

{#if merge.open}
  <div
    class="absolute inset-0 z-overlay flex items-center justify-center bg-canvas/90 p-6"
    data-pane="merge"
    data-merge-kind={merge.kind}
  >
    <Card padding="none" surface="elevated" class="flex h-full w-full max-w-5xl flex-col">
      <header class="flex items-center gap-3 border-b border-line px-4 py-3">
        <ImagesIcon size={16} class="text-muted" />
        <h2 class="text-sm font-semibold text-default">Photo Merge</h2>
        <div class="ml-4 flex gap-0.5 rounded-md bg-raised p-0.5" role="group" aria-label="Kind">
          {#each mergeKinds as kind (kind)}
            <button
              type="button"
              class="rounded-sm px-3 py-1 text-xs text-muted transition-colors duration-fast
                     hover:text-default"
              class:bg-hover={merge.kind === kind}
              class:text-default={merge.kind === kind}
              aria-pressed={merge.kind === kind}
              data-merge-kind-button={kind}
              onclick={() => merge.setKind(kind)}
            >
              {kindLabels[kind]}
            </button>
          {/each}
        </div>
        <span class="ml-auto text-2xs text-faint">
          Output suffix {kindSuffixes[merge.kind]}.tif
        </span>
        <Button size="sm" variant="ghost" icon={XIcon} onclick={() => void merge.cancel()} />
      </header>

      <div class="grid min-h-0 flex-1 grid-cols-[1fr_260px]">
        <div class="relative flex min-h-0 items-center justify-center bg-canvas p-4">
          {#if merge.previewUrl}
            <img
              class="max-h-full max-w-full object-contain"
              src={merge.previewUrl}
              alt="Merge preview"
              data-merge-preview={merge.kind}
            />
          {:else if !merge.previewing}
            <p class="text-xs text-faint">No preview yet.</p>
          {/if}
          {#if merge.previewing}
            <!-- The last picture stays up while the next job runs, so the spinner needs a
                 scrim to read over it. -->
            <div
              class="absolute inset-0 flex items-center justify-center gap-2 bg-canvas/70 text-xs
                     text-muted"
            >
              <LoadingSpinner size={18} label="Rendering preview" />
              <span data-merge-previewing>Rendering preview…</span>
            </div>
          {/if}
        </div>

        <div class="flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-line px-3 pb-3">
          <div>
            <SectionHeader title="Photos" />
            <p class="px-1 text-xs text-muted" data-merge-count={merge.photoIds.length}>
              {merge.photoIds.length} selected
            </p>
            <ul class="mt-1 flex flex-col gap-1">
              {#each merge.photos as photo (photo.photoId)}
                <li class="flex items-center gap-2 text-2xs text-muted">
                  {#if catalog.thumbnailUrl(photo)}
                    <img
                      class="size-8 shrink-0 rounded-sm object-cover"
                      src={catalog.thumbnailUrl(photo)}
                      alt=""
                    />
                  {:else}
                    <span class="size-8 shrink-0 rounded-sm bg-raised"></span>
                  {/if}
                  <span class="truncate">{photo.filename}</span>
                </li>
              {/each}
            </ul>
          </div>

          {#if showsHdrOptions(merge.kind)}
            <div data-merge-section="hdr">
              <SectionHeader title="HDR" />
              <label class="flex items-center gap-2 px-1 py-1 text-xs text-muted">
                <Checkbox
                  checked={merge.options.autoAlign}
                  onchange={onAutoAlign}
                  data-merge-option="autoAlign"
                />
                Auto Align
              </label>
              <div class="px-1 pt-1">
                <span class="text-2xs text-dim">Deghost Amount</span>
                <div class="mt-1" data-merge-deghost={merge.options.deghost}>
                  <Select
                    value={merge.options.deghost}
                    options={deghostOptions}
                    onChange={onDeghost}
                  />
                </div>
              </div>
            </div>
          {/if}

          {#if showsPanoramaOptions(merge.kind)}
            <div data-merge-section="panorama">
              <SectionHeader title="Panorama" />
              <div class="px-1">
                <span class="text-2xs text-dim">Layout</span>
                <div class="mt-1" data-merge-projection={merge.options.projection}>
                  <Select
                    value={merge.options.projection}
                    options={projectionOptions}
                    onChange={onProjection}
                  />
                </div>
              </div>
              <div class="px-1 pt-2">
                <div class="flex items-baseline justify-between text-2xs">
                  <span class="text-dim">Boundary Warp</span>
                  <span class="tabular-nums text-muted" data-merge-warp
                    >{merge.options.boundaryWarp}</span
                  >
                </div>
                <Slider
                  value={merge.options.boundaryWarp}
                  range={boundaryWarpRange}
                  label="Boundary Warp"
                  onInput={(value) => merge.setOptions({ boundaryWarp: value })}
                  onCommit={(value) => merge.setOptions({ boundaryWarp: value })}
                  onReset={() => merge.setOptions({ boundaryWarp: 0 })}
                />
              </div>
              <label class="flex items-center gap-2 px-1 py-1 text-xs text-muted">
                <Checkbox
                  checked={merge.options.autoCrop}
                  onchange={onAutoCrop}
                  data-merge-option="autoCrop"
                />
                Auto Crop
              </label>
            </div>
          {/if}
        </div>
      </div>

      <footer class="flex items-center gap-3 border-t border-line px-4 py-3">
        {#if merge.problem}
          <p class="text-xs text-red" data-merge-problem>{merge.problem}</p>
        {:else if merge.error}
          <p class="text-xs text-red" data-merge-error>{merge.error}</p>
        {/if}
        {#if bar}
          <div class="flex min-w-0 flex-1 flex-col gap-1" data-merge-progress={bar.done}>
            <div class="h-1 w-full overflow-hidden rounded-full bg-raised">
              <div
                class="h-full rounded-full bg-action"
                style:width="{progressFraction(bar) * 100}%"
              ></div>
            </div>
            <span class="truncate text-2xs text-dim">{progressLabel(bar)}</span>
          </div>
        {/if}
        <div class="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onclick={() => void merge.cancel()}>Cancel</Button>
          <span data-merge-run>
            <Button
              size="sm"
              variant="primary"
              disabled={merge.problem !== "" || merge.merging}
              onclick={() => void merge.merge()}
            >
              Merge
            </Button>
          </span>
        </div>
      </footer>
    </Card>
  </div>
{/if}
