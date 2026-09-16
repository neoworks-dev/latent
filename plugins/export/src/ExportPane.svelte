<script lang="ts">
  // Right column, rail mode "export": Lightroom's Export dialog as a pane, because Latent
  // has one window and one right column (CLAUDE.md) and a modal would have to fight both.
  //
  // Hand-built controls, and why: the design system has no text field (the folder path and
  // the file-name template are bare inputs in a token-styled shell, the same shell the
  // Library search box uses), no number field that is not tied to an op parameter, and no
  // progress bar — the export bar is determinate, which is the whole point of showing it.
  import { kernelContext } from "@latent/contracts";
  import { Button, SectionHeader, Select, Tooltip } from "@neoworks-dev/ui";
  import FolderOpenIcon from "phosphor-svelte/lib/FolderOpenIcon";
  import UploadSimpleIcon from "phosphor-svelte/lib/UploadSimpleIcon";
  import XIcon from "phosphor-svelte/lib/XIcon";
  import {
    colorSpaceChoices,
    formatChoices,
    jobLabel,
    jobPercent,
    settingsProblem,
    sharpenAmountChoices,
    sharpenChoices,
    usesQuality,
    type ExportSettings,
    type SizeMode,
  } from "./export";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const state = ctx.export;

  const photoIds = $derived(state.photoIds);
  const problem = $derived(settingsProblem(state.settings, photoIds.length));
  const percent = $derived(jobPercent(state.job));
  const label = $derived(jobLabel(state.job));

  const sizeModes: { value: SizeMode; label: string }[] = [
    { value: "native", label: "Full size" },
    { value: "longEdge", label: "Long edge" },
  ];

  function patch(change: Partial<ExportSettings>): void {
    state.settings = { ...state.settings, ...change };
  }

  // `Select` hands back `string | string[]`; every select here is single, and matching the
  // answer against the list it was built from narrows it without a cast.
  function pick<T extends string>(
    value: string | string[],
    choices: readonly { value: T }[],
    apply: (chosen: T) => void,
  ): void {
    if (typeof value !== "string") return;
    const match = choices.find((entry) => entry.value === value);
    if (match) apply(match.value);
  }

  function numberFrom(text: string, fallback: number): number {
    const parsed = Number.parseInt(text, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
</script>

<div
  class="flex h-full flex-col gap-3 overflow-y-auto px-3 pt-1 pb-3 text-xs"
  data-pane="export"
  data-export-count={photoIds.length}
>
  <p class="text-muted">
    {photoIds.length === 1 ? "1 photo" : `${photoIds.length} photos`}
    {state.fromSelection ? "selected" : "open"}
  </p>

  <SectionHeader title="File" />
  <label class="flex items-center justify-between gap-2">
    <span class="text-muted">Format</span>
    <span class="w-40" data-export-format>
      <Select
        value={state.settings.format}
        options={formatChoices.map((entry) => ({ value: entry.value, label: entry.label }))}
        onChange={(value) => pick(value, formatChoices, (format) => patch({ format }))}
      />
    </span>
  </label>

  {#if usesQuality(state.settings.format)}
    <label class="flex items-center justify-between gap-2">
      <span class="text-muted">Quality</span>
      <input
        class="w-40 accent-blue"
        type="range"
        min="1"
        max="100"
        step="1"
        data-export-quality
        value={state.settings.quality}
        oninput={(event) => patch({ quality: numberFrom(event.currentTarget.value, 90) })}
      />
      <span class="w-6 text-right text-dim">{state.settings.quality}</span>
    </label>
  {/if}

  <label class="flex items-center justify-between gap-2">
    <span class="text-muted">Colour space</span>
    <span class="w-40" data-export-colorspace>
      <Select
        value={state.settings.colorSpace}
        options={colorSpaceChoices.map((entry) => ({ value: entry.value, label: entry.label }))}
        onChange={(value) => pick(value, colorSpaceChoices, (colorSpace) => patch({ colorSpace }))}
      />
    </span>
  </label>

  <SectionHeader title="Size" />
  <div class="flex gap-0.5 rounded-md bg-raised p-0.5" role="group" aria-label="Export size">
    {#each sizeModes as entry (entry.value)}
      <button
        type="button"
        class="flex-1 rounded-sm px-2 py-1 text-muted transition-colors duration-fast
               hover:text-default"
        class:bg-hover={state.settings.sizeMode === entry.value}
        class:text-default={state.settings.sizeMode === entry.value}
        aria-pressed={state.settings.sizeMode === entry.value}
        data-export-size={entry.value}
        onclick={() => patch({ sizeMode: entry.value })}
      >
        {entry.label}
      </button>
    {/each}
  </div>

  {#if state.settings.sizeMode === "longEdge"}
    <label class="flex items-center justify-between gap-2">
      <span class="text-muted">Pixels</span>
      <span
        class="flex w-40 items-center rounded-md border border-line bg-input px-2 py-1.5
               focus-within:border-line-strong"
      >
        <input
          class="min-w-0 flex-1 bg-transparent text-default outline-none"
          type="number"
          min="1"
          max="16384"
          data-export-long-edge
          value={state.settings.longEdge}
          oninput={(event) => patch({ longEdge: numberFrom(event.currentTarget.value, 0) })}
        />
      </span>
    </label>
  {/if}

  <label class="flex items-center justify-between gap-2">
    <span class="text-muted">Resolution</span>
    <span
      class="flex w-40 items-center gap-1 rounded-md border border-line bg-input px-2 py-1.5
             focus-within:border-line-strong"
    >
      <input
        class="min-w-0 flex-1 bg-transparent text-default outline-none placeholder:text-faint"
        type="number"
        min="0"
        max="16384"
        placeholder="none"
        data-export-dpi
        value={state.settings.dpi > 0 ? state.settings.dpi : ""}
        oninput={(event) => patch({ dpi: numberFrom(event.currentTarget.value, 0) })}
      />
      <span class="shrink-0 text-faint">dpi</span>
    </span>
  </label>

  <SectionHeader title="Output sharpening" />
  <label class="flex items-center justify-between gap-2">
    <span class="text-muted">For</span>
    <span class="w-40" data-export-sharpen>
      <Select
        value={state.settings.sharpen}
        options={sharpenChoices.map((entry) => ({ value: entry.value, label: entry.label }))}
        onChange={(value) => pick(value, sharpenChoices, (sharpen) => patch({ sharpen }))}
      />
    </span>
  </label>
  {#if state.settings.sharpen !== "none"}
    <label class="flex items-center justify-between gap-2">
      <span class="text-muted">Amount</span>
      <span class="w-40" data-export-sharpen-amount>
        <Select
          value={state.settings.sharpenAmount}
          options={sharpenAmountChoices.map((entry) => ({
            value: entry.value,
            label: entry.label,
          }))}
          onChange={(value) =>
            pick(value, sharpenAmountChoices, (sharpenAmount) => patch({ sharpenAmount }))}
        />
      </span>
    </label>
  {/if}

  <SectionHeader title="Destination" />
  <div class="flex gap-1">
    <Tooltip text="Choose the folder the files land in" placement="bottom">
      <Button size="sm" icon={FolderOpenIcon} onclick={() => void state.pickOutputDir()}>
        Folder…
      </Button>
    </Tooltip>
  </div>
  <div
    class="flex items-center rounded-md border border-line bg-input px-2 py-1.5
           focus-within:border-line-strong"
  >
    <input
      class="min-w-0 flex-1 bg-transparent text-default outline-none placeholder:text-faint"
      placeholder="/path/to/exports"
      data-export-dir
      value={state.settings.outputDir}
      oninput={(event) => patch({ outputDir: event.currentTarget.value })}
    />
  </div>
  <label class="flex flex-col gap-1">
    <span class="text-muted">File name</span>
    <span
      class="flex items-center rounded-md border border-line bg-input px-2 py-1.5
             focus-within:border-line-strong"
    >
      <input
        class="min-w-0 flex-1 bg-transparent text-default outline-none placeholder:text-faint"
        placeholder="&#123;name&#125;"
        data-export-template
        value={state.settings.fileNameTemplate}
        oninput={(event) => patch({ fileNameTemplate: event.currentTarget.value })}
      />
    </span>
    <span class="text-2xs text-faint">
      &#123;name&#125; the source file, &#123;index&#125; its place in the run
    </span>
  </label>

  <div class="mt-1 flex items-center gap-1">
    <Tooltip text={problem ?? "Render and write the files"} placement="top">
      <span data-export-run>
        <Button
          size="sm"
          variant="primary"
          icon={UploadSimpleIcon}
          disabled={problem !== null || state.running}
          onclick={() => void state.run(photoIds)}
        >
          Export
        </Button>
      </span>
    </Tooltip>
    {#if state.running}
      <span data-export-cancel>
        <Button size="sm" variant="ghost" icon={XIcon} onclick={() => void state.cancel()}>
          Cancel
        </Button>
      </span>
    {/if}
  </div>

  {#if state.job}
    <div data-export-job={state.job.finished ? (state.job.state ?? "done") : "running"}>
      <div class="h-1.5 w-full overflow-hidden rounded-full bg-raised">
        <div
          class="h-full rounded-full bg-blue transition-all duration-fast"
          style:width="{percent}%"
        ></div>
      </div>
      <p class="mt-1 text-2xs text-dim" data-export-status>{label}</p>
    </div>
  {/if}
  {#if state.error}
    <p class="text-2xs text-red" data-export-error>{state.error}</p>
  {/if}
</div>
