<script lang="ts">
  // The Generative column: add a fill or a remove over the selected mask, set the prompt,
  // the model and the seed, run it, and see what happened. The result is a cached raster —
  // nothing here re-runs on its own, and a stale badge is a statement, not a spinner.
  //
  // The prompt box and the progress bar are hand-rolled: `@neoworks-dev/ui` has no text
  // field and no progress component, and the Masks column already draws the same input.
  import { kernelContext } from "@latent/contracts";
  // Imported for its `Context` augmentation: the fill's region is an ordinary op mask.
  import "@latent/plugin-masks";
  import { ValueField } from "@latent/plugin-panels";
  import { Button, LoadingSpinner, Select, StatusBadge, Tooltip } from "@neoworks-dev/ui";
  import DiceFiveIcon from "phosphor-svelte/lib/DiceFiveIcon";
  import SparkleIcon from "phosphor-svelte/lib/SparkleIcon";
  import {
    generativeOps,
    modelOptions,
    numberParam,
    opLabels,
    rollSeed,
    seedSpec,
    statusLine,
    takesPrompt,
    textParam,
    type GenerativeOpName,
  } from "./generative";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const generative = ctx.generative;
  const viewer = ctx.viewer;
  const masks = ctx.masks;
  const panes = ctx.panes;

  const op = $derived(generative.op);
  const status = $derived(generative.status);
  const models = $derived(modelOptions(status, op?.op ?? "generative_fill"));
  const components = $derived(op?.mask?.components ?? []);
  const seed = $derived(numberParam(op, "seed", 0));
  // The prompt is an op param, so the engine owns it; this mirror only exists so typing
  // does not write a stack revision per keystroke.
  let draft = $state("");
  let draftOpId = $state<string | null>(null);

  $effect(() => {
    const current = op;
    if (!current || current.id === draftOpId) return;
    draftOpId = current.id;
    draft = textParam(current, "prompt");
  });

  $effect(() => {
    void generative.refreshStatus();
  });

  function create(name: GenerativeOpName): void {
    void generative.create(name, masks.mask);
  }

  function chooseMask(): void {
    if (op) viewer.selectOp(op.id);
    panes.setMode("masks");
  }
</script>

<div
  class="flex flex-col pb-4 text-xs"
  data-pane="generative"
  data-generative-op={op?.id ?? ""}
  data-generative-stale={op?.stale === true}
  data-generative-running={generative.running}
  data-generative-ready={status?.ready === true}
>
  <header class="flex items-center gap-1 border-b border-line-faint px-2 py-1.5">
    <SparkleIcon size={13} />
    <span class="min-w-0 flex-1 truncate font-semibold text-default">
      {op ? opLabels[op.op as GenerativeOpName] : "Generative"}
    </span>
    {#if op?.stale}
      <Tooltip text="The pixels under this fill changed since it ran" placement="left">
        <span data-stale-badge><StatusBadge tone="amber">Stale</StatusBadge></span>
      </Tooltip>
    {/if}
  </header>

  <p class="px-3 py-1.5 text-[10px] text-faint" data-generative-status>
    {statusLine(status)}
  </p>

  <div class="flex gap-1.5 px-2 pb-2">
    {#each generativeOps as name (name)}
      <Button size="sm" full onclick={() => create(name)} disabled={viewer.photoId === null}>
        {opLabels[name]}
      </Button>
    {/each}
  </div>

  {#if !op}
    <p class="px-3 py-2 text-faint">
      Add one above. It takes the mask of the layer selected in the Masks column, or you can choose
      one after.
    </p>
  {:else}
    {#if components.length === 0}
      <div class="flex items-center justify-between gap-2 px-3 py-2">
        <span class="text-muted">No region yet</span>
        <span data-choose-mask>
          <Button size="sm" onclick={chooseMask}>Choose a mask</Button>
        </span>
      </div>
    {:else}
      <p class="px-3 py-1 text-[10px] text-faint">
        {components.length} mask component{components.length === 1 ? "" : "s"} · the region this repaints
      </p>
    {/if}

    {#if takesPrompt(op.op)}
      <label class="flex flex-col gap-1 px-3 py-1">
        <span class="text-muted">Prompt</span>
        <textarea
          class="min-h-14 w-full resize-y rounded-sm border border-line-strong bg-input px-1.5
                 py-1 text-xs text-default"
          placeholder="a straw hat"
          bind:value={draft}
          onchange={() => void generative.setParams({ prompt: draft })}
          data-generative-prompt></textarea>
      </label>
    {/if}

    <div class="flex items-center justify-between gap-2 px-3 py-1">
      <span class="text-muted">Model</span>
      <div class="w-44">
        <Select
          value={textParam(op, "model")}
          options={models}
          placeholder="Graph default"
          onChange={(value) => void generative.setParams({ model: String(value) })}
        />
      </div>
    </div>

    <div class="flex items-center justify-between gap-2 px-3 py-1">
      <span class="text-muted">Seed</span>
      <div class="flex items-center gap-1">
        <ValueField
          value={seed}
          spec={seedSpec}
          range={{ min: 0, max: 999999, step: 1 }}
          label="Seed"
          onInput={(next) => void generative.setParams({ seed: next })}
          onCommit={(next) => void generative.setParams({ seed: next })}
        />
        <Tooltip text="Another seed" placement="left">
          <span data-roll-seed>
            <Button
              size="sm"
              variant="ghost"
              icon={DiceFiveIcon}
              onclick={() => void generative.setParams({ seed: rollSeed() })}
            />
          </span>
        </Tooltip>
      </div>
    </div>

    <div class="flex items-center gap-2 px-2 py-2">
      {#if generative.running}
        <span class="flex-1" data-generative-cancel>
          <Button size="sm" full onclick={() => void generative.cancel()}>Cancel</Button>
        </span>
      {:else}
        <span class="flex-1" data-generative-run>
          <Button
            size="sm"
            full
            variant="surface"
            disabled={components.length === 0}
            onclick={() => void generative.run()}
          >
            {op.result ? "Re-run" : "Run"}
          </Button>
        </span>
      {/if}
    </div>

    {#if generative.running}
      <div class="flex items-center gap-2 px-3 pb-2" data-generative-progress>
        <LoadingSpinner size={12} />
        <!-- A two-div bar: the design system has no progress component, and a job whose
             backend cannot report a fraction still has to show that it is alive. -->
        <div class="h-1 flex-1 overflow-hidden rounded-full bg-raised">
          <div
            class="h-full bg-accent transition-[width] duration-200"
            style:width="{Math.max(2, Math.round(generative.progress * 100))}%"
          ></div>
        </div>
        <span class="text-[10px] text-faint">{generative.note}</span>
      </div>
    {/if}

    {#if generative.error}
      <p class="px-3 py-1 text-red" data-generative-error>{generative.error}</p>
    {/if}
    {#if generative.ran && !generative.error}
      <p class="px-3 py-1 text-[10px] text-faint" data-generative-ran>ran {generative.ran}</p>
    {/if}
    {#if op.result}
      <p class="px-3 py-1 text-[10px] text-faint" data-generative-result>{op.result}</p>
    {/if}
  {/if}
</div>
