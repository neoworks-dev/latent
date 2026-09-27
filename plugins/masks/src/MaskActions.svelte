<script lang="ts">
  // The controls of the panel's title bar: a new mask, whether the overlay tint is drawn,
  // and which tint it is. They live in the bar rather than in the body so the body is
  // nothing but the masks themselves.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import EyeIcon from "phosphor-svelte/lib/EyeIcon";
  import EyeSlashIcon from "phosphor-svelte/lib/EyeSlashIcon";
  import PaletteIcon from "phosphor-svelte/lib/PaletteIcon";
  import PlusIcon from "phosphor-svelte/lib/PlusIcon";
  import { tintLabels } from "./masks";

  const { paneId: _paneId }: { paneId: string } = $props();
  const masks = kernelContext().masks;
</script>

<span class="flex items-center gap-1">
  <!-- A new mask starts empty and selected; what it covers is picked from the add grid. -->
  <Tooltip text="New mask" placement="left">
    <span data-create-mask>
      <Button size="sm" variant="ghost" icon={PlusIcon} onclick={() => void masks.createLayer()} />
    </span>
  </Tooltip>
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
