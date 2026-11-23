<script lang="ts">
  // Undo and redo in the window's header. The same two steps as the footer's buttons: one
  // drag of a slider is one undo step.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import ArrowArcLeftIcon from "phosphor-svelte/lib/ArrowArcLeftIcon";
  import ArrowArcRightIcon from "phosphor-svelte/lib/ArrowArcRightIcon";

  const { paneId: _paneId }: { paneId: string } = $props();
  const viewer = kernelContext().viewer;
</script>

<span class="flex items-center gap-1" data-pane="header-history">
  <Tooltip text="Undo — Ctrl+Z" placement="bottom">
    <Button
      size="sm"
      variant="ghost"
      icon={ArrowArcLeftIcon}
      disabled={!viewer.canUndo}
      onclick={() => void viewer.undo()}
    />
  </Tooltip>
  <Tooltip text="Redo — Ctrl+Shift+Z" placement="bottom">
    <Button
      size="sm"
      variant="ghost"
      icon={ArrowArcRightIcon}
      disabled={!viewer.canRedo}
      onclick={() => void viewer.redo()}
    />
  </Tooltip>
</span>
