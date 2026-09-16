<script lang="ts">
  import { kernelContext } from "@latent/contracts";
  import { Button } from "@neoworks-dev/ui";
  import ArrowArcLeftIcon from "phosphor-svelte/lib/ArrowArcLeftIcon";
  import ArrowArcRightIcon from "phosphor-svelte/lib/ArrowArcRightIcon";

  const { paneId: _paneId }: { paneId: string } = $props();
  const viewer = kernelContext().viewer;
</script>

<div class="flex items-center gap-2 px-3 pb-2 text-xs text-muted">
  <span class="tabular-nums" data-revision={viewer.revision}>rev {viewer.revision}</span>
  <span class="ml-auto flex gap-1">
    <Button
      size="sm"
      variant="ghost"
      icon={ArrowArcLeftIcon}
      disabled={!viewer.canUndo}
      onclick={() => void viewer.undo()}>Undo</Button
    >
    <Button
      size="sm"
      variant="ghost"
      icon={ArrowArcRightIcon}
      disabled={!viewer.canRedo}
      onclick={() => void viewer.redo()}>Redo</Button
    >
  </span>
</div>
