<script lang="ts">
  import { kernelContext, provideKernelContext } from "@latent/contracts";
  import type { Context } from "@neoworks/extension-system";
  import { untrack } from "svelte";

  const { kernel }: { kernel: Context } = $props();
  // The kernel is created once by main.ts and never swapped; reading it untracked is intended.
  provideKernelContext(untrack(() => kernel));
  const ctx = kernelContext();

  const center = $derived(ctx.panes.list("center"));
  const right = $derived(ctx.panes.list("right"));
  const bottom = $derived(ctx.panes.list("bottom"));
</script>

<div class="grid h-full grid-cols-[1fr_320px] grid-rows-[1fr_auto] bg-canvas text-default">
  <main class="relative min-h-0 min-w-0">
    {#each center as pane (pane.id)}
      {@const Pane = pane.component}
      <Pane paneId={pane.id} />
    {/each}
  </main>
  <aside class="min-h-0 overflow-y-auto border-l border-line bg-elevated">
    {#each right as pane (pane.id)}
      {@const Pane = pane.component}
      <section class="border-b border-line">
        <h2 class="px-3 py-2 text-xs tracking-caps uppercase text-muted">{pane.title}</h2>
        <Pane paneId={pane.id} />
      </section>
    {/each}
  </aside>
  <footer class="col-span-2 border-t border-line bg-elevated">
    {#each bottom as pane (pane.id)}
      {@const Pane = pane.component}
      <Pane paneId={pane.id} />
    {/each}
  </footer>
</div>
