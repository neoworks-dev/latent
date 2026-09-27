<script lang="ts">
  // pi's mark, from Simple Icons (CC0).
  import type { ComponentProps } from "svelte";
  import type { IconComponent } from "@neoworks-dev/ui";

  const { size = 16, class: className }: ComponentProps<IconComponent> = $props();
</script>

<svg
  class={className}
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="currentColor"
  role="img"
>
  <path d="M0 0v24h6v-6h6v-6H6V6h6v6h6V0Zm18 12v12h6V12Z" />
</svg>
