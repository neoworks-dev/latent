<script lang="ts">
  // The console card's title-bar control: Clear, which only the console knows the meaning
  // of. The fold and the drag handle beside it are the shell's.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import EraserIcon from "phosphor-svelte/lib/EraserIcon";

  const { paneId: _paneId }: { paneId: string } = $props();
  const ctx = kernelContext();
</script>

<Tooltip text="Clear scrollback — Ctrl+L" placement="left">
  <Button
    size="sm"
    variant="ghost"
    icon={EraserIcon}
    disabled={ctx.console.lines.length === 0}
    onclick={() => ctx.console.clear()}
  />
</Tooltip>
