<script lang="ts">
  // The shell knows regions and rail modes, never features: panes say where they belong
  // and which mode they belong to, the shell lays them out. The left column exists only
  // while something is registered for it; Tab takes the side panes off.
  import {
    kernelContext,
    paneModes,
    panesForMode,
    provideKernelContext,
    type PaneDefinition,
  } from "@latent/contracts";
  import type { Context } from "@neoworks/extension-system";
  import { Button, FloatingScrollbar, Tooltip } from "@neoworks-dev/ui";
  import ArrowsOutIcon from "phosphor-svelte/lib/ArrowsOutIcon";
  import CropIcon from "phosphor-svelte/lib/CropIcon";
  import DropHalfIcon from "phosphor-svelte/lib/DropHalfIcon";
  import SelectionBackgroundIcon from "phosphor-svelte/lib/SelectionBackgroundIcon";
  import SlidersHorizontalIcon from "phosphor-svelte/lib/SlidersHorizontalIcon";
  import SparkleIcon from "phosphor-svelte/lib/SparkleIcon";
  import SquaresFourIcon from "phosphor-svelte/lib/SquaresFourIcon";
  import StackSimpleIcon from "phosphor-svelte/lib/StackSimpleIcon";
  import SunIcon from "phosphor-svelte/lib/SunIcon";
  import TerminalWindowIcon from "phosphor-svelte/lib/TerminalWindowIcon";
  import UploadSimpleIcon from "phosphor-svelte/lib/UploadSimpleIcon";
  import XIcon from "phosphor-svelte/lib/XIcon";
  import { untrack } from "svelte";
  import { PanelLayout } from "./lib/kernel/layout.svelte";
  import { type FloatingPanel, type Rect } from "./panels";
  import PanelCard from "./PanelCard.svelte";
  import PanelColumn from "./PanelColumn.svelte";
  import {
    nextChrome,
    PANE_LAYOUT,
    shellShortcut,
    showsRegion,
    viewerSafeArea,
    type ShellChrome,
  } from "./shell";

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
  // Every right-hand pane, and the subset the rail's mode shows. A card dragged out of the
  // column keeps its place while another mode is up — it is where the user put it — so the
  // floating ones resolve against the full list and grey out when their mode is not on.
  const allRight = $derived(ctx.panes.list("right"));
  const right = $derived(panesForMode(allRight, mode));
  const bottom = $derived(ctx.panes.list("bottom"));
  // Rail panes are not in any column: the rail draws a button each, and the one that is on
  // opens beside it. It stays open while the rail switches modes — Masks is edited with the
  // Edit column's own sliders, so closing it on a mode change would close it immediately.
  const railPanes = $derived(ctx.panes.list("rail"));
  const flyout = $derived(railPanes.find((pane) => pane.id === ctx.panes.railPane));

  // "edit" is the default mode and needs no pane of its own to exist; everything else in
  // the rail is a mode some registered pane asked for.
  const modes = $derived([
    "edit",
    ...paneModes(ctx.panes.list("right")).filter((entry) => entry !== "edit"),
  ]);
  const railIcons: Record<string, typeof CropIcon> = {
    edit: SlidersHorizontalIcon,
    crop: CropIcon,
    masks: SelectionBackgroundIcon,
    generative: SparkleIcon,
    denoise: DropHalfIcon,
    upscale: ArrowsOutIcon,
    relight: SunIcon,
    layers: StackSimpleIcon,
    export: UploadSimpleIcon,
    python: TerminalWindowIcon,
  };
  const railLabels: Record<string, string> = {
    edit: "Edit",
    crop: "Crop",
    masks: "Masks",
    generative: "Generative",
    denoise: "Denoise",
    upscale: "AI Upscale",
    relight: "Relight — L",
    layers: "Layers",
    export: "Export",
    python: "Python — Ctrl+`",
  };

  const showsLeft = $derived(left.length > 0 && showsRegion(chrome, "left"));
  const showsRight = $derived(showsRegion(chrome, "right"));
  const showsBottom = $derived(showsRegion(chrome, "bottom"));

  function columns(hasLeft: boolean, hasRight: boolean): string {
    const left = hasLeft ? `${PANE_LAYOUT.left}px 1fr` : "1fr";
    if (!hasRight) return left;
    // The rail sits between the photo and the column it switches, and the column is flush
    // with the right edge of the window.
    return `${left} ${PANE_LAYOUT.rail}px ${PANE_LAYOUT.right}px`;
  }

  // The footer is as tall as the filmstrip and the status line make it, so the safe area
  // has to measure it rather than assume a height.
  let footerHeight = $state(0);

  // Both columns are cards: docked in an order the user drags, or floating over the viewer.
  // One layout each — a card belongs to the column it was registered for, and the two are
  // remembered separately.
  const rightLayout = new PanelLayout(localStorage);
  const leftLayout = new PanelLayout(localStorage, "latent.panel-layout.left.v1");
  let leftColumn = $state<PanelColumn | null>(null);
  let rightColumn = $state<PanelColumn | null>(null);

  const rightById = $derived(new Map(allRight.map((pane) => [pane.id, pane])));
  const leftById = $derived(new Map(left.map((pane) => [pane.id, pane])));
  // A docked id can name a pane that has since unregistered — a rail mode swapped the
  // column out — so every list resolves through the registry and drops what is not there.
  function resolve(ids: string[], known: Map<string, PaneDefinition>): PaneDefinition[] {
    return ids
      .map((id) => known.get(id))
      .filter((pane): pane is PaneDefinition => pane !== undefined);
  }
  const rightDockedIds = $derived(rightLayout.docked(right.map((pane) => pane.id)));
  const leftDockedIds = $derived(leftLayout.docked(left.map((pane) => pane.id)));
  const rightDocked = $derived(resolve(rightDockedIds, rightById));
  const leftDocked = $derived(resolve(leftDockedIds, leftById));

  /** One entry per card that left a column, with the column it belongs to. */
  interface FloatingEntry {
    panel: FloatingPanel;
    pane: PaneDefinition;
    layout: PanelLayout;
    docked: string[];
    midpoints: () => number[];
  }
  function floatingOf(
    layout: PanelLayout,
    known: Map<string, PaneDefinition>,
    docked: string[],
    midpoints: () => number[],
  ): FloatingEntry[] {
    return layout.floating
      .map((panel) => ({ panel, pane: known.get(panel.id), layout, docked, midpoints }))
      .filter((entry): entry is FloatingEntry => entry.pane !== undefined);
  }
  const floatingPanes = $derived([
    ...floatingOf(leftLayout, leftById, leftDockedIds, () => leftColumn?.midpoints() ?? []),
    ...floatingOf(rightLayout, rightById, rightDockedIds, () => rightColumn?.midpoints() ?? []),
  ]);

  // Where the docked cards are: the right column a floating card docks back into, and
  // every other one it must not cover. Re-read on every resize, since the footer's height
  // and the rail's modes move them.
  let shell = $state<HTMLElement | null>(null);
  $effect(() => {
    const root = shell;
    if (!root) return;
    const report = (): void => {
      const box = (element: Element): Rect => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      const columnOf = (side: string): Rect | null => {
        const element = root.querySelector(`[data-floating="${side}"]`);
        return element ? box(element) : null;
      };
      // Everything docked is a neighbour a floating card snaps to and may not cover: the
      // other column, the rail, the footer.
      const docks = [...root.querySelectorAll("[data-floating]")].map(box);
      // A card restored from a layout saved on a bigger screen, or left hanging by a
      // resize, is settled back inside the window here.
      const measured = [...root.querySelectorAll("[data-pane-card][data-floating-panel='true']")]
        .map((card) => ({
          id: card.getAttribute("data-pane-card") ?? "",
          height: card.getBoundingClientRect().height,
        }))
        .filter((entry) => entry.id !== "");
      for (const [side, layout] of [
        ["left", leftLayout],
        ["right", rightLayout],
      ] as const) {
        layout.setColumnRect(columnOf(side));
        layout.setDockRects(docks);
        layout.reflow(measured);
      }
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(root);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  });
  const safeArea = $derived(
    viewerSafeArea(chrome, left.length > 0, footerHeight, flyout !== undefined),
  );

  // Published on the pane registry rather than pushed at the viewer: the shell knows the
  // layout, the viewer knows what to do with it, and the two never have to exist at the
  // same moment for the hand-over to work.
  $effect(() => {
    ctx.panes.setSafeArea(safeArea);
  });

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

<!-- The viewer is the window: the frame fills it edge to edge and every pane floats on
     top as a card. Zoomed in, the picture runs on behind them, which is the point. The
     pane layer is a grid so the cards keep their tracks, and it lets pointer events
     through everywhere it has no card — a wheel over the gap still zooms. -->
<div
  bind:this={shell}
  class="relative h-full bg-canvas text-default"
  style:--viewer-safe-left="{safeArea.left}px"
  style:--viewer-safe-right="{safeArea.right}px"
  data-chrome={chrome}
  data-mode={mode}
>
  <main class="absolute inset-0">
    {#each center as pane (pane.id)}
      {@const Pane = pane.component}
      <Pane paneId={pane.id} />
    {/each}
  </main>

  <div
    class="pointer-events-none absolute inset-0 grid grid-rows-[1fr_auto] gap-2 p-2"
    style:grid-template-columns={columns(showsLeft, showsRight)}
  >
    {#if showsLeft}
      <PanelColumn
        bind:this={leftColumn}
        side="left"
        panes={leftDocked}
        layout={leftLayout}
        {mode}
      />
    {/if}

    <!-- The centre track is the hole the picture shows through: no card, no hit area. -->
    <div></div>

    {#if showsRight}
      <!-- Lightroom's right rail, on the inner edge of the column it switches: one icon per
           mode, and the mode decides which panes the column beside it shows. Under them, the
           rail panes: those open beside the rail instead of switching the column. -->
      <div class="pointer-events-none relative self-start">
        <nav
          class="pointer-events-auto flex min-h-0 flex-col items-center gap-1 rounded-lg
                 border border-line bg-elevated py-2 shadow-lg"
          aria-label="Modes"
          data-floating="rail"
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
          {#if railPanes.length > 0}
            <span class="my-1 h-px w-5 bg-line"></span>
          {/if}
          {#each railPanes as pane (pane.id)}
            {@const Icon = railIcons[pane.id] ?? SquaresFourIcon}
            {@const open = flyout?.id === pane.id}
            <span data-rail-pane={pane.id} data-open={open}>
              <Tooltip text={pane.title} placement="left">
                <Button
                  size="sm"
                  variant={open ? "surface" : "ghost"}
                  icon={Icon}
                  onclick={() => ctx.panes.setRailPane(open ? null : pane.id)}
                />
              </Tooltip>
            </span>
          {/each}
        </nav>

        <!-- The open rail pane, hung off the rail's left edge over the viewer. It is not a
             menu: nothing outside it closes it, because the whole point is to keep a mask
             selected while its sliders are moved in the Edit column. -->
        {#if flyout}
          {@const Flyout = flyout.component}
          {@const Actions = flyout.headerActions}
          <aside
            class="pointer-events-auto absolute top-0 right-full mr-2 flex max-h-[80vh] flex-col
                   overflow-hidden rounded-lg border border-line bg-elevated shadow-lg"
            style:width="{PANE_LAYOUT.flyout}px"
            data-floating="flyout"
            data-rail-flyout={flyout.id}
          >
            <div class="flex items-center gap-1 border-b border-line-faint px-3 py-1.5">
              <span class="min-w-0 flex-1 truncate text-xs font-semibold text-default">
                {flyout.title}
              </span>
              {#if Actions}
                <Actions paneId={flyout.id} />
              {/if}
              <Tooltip text="Close {flyout.title}" placement="left">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={XIcon}
                  onclick={() => ctx.panes.setRailPane(null)}
                />
              </Tooltip>
            </div>
            <FloatingScrollbar class="min-h-0 flex-1" axis="vertical">
              <Flyout paneId={flyout.id} />
            </FloatingScrollbar>
          </aside>
        {/if}
      </div>
      <PanelColumn
        bind:this={rightColumn}
        side="right"
        panes={rightDocked}
        layout={rightLayout}
        {mode}
      />
    {/if}

    <!-- Bottom panes stack in `order`: the filmstrip, then the status line. -->
    <!-- Cards dragged out of the column. Loose over the viewer, snapped to each other and
         to the column, and put back by dropping them on it or by the pin. -->
    {#each floatingPanes as entry (entry.panel.id)}
      <div
        class="pointer-events-auto fixed z-overlay"
        style:left="{entry.panel.x}px"
        style:top="{entry.panel.y}px"
        style:width="{entry.panel.width}px"
      >
        <PanelCard
          pane={entry.pane}
          layout={entry.layout}
          floating
          inactive={entry.pane.mode !== undefined && entry.pane.mode !== mode}
          docked={entry.docked}
          midpoints={entry.midpoints}
        />
      </div>
    {/each}

    {#if showsBottom}
      <footer
        bind:clientHeight={footerHeight}
        class="pointer-events-auto col-span-full flex max-h-[45vh] flex-col overflow-hidden
               rounded-lg border border-line bg-elevated shadow-lg"
        data-floating="bottom"
      >
        <FloatingScrollbar class="min-h-0 flex-1" axis="both">
          {#each bottom as pane (pane.id)}
            {@const Pane = pane.component}
            <Pane paneId={pane.id} />
          {/each}
        </FloatingScrollbar>
      </footer>
    {/if}
  </div>
</div>
