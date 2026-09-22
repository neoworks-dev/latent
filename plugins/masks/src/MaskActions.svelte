<script lang="ts">
  // The two controls of the panel's title bar: whether the overlay tint is drawn, and which
  // tint it is. They live in the bar rather than in the body so the body is nothing but the
  // masks themselves.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import EyeIcon from "phosphor-svelte/lib/EyeIcon";
  import EyeSlashIcon from "phosphor-svelte/lib/EyeSlashIcon";
  import PaletteIcon from "phosphor-svelte/lib/PaletteIcon";
  import { tintLabels } from "./masks";

  const { paneId: _paneId }: { paneId: string } = $props();
  const masks = kernelContext().masks;
</script>

<span class="flex items-center gap-1">
  <Tooltip text="Overlay (O)" placement="left">
    <span data-overlay-toggle={masks.overlayVisible}>
      <Button
        size="sm"
        variant={masks.overlayVisible ? "surface" : "ghost"}
        icon={masks.overlayVisible ? EyeIcon : EyeSlashIcon}
        onclick={() => masks.toggleOverlay()}
      />
    </span>
  </Tooltip>
  <Tooltip text="Overlay style: {tintLabels[masks.tint]} (Shift+O)" placement="left">
    <Button size="sm" variant="ghost" icon={PaletteIcon} onclick={() => masks.cycleTint()} />
  </Tooltip>
</span>
