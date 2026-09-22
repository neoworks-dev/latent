// The catalog: a filmstrip at the bottom under its own filter bar, the library inside the
// grid, and a job status line in the footer. Rows, ratings, flags and thumbnails all belong to the engine —
// this plugin lists, selects and asks; it never stores an edit.
import type { MergeKind } from "@latent/protocol";
import type { Context, Plugin } from "@neoworks/extension-system";
import { catalogShortcut } from "./catalog";
import Filmstrip from "./Filmstrip.svelte";
import Grid from "./Grid.svelte";
import Info from "./Info.svelte";
import JobStatus from "./JobStatus.svelte";
import StripFilter from "./StripFilter.svelte";
import { CatalogState } from "./state.svelte";

declare module "@neoworks/extension-system" {
  interface Context {
    catalog: CatalogState;
  }

  interface Events {
    /**
     * The library asked for these photos to be merged. Declared and emitted here, handled
     * by whoever owns Photo Merge: an event keeps the dependency edge catalog ← merge, so
     * the catalog never imports the plugin that draws the dialog. With no handler loaded
     * the control is inert, the same way Lightroom's menu item is when nothing can run it.
     */
    "catalog/merge"(kind: MergeKind, photoIds: number[]): void;
  }
}

// The shape behind `ctx.catalog`, for a plugin that injects it and holds a reference.
export type { CatalogState };

export const catalogPlugin: Plugin.Object<void> = {
  name: "catalog",
  inject: ["engine", "panes", "viewer"],
  apply(ctx: Context) {
    const state = new CatalogState(ctx.engine, ctx.viewer);
    ctx.provide("catalog", state);
    ctx.effect(() => () => state.dispose());

    // The library is not a pane of its own any more: it is drawn inside the grid, where
    // choosing which photos you are looking at belongs. The left column is the open
    // photo's — navigator, presets, history.
    // The grid covers the viewer's canvas while it is open; it draws nothing otherwise,
    // so the centre region keeps one pane per feature instead of a mode switch.
    ctx.effect(() =>
      ctx.panes.register({
        id: "grid",
        title: "Grid",
        region: "center",
        order: 10,
        component: Grid,
      }),
    );
    ctx.effect(() =>
      ctx.panes.register({
        id: "info",
        title: "Info",
        region: "right",
        // Folded into the Edit column rather than a rail mode of its own: it is a readout
        // of the open photo, not a tool, and a whole tab for one card is a tab too many.
        order: 5,
        mode: "edit",
        component: Info,
      }),
    );
    // Above the strip: search, the quick filters and the sort, so the page can be narrowed
    // without opening the grid.
    ctx.effect(() =>
      ctx.panes.register({
        id: "strip-filter",
        title: "Filter",
        region: "bottom",
        order: 5,
        component: StripFilter,
      }),
    );
    ctx.effect(() =>
      ctx.panes.register({
        id: "filmstrip",
        title: "Filmstrip",
        region: "bottom",
        order: 10,
        component: Filmstrip,
      }),
    );
    ctx.effect(() =>
      ctx.panes.register({
        id: "job-status",
        title: "Jobs",
        region: "bottom",
        order: 100,
        component: JobStatus,
      }),
    );

    // Library keys. One raw listener, registered with its inverse; the mapping itself is
    // pure and ignores keystrokes aimed at a text field (the console has one).
    ctx.effect(() => {
      const onKeyDown = (event: KeyboardEvent): void => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const action = catalogShortcut({
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          target,
        });
        if (!action) return;
        event.preventDefault();
        if (action.kind === "move") state.move(action.delta);
        if (action.kind === "edge") state.moveToEdge(action.edge);
        if (action.kind === "rating") void state.setRating(action.rating);
        if (action.kind === "flag") void state.setFlag(action.flag);
        if (action.kind === "grid") state.toggleGrid();
        // Enter is the grid's "open this one": it hands the centre region back to the
        // viewer. Outside the grid there is nothing to open — the photo is already open.
        if (action.kind === "open" && state.gridVisible) void state.openSelected();
        // Delete takes the rows out of the catalog. No confirmation: a catalog row is a
        // database row, the raw file on disk is untouched, and re-importing brings it back.
        if (action.kind === "remove") void state.removeSelection();
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, "catalog-shortcuts");

    // First listing, once the socket is up. The inverse cancels a load still in flight so
    // an unloaded plugin cannot write into its own disposed state.
    ctx.effect(() => {
      let cancelled = false;
      void (async () => {
        await ctx.engine.whenOpen();
        if (cancelled) return;
        await state.reload();
        // Dev hook, the sibling of the viewer's `?photo=`: `?import=<dir>[,<dir>]` imports
        // those paths on boot without the native dialog. Non-recursive on purpose — a deep
        // home directory would take minutes to walk.
        const paths = new URLSearchParams(location.search).get("import");
        if (cancelled || !paths) return;
        await state.importPaths(paths.split(",").filter(Boolean), false);
      })();
      return () => {
        cancelled = true;
      };
    }, "catalog-initial-load");
  },
};
