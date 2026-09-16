<script lang="ts">
  // The shell knows regions and rail modes, never features: panes say where they belong
  // and which mode they belong to, the shell lays them out. The left column exists only
  // while something is registered for it; Tab takes the side panes off.
  import { kernelContext, paneModes, panesForMode, provideKernelContext } from "@latent/contracts";
  import type { Context } from "@neoworks/extension-system";
  import { Button, SectionHeader, Tooltip } from "@neoworks-dev/ui";
  import InfoIcon from "phosphor-svelte/lib/InfoIcon";
  import SelectionBackgroundIcon from "phosphor-svelte/lib/SelectionBackgroundIcon";
  import SlidersHorizontalIcon from "phosphor-svelte/lib/SlidersHorizontalIcon";
  import SquaresFourIcon from "phosphor-svelte/lib/SquaresFourIcon";
  import StackSimpleIcon from "phosphor-svelte/lib/StackSimpleIcon";
  import { untrack } from "svelte";
  import { nextChrome, shellShortcut, showsRegion, type ShellChrome } from "./shell";

  const { kernel }: { kernel: Context } = $props();
  // The kernel is created once by main.ts and never swapped; reading it untracked is intended.
  provideKernelContext(untrack(() => kernel));
  const ctx = kernelContext();

  // The mode lives on the pane registry, not here: the Edit column's mask badge hands over
  // to the Masks column, and a plugin cannot reach into a component's local state.
  const mode = $derived(ctx.panes.mode);
  let chrome = $state<ShellChrome>("all");

  const left = $derived(ctx.panes.list("left"));
  const center = $derived(ctx.panes.list("center"));
  const right = $derived(panesForMode(ctx.panes.list("right"), mode));
  const bottom = $derived(ctx.panes.list("bottom"));

  // "edit" is the default mode and needs no pane of its own to exist; everything else in
  // the rail is a mode some registered pane asked for.
  const modes = $derived([
    "edit",
    ...paneModes(ctx.panes.list("right")).filter((entry) => entry !== "edit"),
  ]);
  const railIcons: Record<string, typeof InfoIcon> = {
    edit: SlidersHorizontalIcon,
    masks: SelectionBackgroundIcon,
    layers: StackSimpleIcon,
    info: InfoIcon,
  };
  const railLabels: Record<string, string> = {
    edit: "Edit",
    masks: "Masks",
    layers: "Layers",
    info: "Info",
  };

  const showsLeft = $derived(left.length > 0 && showsRegion(chrome, "left"));
  const showsRight = $derived(showsRegion(chrome, "right"));
  const showsBottom = $derived(showsRegion(chrome, "bottom"));

  function columns(hasLeft: boolean, hasRight: boolean): string {
    const left = hasLeft ? "260px 1fr" : "1fr";
    if (!hasRight) return left;
    return `${left} 320px 44px`;
  }

  // Tab / Shift+Tab, the one shortcut the shell owns. Raw listener with its inverse;
  // Svelte reverts it when the shell unmounts.
  $effect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const action = shellShortcut({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        target,
      });
      if (!action) return;
      event.preventDefault();
      chrome = nextChrome(chrome, action.shift);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
</script>

<div
  class="grid h-full grid-rows-[1fr_auto] bg-canvas text-default"
  style:grid-template-columns={columns(showsLeft, showsRight)}
  data-chrome={chrome}
  data-mode={mode}
>
  {#if showsLeft}
    <aside class="min-h-0 overflow-y-auto border-r border-line bg-elevated">
      {#each left as pane (pane.id)}
        {@const Pane = pane.component}
        <section class="border-b border-line pt-2">
          <div class="px-3">
            <SectionHeader title={pane.title} />
          </div>
          <Pane paneId={pane.id} />
        </section>
      {/each}
    </aside>
  {/if}

  <main class="relative min-h-0 min-w-0">
    {#each center as pane (pane.id)}
      {@const Pane = pane.component}
      <Pane paneId={pane.id} />
    {/each}
  </main>

  {#if showsRight}
    <aside class="min-h-0 overflow-y-auto border-l border-line bg-elevated">
      {#each right as pane (pane.id)}
        {@const Pane = pane.component}
        <section class="border-b border-line pt-2">
          <div class="px-3">
            <SectionHeader title={pane.title} />
          </div>
          <Pane paneId={pane.id} />
        </section>
      {/each}
    </aside>

    <!-- Lightroom's right rail: one icon per mode, and the mode decides which panes the
         column above shows. -->
    <nav
      class="flex min-h-0 flex-col items-center gap-1 border-l border-line bg-elevated py-2"
      aria-label="Modes"
    >
      {#each modes as entry (entry)}
        {@const Icon = railIcons[entry] ?? SquaresFourIcon}
        {@const label = railLabels[entry] ?? entry}
        <span data-rail-mode={entry} data-active={mode === entry}>
          <Tooltip text={label} placement="left">
            <Button
              size="sm"
              variant={mode === entry ? "surface" : "ghost"}
              icon={Icon}
              onclick={() => ctx.panes.setMode(entry)}
            />
          </Tooltip>
        </span>
      {/each}
    </nav>
  {/if}

  <!-- Bottom panes stack in `order`: filmstrip, console, then the status line. -->
  {#if showsBottom}
    <footer class="col-span-full flex flex-col bg-elevated">
      {#each bottom as pane (pane.id)}
        {@const Pane = pane.component}
        <Pane paneId={pane.id} />
      {/each}
    </footer>
  {/if}
</div>
