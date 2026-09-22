<script lang="ts">
  // Presets: a row per bundle of values, grouped the way Lightroom groups its own. Applying
  // one is a single whole-stack write, so a preset that moves twelve sliders is one undo
  // step and one render rather than twelve of each.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import CaretDownIcon from "phosphor-svelte/lib/CaretDownIcon";
  import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
  import PlusIcon from "phosphor-svelte/lib/PlusIcon";
  import TrashIcon from "phosphor-svelte/lib/TrashIcon";
  import { SvelteSet } from "svelte/reactivity";
  import { applyPreset, presetGroups, presetSize, type Preset } from "./presets";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
  const viewer = ctx.viewer;
  const develop = ctx.develop;

  let name = $state("");
  // Which headings are unfolded. A view preference of this pane's, not edit state. Only the
  // first group starts open, so the panel opens as a list of looks rather than a wall of
  // thirty rows.
  const open = new SvelteSet([presetGroups([])[0].label]);
  const groups = $derived(presetGroups(develop.presets));

  function toggle(label: string): void {
    if (!open.delete(label)) open.add(label);
  }

  function apply(preset: Preset): void {
    // The name goes with the write: the engine sees a dozen ops move at once and cannot
    // know they were one click, so the history row would otherwise be named after whichever
    // of them sorts first.
    void viewer.setStack(applyPreset(preset, viewer.stack), `${preset.label} applied`);
  }

  function saveCurrent(): void {
    develop.save(name, viewer.stack);
    name = "";
  }
</script>

<div class="flex flex-col gap-1 px-3 pb-2 text-xs" data-pane="presets">
  {#each groups as group (group.label)}
    <div class="flex flex-col">
      <button
        type="button"
        class="flex items-center gap-1 rounded-sm px-1 py-1 text-left text-faint
               hover:text-default"
        aria-expanded={open.has(group.label)}
        data-preset-group={group.label}
        onclick={() => toggle(group.label)}
      >
        {#if open.has(group.label)}
          <CaretDownIcon size={11} weight="bold" />
        {:else}
          <CaretRightIcon size={11} weight="bold" />
        {/if}
        <span class="uppercase tracking-wide">{group.label}</span>
        <span class="ml-auto tabular-nums">{group.presets.length}</span>
      </button>

      {#if open.has(group.label)}
        {#each group.presets as preset (preset.id)}
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 py-1 text-left
                     text-muted hover:bg-hover hover:text-default disabled:opacity-40"
              disabled={viewer.photoId === null}
              data-preset={preset.id}
              onclick={() => apply(preset)}
            >
              <span class="truncate">{preset.label}</span>
              <span class="ml-auto shrink-0 tabular-nums text-faint">{presetSize(preset)}</span>
            </button>
            {#if !preset.builtin}
              <Tooltip text="Delete {preset.label}" placement="left">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={TrashIcon}
                  onclick={() => develop.remove(preset.id)}
                />
              </Tooltip>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  {/each}

  <!-- Saving takes the open photo's own values: what the sliders say right now, minus the
       masked and generative ops, which mean nothing on another photo. -->
  <div class="flex gap-1 pt-1">
    <input
      class="min-w-0 flex-1 rounded-md border border-line bg-input px-2 py-1.5 text-default
             outline-none focus:border-line-strong placeholder:text-faint"
      placeholder="Save these settings as…"
      bind:value={name}
      onkeydown={(event) => {
        if (event.key === "Enter") saveCurrent();
      }}
      data-preset-name
    />
    <Button
      size="sm"
      variant="ghost"
      icon={PlusIcon}
      disabled={name.trim() === "" || viewer.photoId === null}
      onclick={saveCurrent}
    >
      Save
    </Button>
  </div>
</div>
