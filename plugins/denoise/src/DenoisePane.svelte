<script lang="ts">
  // The Denoise column (issue #51), both halves of it.
  //
  // Manual Denoise is first because it is the one that answers in a frame: four sliders on
  // a wavelet filter, no model, no job, no waiting. AI Denoise below it is a run the user
  // asks for and a cached raster — nothing here re-runs on its own, and a stale badge is a
  // statement, not a spinner.
  //
  // They stack rather than compete: the model raster renders below everything else, and the
  // filter renders after it, so the sliders clean up whatever the model left. Every slider
  // in the Edit column then develops the result of both.
  import { kernelContext } from "@latent/contracts";
  import { modelOptions, statusLine, textParam } from "@latent/plugin-generative";
  import { ValueField } from "@latent/plugin-panels";
  import { Button, LoadingSpinner, Select, StatusBadge, Tooltip } from "@neoworks-dev/ui";
  import DropHalfIcon from "phosphor-svelte/lib/DropHalfIcon";
  import SlidersIcon from "phosphor-svelte/lib/SlidersIcon";
  import {
    DENOISE_OP,
    manualNote,
    manualSpecs,
    manualValue,
    missingGraphMessage,
    resolutionNote,
    strengthSpec,
  } from "./denoise";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const denoise = ctx.denoise;
  const manual = ctx.manualDenoise;
  const viewer = ctx.viewer;

  const manualOp = $derived(manual.op);

  const op = $derived(denoise.op);
  const status = $derived(denoise.status);
  const models = $derived(modelOptions(status, DENOISE_OP));
  const strength = $derived(
    typeof op?.params.strength === "number" ? op.params.strength : Number(strengthSpec.default),
  );
  const missing = $derived(missingGraphMessage(status));

  $effect(() => {
    void denoise.refreshStatus();
  });
</script>

<div
  class="flex flex-col pb-4 text-xs"
  data-pane="denoise"
  data-denoise-op={op?.id ?? ""}
  data-manual-denoise-op={manualOp?.id ?? ""}
  data-denoise-stale={op?.stale === true}
  data-denoise-running={denoise.running}
  data-denoise-ready={status?.ready === true}
>
  <header class="flex items-center gap-1 border-b border-line-faint px-2 py-1.5">
    <SlidersIcon size={13} />
    <span class="min-w-0 flex-1 truncate font-semibold text-default">Manual Denoise</span>
  </header>

  {#if !manualOp}
    <div class="flex gap-1.5 px-2 pt-2 pb-1">
      <span class="flex-1" data-manual-denoise-add>
        <Button size="sm" full onclick={() => void manual.add()} disabled={viewer.photoId === null}>
          Add Manual Denoise
        </Button>
      </span>
    </div>
    <p class="px-3 pb-2 text-faint">{manualNote}</p>
  {:else}
    <p class="px-3 py-1 text-[10px] text-faint">{manualNote}</p>
    {#each manualSpecs as spec (spec.name)}
      <div class="flex items-center justify-between gap-2 px-3 py-1">
        <span class="text-muted">{spec.label}</span>
        <ValueField
          value={manualValue(manualOp, spec)}
          {spec}
          range={{ min: 0, max: 100, step: 1 }}
          label={spec.label ?? spec.name}
          onInput={(next) => void manual.setParams({ [spec.name]: next }, true)}
          onCommit={(next) => void manual.setParams({ [spec.name]: next }, false)}
        />
      </div>
    {/each}
  {/if}

  <header class="mt-2 flex items-center gap-1 border-y border-line-faint px-2 py-1.5">
    <DropHalfIcon size={13} />
    <span class="min-w-0 flex-1 truncate font-semibold text-default">AI Denoise</span>
    {#if op?.stale}
      <Tooltip text="The pixels under this denoise changed since it ran" placement="left">
        <span data-stale-badge><StatusBadge tone="amber">Stale</StatusBadge></span>
      </Tooltip>
    {/if}
  </header>

  <p class="px-3 py-1.5 text-[10px] text-faint" data-denoise-status>{statusLine(status)}</p>

  {#if !op}
    <div class="flex gap-1.5 px-2 pb-2">
      <span class="flex-1" data-denoise-add>
        <Button
          size="sm"
          full
          onclick={() => void denoise.add()}
          disabled={viewer.photoId === null}
        >
          Add AI Denoise
        </Button>
      </span>
    </div>
    <p class="px-3 py-2 text-faint">
      One model pass over the whole frame, under every other adjustment: the ops above it develop
      what the model returned.
    </p>
  {:else}
    <p class="px-3 py-1 text-[10px] text-faint">{resolutionNote(status)}</p>

    <div class="flex items-center justify-between gap-2 px-3 py-1">
      <span class="text-muted">Strength</span>
      <ValueField
        value={strength}
        spec={strengthSpec}
        range={{ min: 0, max: 100, step: 1 }}
        label="Strength"
        onInput={(next) => void denoise.setParams({ strength: next })}
        onCommit={(next) => void denoise.setParams({ strength: next })}
      />
    </div>

    <div class="flex items-center justify-between gap-2 px-3 py-1">
      <span class="text-muted">Model</span>
      <div class="w-44">
        <Select
          value={textParam(op, "model")}
          options={models}
          placeholder="Graph default"
          onChange={(value) => void denoise.setParams({ model: String(value) })}
        />
      </div>
    </div>

    <div class="flex items-center gap-2 px-2 py-2">
      {#if denoise.running}
        <span class="flex-1" data-denoise-cancel>
          <Button size="sm" full onclick={() => void denoise.cancel()}>Cancel</Button>
        </span>
      {:else}
        <span class="flex-1" data-denoise-run>
          <Button size="sm" full variant="surface" onclick={() => void denoise.run()}>
            {op.result ? "Re-run" : "Run"}
          </Button>
        </span>
      {/if}
    </div>

    {#if missing}
      <p class="px-3 py-1 text-[10px] text-faint" data-denoise-missing>{missing}</p>
    {/if}

    {#if denoise.running}
      <div class="flex items-center gap-2 px-3 pb-2" data-denoise-progress>
        <LoadingSpinner size={12} />
        <!-- A two-div bar: the design system has no progress component, and a job whose
             backend cannot report a fraction still has to show that it is alive. -->
        <div class="h-1 flex-1 overflow-hidden rounded-full bg-raised">
          <div
            class="h-full bg-accent transition-[width] duration-200"
            style:width="{Math.max(2, Math.round(denoise.progress * 100))}%"
          ></div>
        </div>
        <span class="text-[10px] text-faint">{denoise.note}</span>
      </div>
    {/if}

    {#if denoise.error}
      <p class="px-3 py-1 text-red" data-denoise-error>{denoise.error}</p>
    {/if}
    {#if denoise.ran && !denoise.error}
      <p class="px-3 py-1 text-[10px] text-faint" data-denoise-ran>ran {denoise.ran}</p>
    {/if}
    {#if op.result}
      <p class="px-3 py-1 text-[10px] text-faint" data-denoise-result>{op.result}</p>
    {/if}
  {/if}
</div>
