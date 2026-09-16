<script lang="ts">
  // A toolbar, not a panel: the engine's stack revision on the left, history on the
  // right. Both readouts are the engine's — nothing here is local.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import ArrowArcLeftIcon from "phosphor-svelte/lib/ArrowArcLeftIcon";
  import ArrowArcRightIcon from "phosphor-svelte/lib/ArrowArcRightIcon";

  const { paneId: _paneId }: { paneId: string } = $props();
  const viewer = kernelContext().viewer;
</script>

<div class="flex h-9 items-center gap-1 pr-2 pl-3 text-xs text-muted">
  <span class="tabular-nums" data-revision={viewer.revision}>rev {viewer.revision}</span>
  <span class="ml-auto flex items-center">
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
</div>
