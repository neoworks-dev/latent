<script lang="ts">
  // One icon per mask kind, in one place: the create menu, the component rows and the
  // Layers column all draw the same glyph for the same kind.
  import type { MaskComponentKind } from "@latent/protocol";
  import CircleDashedIcon from "phosphor-svelte/lib/CircleDashedIcon";
  import CloudIcon from "phosphor-svelte/lib/CloudIcon";
  import GradientIcon from "phosphor-svelte/lib/GradientIcon";
  import MountainsIcon from "phosphor-svelte/lib/MountainsIcon";
  import PaintBrushIcon from "phosphor-svelte/lib/PaintBrushIcon";
  import PaletteIcon from "phosphor-svelte/lib/PaletteIcon";
  import SelectionBackgroundIcon from "phosphor-svelte/lib/SelectionBackgroundIcon";
  import SelectionPlusIcon from "phosphor-svelte/lib/SelectionPlusIcon";
  import SunIcon from "phosphor-svelte/lib/SunIcon";
  import TextTIcon from "phosphor-svelte/lib/TextTIcon";
  import UserFocusIcon from "phosphor-svelte/lib/UserFocusIcon";
  import UsersIcon from "phosphor-svelte/lib/UsersIcon";

  const { kind, size = 14 }: { kind: MaskComponentKind; size?: number } = $props();

  const icons: Record<MaskComponentKind, typeof CircleDashedIcon> = {
    subject: UserFocusIcon,
    sky: CloudIcon,
    background: SelectionBackgroundIcon,
    objects: SelectionPlusIcon,
    people: UsersIcon,
    text: TextTIcon,
    brush: PaintBrushIcon,
    linear: GradientIcon,
    radial: CircleDashedIcon,
    luminance: SunIcon,
    color: PaletteIcon,
    depth: MountainsIcon,
  };
  const Icon = $derived(icons[kind] ?? CircleDashedIcon);
</script>

<Icon {size} weight="bold" />
