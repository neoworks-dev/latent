<script lang="ts">
  // Export in the window's header: the way into the Export rail mode from any other.
  import { kernelContext } from "@latent/contracts";
  import { Button, Tooltip } from "@neoworks-dev/ui";
  import UploadSimpleIcon from "phosphor-svelte/lib/UploadSimpleIcon";

  const { paneId: _paneId }: { paneId: string } = $props();
  const panes = kernelContext().panes;
</script>

<span data-pane="header-export">
  <Tooltip text="Export" placement="bottom">
    <Button
      size="sm"
      variant={panes.mode === "export" ? "surface" : "ghost"}
      icon={UploadSimpleIcon}
      onclick={() => panes.setMode("export")}
    />
  </Tooltip>
</span>
