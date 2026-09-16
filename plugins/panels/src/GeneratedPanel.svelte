<script lang="ts">
  import { kernelContext } from "@latent/contracts";
  import ParamControl from "./ParamControl.svelte";

  // The pane id is the panel name: one pane per `panel` value in ops.describe.
  const { paneId }: { paneId: string } = $props();
  const panels = kernelContext().panels;
</script>

<div class="flex flex-col gap-0.5 px-3 pb-3">
  {#each panels.opsFor(paneId) as op (op.name)}
    {#each op.params as spec (spec.name)}
      <ParamControl {op} {spec} />
    {/each}
  {/each}
</div>
