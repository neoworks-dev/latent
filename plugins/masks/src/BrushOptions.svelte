<script lang="ts">
  // The brush's own numbers, shown while a brush component is selected. There is no tool
  // picker: picking a component arms the tool that edits it, and the add row above makes
  // one — a second row of the same glyphs only armed a gesture without saying for what.
  import { kernelContext } from "@latent/contracts";
  import { BoxedSlider } from "@latent/plugin-panels";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import EraserIcon from "phosphor-svelte/lib/EraserIcon";
  import { brushSizeSpec, flowSpec, featherSpec } from "./masks";

  const masks = kernelContext().masks;
</script>

{#if masks.tool === "brush"}
  <div class="flex flex-col gap-1 border-b border-line-faint px-2 py-1.5" data-brush-options>
    <div class="flex items-center gap-1">
      <span class="min-w-0 flex-1 truncate text-[10px] text-faint">
        Brush · wheel or [ ] for size
      </span>
      <Tooltip text="Erase (or hold Alt)" placement="left">
        <span data-brush-erase={masks.brushErasing}>
          <Button
            size="sm"
            variant={masks.brushErasing ? "surface" : "ghost"}
            icon={EraserIcon}
            onclick={() => (masks.brushErasing = !masks.brushErasing)}
          />
        </span>
      </Tooltip>
    </div>
    <BoxedSlider
      value={masks.brushSize * 100}
      spec={brushSizeSpec}
      range={{ min: 0.5, max: 80, step: 0.5 }}
      label="Size"
      onInput={(next) => (masks.brushSize = next / 100)}
      onCommit={(next) => (masks.brushSize = next / 100)}
      onReset={() => (masks.brushSize = 0.08)}
    />
    <BoxedSlider
      value={masks.brushFeather}
      spec={featherSpec}
      range={{ min: 0, max: 100, step: 1 }}
      label="Feather"
      onInput={(next) => (masks.brushFeather = next)}
      onCommit={(next) => (masks.brushFeather = next)}
      onReset={() => (masks.brushFeather = 50)}
    />
    <BoxedSlider
      value={masks.brushFlow}
      spec={flowSpec}
      range={{ min: 0, max: 100, step: 1 }}
      label="Flow"
      onInput={(next) => (masks.brushFlow = next)}
      onCommit={(next) => (masks.brushFlow = next)}
      onReset={() => (masks.brushFlow = 100)}
    />
  </div>
{/if}
