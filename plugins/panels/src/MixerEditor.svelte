<script lang="ts">
  // Lightroom's Color Mixer: a Hue / Saturation / Luminance tab strip over the eight
  // colour bands, plus All, which is Lightroom's grid of every band's three sliders at
  // once. Nothing here is a new control — the rows are the column's own `ParamControl`,
  // with the same tinted track, scrubbable readout and coalescing as every other slider.
  // What is hand-built is the grouping: the engine describes twenty-four flat parameters
  // and Lightroom shows eight rows at a time.
  import { kernelContext } from "@latent/contracts";
  import type { OpDefinition } from "@latent/protocol";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import ArrowCounterClockwiseIcon from "phosphor-svelte/lib/ArrowCounterClockwiseIcon";
  import { mixerChannels, paramValue, type MixerParams } from "./panels";
  import ParamControl from "./ParamControl.svelte";

  const {
    op,
    mixer,
    opId = null,
  }: {
    op: OpDefinition;
    mixer: MixerParams;
    /** One stack entry instead of the first op of this name, as `ParamControl` takes. */
    opId?: string | null;
  } = $props();
  const viewer = kernelContext().viewer;

  /** The channel being shown, or `all` for Lightroom's every-band grid. */
  let tab = $state<string>(mixerChannels[0]);

  const disabled = $derived(viewer.photoId === null);
  const sliders = $derived(mixer.bands.flatMap((band) => band.sliders));
  const edited = $derived(
    sliders.some(
      (slider) => paramValue(viewer.stack, op, slider.spec, opId) !== slider.spec.default,
    ),
  );

  function reset(): void {
    const neutral = sliders.map((slider): [string, unknown] => [
      slider.spec.name,
      slider.spec.default,
    ]);
    const params = Object.fromEntries(neutral);
    if (opId) {
      void viewer.setOpParams(opId, params, false);
      return;
    }
    void viewer.setParam(op.name, params, false);
  }
</script>

<div class="flex flex-col" data-mixer-editor={op.name}>
  <div class="flex items-center gap-1 px-3 pt-2 pb-1">
    <span class="flex-1 text-xs font-semibold text-default">{op.label}</span>
    <Tooltip text="Reset the mixer" placement="left">
      <Button
        size="sm"
        variant="ghost"
        icon={ArrowCounterClockwiseIcon}
        disabled={disabled || !edited}
        onclick={reset}
      />
    </Tooltip>
  </div>

  <div class="flex items-center gap-0.5 px-3 pb-1" role="tablist" aria-label="{op.label} channel">
    {#each [...mixerChannels, "All"] as entry (entry)}
      <button
        type="button"
        role="tab"
        class="min-w-0 flex-1 truncate rounded-sm px-1 py-1 text-center text-[11px] leading-none
               text-muted transition-colors hover:text-default aria-selected:bg-raised
               aria-selected:text-default"
        aria-selected={tab === entry}
        title={entry}
        onclick={() => (tab = entry)}
        data-mixer-tab={entry}>{entry}</button
      >
    {/each}
  </div>

  {#if tab === "All"}
    {#each mixer.bands as band (band.name)}
      <div
        class="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide text-faint uppercase"
        data-mixer-band={band.name}
      >
        {band.label}
      </div>
      {#each band.sliders as slider (slider.spec.name)}
        <ParamControl {op} spec={slider.spec} {opId} rowName={slider.channel} />
      {/each}
    {/each}
  {:else}
    {#each mixer.bands as band (band.name)}
      {@const slider = band.sliders.find((entry) => entry.channel === tab)}
      {#if slider}
        <ParamControl {op} spec={slider.spec} {opId} rowName={band.label} />
      {/if}
    {/each}
  {/if}
</div>
