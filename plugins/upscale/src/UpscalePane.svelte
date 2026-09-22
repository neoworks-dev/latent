<script lang="ts">
  // The AI Upscale column (issue #52): add the op, pick 2× or 4×, run it, and see what
  // came back. The result is a cached raster — nothing here re-runs on its own, and a stale
  // badge is a statement, not a spinner.
  //
  // The op sits under everything but denoise, so the rest of the stack develops the
  // upscaled pixels. Image space does not move with it: masks and crops stay normalised
  // over the uncropped photo, and only the export renders at the larger size.
  import { kernelContext } from "@latent/contracts";
  import { modelOptions, statusLine, textParam } from "@latent/plugin-generative";
  import { Button, LoadingSpinner, Select, StatusBadge, Tooltip } from "@neoworks-dev/ui";
  import ArrowsOutIcon from "phosphor-svelte/lib/ArrowsOutIcon";
  import {
    factorOf,
    factors,
    missingGraphMessage,
    sizeNote,
    UPSCALE_OP,
    type Factor,
  } from "./upscale";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const upscale = ctx.upscale;
  const viewer = ctx.viewer;

  const op = $derived(upscale.op);
  const status = $derived(upscale.status);
  const models = $derived(modelOptions(status, UPSCALE_OP));
  const factor = $derived(factorOf(op));
  const missing = $derived(missingGraphMessage(status));

  $effect(() => {
    void upscale.refreshStatus();
  });

  function choose(next: Factor): void {
    void upscale.setParams({ factor: next });
  }
</script>

<div
  class="flex flex-col pb-4 text-xs"
  data-pane="upscale"
  data-upscale-op={op?.id ?? ""}
  data-upscale-factor={factor}
  data-upscale-stale={op?.stale === true}
  data-upscale-running={upscale.running}
  data-upscale-ready={status?.ready === true}
>
  <header class="flex items-center gap-1 border-b border-line-faint px-2 py-1.5">
    <ArrowsOutIcon size={13} />
    <span class="min-w-0 flex-1 truncate font-semibold text-default">AI Upscale</span>
    {#if op?.stale}
      <Tooltip text="The pixels under this upscale changed since it ran" placement="left">
        <span data-stale-badge><StatusBadge tone="amber">Stale</StatusBadge></span>
      </Tooltip>
    {/if}
  </header>

  <p class="px-3 py-1.5 text-[10px] text-faint" data-upscale-status>{statusLine(status)}</p>

  {#if !op}
    <div class="flex gap-1.5 px-2 pb-2">
      <span class="flex-1" data-upscale-add>
        <Button
          size="sm"
          full
          onclick={() => void upscale.add()}
          disabled={viewer.photoId === null}
        >
          Add AI Upscale
        </Button>
      </span>
    </div>
    <p class="px-3 py-2 text-faint">
      Super resolution over the whole frame. Run a denoise first if the photo needs one — an
      upscaler turns leftover noise into detail that was never there.
    </p>
  {:else}
    <p class="px-3 py-1 text-[10px] text-faint" data-upscale-size>{sizeNote(op)}</p>

    <div class="flex items-center justify-between gap-2 px-3 py-1">
      <span class="text-muted">Factor</span>
      <div class="flex gap-1">
        {#each factors as value (value)}
          <span data-upscale-factor-option={value}>
            <Button
              size="sm"
              variant={factor === value ? "surface" : "ghost"}
              onclick={() => choose(value)}
            >
              {value}
            </Button>
          </span>
        {/each}
      </div>
    </div>

    <div class="flex items-center justify-between gap-2 px-3 py-1">
      <span class="text-muted">Model</span>
      <div class="w-44">
        <Select
          value={textParam(op, "model")}
          options={models}
          placeholder="Graph default"
          onChange={(value) => void upscale.setParams({ model: String(value) })}
        />
      </div>
    </div>

    <div class="flex items-center gap-2 px-2 py-2">
      {#if upscale.running}
        <span class="flex-1" data-upscale-cancel>
          <Button size="sm" full onclick={() => void upscale.cancel()}>Cancel</Button>
        </span>
      {:else}
        <span class="flex-1" data-upscale-run>
          <Button size="sm" full variant="surface" onclick={() => void upscale.run()}>
            {op.result ? "Re-run" : "Run"}
          </Button>
        </span>
      {/if}
    </div>

    {#if missing}
      <p class="px-3 py-1 text-[10px] text-faint" data-upscale-missing>{missing}</p>
    {/if}

    {#if upscale.running}
      <div class="flex items-center gap-2 px-3 pb-2" data-upscale-progress>
        <LoadingSpinner size={12} />
        <!-- A two-div bar: the design system has no progress component, and a job whose
             backend cannot report a fraction still has to show that it is alive. -->
        <div class="h-1 flex-1 overflow-hidden rounded-full bg-raised">
          <div
            class="h-full bg-accent transition-[width] duration-200"
            style:width="{Math.max(2, Math.round(upscale.progress * 100))}%"
          ></div>
        </div>
        <span class="text-[10px] text-faint">{upscale.note}</span>
      </div>
    {/if}

    {#if upscale.error}
      <p class="px-3 py-1 text-red" data-upscale-error>{upscale.error}</p>
    {/if}
    {#if upscale.ran && !upscale.error}
      <p class="px-3 py-1 text-[10px] text-faint" data-upscale-ran>ran {upscale.ran}</p>
    {/if}
    {#if op.result}
      <p class="px-3 py-1 text-[10px] text-faint" data-upscale-result>{op.result}</p>
    {/if}
  {/if}
</div>
