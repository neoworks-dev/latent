<script lang="ts">
  // What the pointer does over the photo, and the brush's own three numbers. The tools are
  // toggle buttons rather than a Select: they are modal, one is always on, and the wheel and
  // the bracket keys move the size while the pointer is over the image.
  import { kernelContext } from "@latent/contracts";
  import { BoxedSlider } from "@latent/plugin-panels";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import ArrowsOutCardinalIcon from "phosphor-svelte/lib/ArrowsOutCardinalIcon";
  import CircleDashedIcon from "phosphor-svelte/lib/CircleDashedIcon";
  import EraserIcon from "phosphor-svelte/lib/EraserIcon";
  import GradientIcon from "phosphor-svelte/lib/GradientIcon";
  import PaintBrushIcon from "phosphor-svelte/lib/PaintBrushIcon";
  import SelectionPlusIcon from "phosphor-svelte/lib/SelectionPlusIcon";
  import { brushSizeSpec, flowSpec, featherSpec, type MaskTool } from "./masks";

  const masks = kernelContext().masks;

  const tools: { tool: MaskTool; icon: typeof PaintBrushIcon; label: string }[] = [
    { tool: "none", icon: ArrowsOutCardinalIcon, label: "No tool" },
    { tool: "brush", icon: PaintBrushIcon, label: "Brush" },
    { tool: "linear", icon: GradientIcon, label: "Linear gradient" },
    { tool: "radial", icon: CircleDashedIcon, label: "Radial gradient" },
    { tool: "box", icon: SelectionPlusIcon, label: "Object box" },
  ];

  const sizePercent = $derived(masks.brushSize * 100);
</script>

<div class="flex flex-col gap-1 border-b border-line-faint px-2 py-1.5" data-mask-toolbar>
  <div class="flex items-center gap-1" role="group" aria-label="Mask tools">
    {#each tools as entry (entry.tool)}
      <Tooltip text={entry.label} placement="top">
        <span data-mask-tool={entry.tool} data-active={masks.tool === entry.tool}>
          <Button
            size="sm"
            variant={masks.tool === entry.tool ? "surface" : "ghost"}
            icon={entry.icon}
            onclick={() => masks.setTool(entry.tool)}
          />
        </span>
      </Tooltip>
    {/each}
    {#if masks.tool === "brush"}
      <Tooltip text="Erase (or hold Alt)" placement="top">
        <span data-brush-erase={masks.brushErasing}>
          <Button
            size="sm"
            variant={masks.brushErasing ? "surface" : "ghost"}
            icon={EraserIcon}
            onclick={() => (masks.brushErasing = !masks.brushErasing)}
          />
        </span>
      </Tooltip>
    {/if}
  </div>

  {#if masks.tool === "brush"}
    <BoxedSlider
      value={sizePercent}
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
  {/if}
</div>
