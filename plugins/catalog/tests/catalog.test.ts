import { describe, expect, test } from "bun:test";
import type { CatalogPhoto, JobProgressParams } from "@latent/protocol";
import {
  catalogShortcut,
  clampGridSize,
  filterLabel,
  folderRows,
  folderTree,
  cellAspect,
  gridGap,
  gridHeaderHeight,
  gridSections,
  gridWindow,
  infoRows,
  justifyRows,
  isSortKey,
  isTypingTarget,
  jobGroups,
  missingThumbnails,
  movedSelection,
  nextSelection,
  sortOptions,
  stripCellWidth,
  stripGap,
  stripWindow,
  thumbnailKey,
  type CatalogKeyEvent,
} from "../src/catalog";

function key(key: string, overrides: Partial<CatalogKeyEvent> = {}): CatalogKeyEvent {
  return { key, ctrlKey: false, metaKey: false, altKey: false, target: null, ...overrides };
}

describe("folder tree", () => {
  test("shared prefixes become one row with the counts rolled up", () => {
    const tree = folderTree([
      { path: "/home/me/Pictures/trip", count: 2, watched: true },
      { path: "/home/me/Pictures/city", count: 1, watched: true },
    ]);
    expect(tree).toEqual([
      { path: "/home/me/Pictures", label: "home/me/Pictures", depth: 0, count: 3, watched: true },
      { path: "/home/me/Pictures/city", label: "city", depth: 1, count: 1, watched: true },
      { path: "/home/me/Pictures/trip", label: "trip", depth: 1, count: 2, watched: true },
    ]);
  });

  test("a chain that holds photos of its own does not collapse into its child", () => {
    const tree = folderTree([
      { path: "/photos", count: 1, watched: false },
      { path: "/photos/raw", count: 4, watched: false },
    ]);
    expect(tree).toEqual([
      { path: "/photos", label: "photos", depth: 0, count: 5, watched: false },
      { path: "/photos/raw", label: "raw", depth: 1, count: 4, watched: false },
    ]);
  });

  test("separate roots stay separate and no folders is no rows", () => {
    const tree = folderTree([
      { path: "/mnt/card", count: 1, watched: false },
      { path: "/home/me/pics", count: 1, watched: true },
    ]);
    expect(tree.map((node) => node.label)).toEqual(["home/me/pics", "mnt/card"]);
    expect(folderTree([])).toEqual([]);
  });

  test("a parent is watched only when everything under it is", () => {
    const tree = folderTree([
      { path: "/photos/trip", count: 2, watched: true },
      { path: "/photos/old", count: 1, watched: false },
    ]);
    expect(tree.map((node) => [node.label, node.watched])).toEqual([
      ["photos", false],
      ["old", false],
      ["trip", true],
    ]);
  });
});

describe("filter label", () => {
  test("names whatever narrows the list", () => {
    expect(filterLabel({})).toBe("All photos");
    expect(filterLabel({ folder: "/home/me/Pictures/trip" })).toBe("trip");
    expect(filterLabel({ flag: "pick" })).toBe("Picks");
    expect(filterLabel({ minRating: 3 })).toBe("3★ and up");
    expect(filterLabel({ collectionId: 2 }, "Keepers")).toBe("Keepers");
  });

  test("a search says what was searched for, an empty one does not", () => {
    expect(filterLabel({ query: "dscf" })).toBe("“dscf”");
    expect(filterLabel({ folder: "/photos/trip", query: "raf" })).toBe("“raf”");
    expect(filterLabel({ query: "" })).toBe("All photos");
  });
});

describe("thumbnail batching", () => {
  function target(photoId: number, hash?: string): { photoId: number; hash?: string } {
    return hash === undefined ? { photoId } : { photoId, hash };
  }

  test("the cache key is the file when the engine has hashed it, the row until then", () => {
    expect(thumbnailKey({ photoId: 7, hash: "a".repeat(64) })).toBe(`hash:${"a".repeat(64)}`);
    expect(thumbnailKey({ photoId: 7 })).toBe("photo:7");
    // A re-import is a new row of the same file: same key, so the JPEG is not fetched twice.
    expect(thumbnailKey({ photoId: 9, hash: "a".repeat(64) })).toBe(
      thumbnailKey({ photoId: 7, hash: "a".repeat(64) }),
    );
  });

  test("only photos the UI has neither got nor asked for go into the batch", () => {
    const page = [target(1), target(2), target(3), target(4)];
    expect(missingThumbnails(page, ["photo:2", "photo:4"])).toEqual([target(1), target(3)]);
    expect(missingThumbnails(page.slice(0, 2), ["photo:1", "photo:2"])).toEqual([]);
    expect(missingThumbnails([], ["photo:1"])).toEqual([]);
  });

  test("a photo listed twice on a page is asked for once", () => {
    expect(missingThumbnails([target(5), target(5), target(6)], [])).toEqual([
      target(5),
      target(6),
    ]);
  });

  test("a re-imported file is not fetched again, whatever its new row id is", () => {
    const hash = "b".repeat(64);
    expect(missingThumbnails([target(12, hash)], [`hash:${hash}`])).toEqual([]);
    // Two rows of one file on the same page are one request, not two.
    expect(missingThumbnails([target(12, hash), target(13, hash)], [])).toEqual([target(12, hash)]);
  });
});

describe("job groups", () => {
  function job(overrides: Partial<JobProgressParams> & { jobId: number }): JobProgressParams {
    return { kind: "import", done: 0, total: 0, finished: false, ...overrides };
  }

  const importing = job({ jobId: 1, kind: "import", done: 4, total: 12, state: "running" });
  const imported = job({
    jobId: 1,
    kind: "import",
    done: 12,
    total: 12,
    finished: true,
    state: "done",
    message: "imported 12 photos",
  });
  const thumbnails = job({
    jobId: 2,
    parentJobId: 1,
    kind: "thumbnails",
    done: 7,
    total: 12,
    state: "running",
  });

  test("an import alone is one badge with its counts", () => {
    expect(jobGroups([importing])).toEqual([
      { jobId: 1, label: "import 4/12", state: "running", cancelJobId: 1 },
    ]);
    expect(jobGroups([])).toEqual([]);
  });

  test("the thumbnail job nests under the import that queued it", () => {
    expect(jobGroups([imported, thumbnails])).toEqual([
      {
        jobId: 1,
        label: "imported 12 photos · thumbnails 7/12",
        state: "running",
        // The import is done, so Cancel now stops the thumbnails.
        cancelJobId: 2,
      },
    ]);
  });

  test("both finished collapses to one line", () => {
    const done = { ...thumbnails, done: 12, finished: true, state: "done" as const };
    expect(jobGroups([imported, { ...done, message: "12 thumbnails" }])).toEqual([
      {
        jobId: 1,
        label: "imported 12 photos · 12 thumbnails",
        state: "done",
        cancelJobId: null,
      },
    ]);
  });

  test("a cancelled import says so, and only once nothing in it still runs", () => {
    const cancelled = {
      ...imported,
      state: "cancelled" as const,
      message: "import cancelled after 4 of 12 photos",
    };
    expect(jobGroups([cancelled, thumbnails])[0]?.state).toBe("running");
    const stopped = {
      ...thumbnails,
      done: 0,
      total: 0,
      finished: true,
      state: "cancelled" as const,
    };
    expect(jobGroups([cancelled, stopped])).toEqual([
      {
        jobId: 1,
        label: "import cancelled after 4 of 12 photos · thumbnails cancelled",
        state: "cancelled",
        cancelJobId: null,
      },
    ]);
    // An error anywhere in the group outranks a plain finish.
    const failed = { ...stopped, state: "error" as const, message: undefined };
    expect(jobGroups([imported, failed])[0]?.state).toBe("error");
  });

  test("a job nobody spawned, and a child whose parent is gone, are badges of their own", () => {
    const exporting = job({ jobId: 9, kind: "export", done: 1, total: 3 });
    expect(jobGroups([exporting, thumbnails]).map((group) => group.jobId)).toEqual([9, 2]);
    expect(jobGroups([thumbnails])[0]?.label).toBe("thumbnails 7/12");
  });

  test("a job from an engine that omits `state` still reads running, then done", () => {
    const old = job({ jobId: 5, done: 2, total: 5 });
    expect(jobGroups([old])[0]?.state).toBe("running");
    expect(jobGroups([{ ...old, done: 5, finished: true }])[0]).toEqual({
      jobId: 5,
      label: "import done",
      state: "done",
      cancelJobId: null,
    });
  });
});

describe("library shortcuts", () => {
  test("arrows move, digits rate, P/X/U flag", () => {
    expect(catalogShortcut(key("ArrowRight"))).toEqual({ kind: "move", delta: 1 });
    expect(catalogShortcut(key("ArrowUp"))).toEqual({ kind: "move", delta: -1 });
    expect(catalogShortcut(key("3"))).toEqual({ kind: "rating", rating: 3 });
    expect(catalogShortcut(key("0"))).toEqual({ kind: "rating", rating: 0 });
    expect(catalogShortcut(key("p"))).toEqual({ kind: "flag", flag: "pick" });
    expect(catalogShortcut(key("X"))).toEqual({ kind: "flag", flag: "reject" });
    expect(catalogShortcut(key("u"))).toEqual({ kind: "flag", flag: "none" });
  });

  test("Delete removes the selection from the catalog, Backspace does not", () => {
    expect(catalogShortcut(key("Delete"))).toEqual({ kind: "remove" });
    expect(catalogShortcut(key("Backspace"))).toBe(null);
    expect(catalogShortcut(key("Delete", { ctrlKey: true }))).toBe(null);
    expect(
      catalogShortcut(key("Delete", { target: { tagName: "INPUT", isContentEditable: false } })),
    ).toBe(null);
  });

  test("modified keystrokes and unknown keys belong to someone else", () => {
    expect(catalogShortcut(key("z", { ctrlKey: true }))).toBe(null);
    expect(catalogShortcut(key("p", { metaKey: true }))).toBe(null);
    expect(catalogShortcut(key("6"))).toBe(null);
    expect(catalogShortcut(key("Escape"))).toBe(null);
  });

  test("Home/End jump to the ends of the page, G grids, Enter opens", () => {
    expect(catalogShortcut(key("Home"))).toEqual({ kind: "edge", edge: "first" });
    expect(catalogShortcut(key("End"))).toEqual({ kind: "edge", edge: "last" });
    expect(catalogShortcut(key("g"))).toEqual({ kind: "grid" });
    expect(catalogShortcut(key("G"))).toEqual({ kind: "grid" });
    expect(catalogShortcut(key("Enter"))).toEqual({ kind: "open" });
    // Still not while a text field has focus: Enter there commits the field.
    expect(
      catalogShortcut(key("Enter", { target: { tagName: "INPUT", isContentEditable: false } })),
    ).toBe(null);
  });

  test("a keystroke aimed at a text field is never a library shortcut", () => {
    const textarea = { tagName: "TEXTAREA", isContentEditable: false };
    expect(catalogShortcut(key("3", { target: textarea }))).toBe(null);
    expect(catalogShortcut(key("ArrowRight", { target: textarea }))).toBe(null);
    expect(isTypingTarget({ tagName: "INPUT", isContentEditable: false })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON", isContentEditable: false })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("selection", () => {
  const visible = [1, 2, 3, 4, 5];

  test("a plain click replaces the selection", () => {
    expect(nextSelection(visible, [1, 2], 1, 4, { shift: false, ctrl: false })).toEqual([4]);
  });

  test("ctrl toggles one photo in and out", () => {
    expect(nextSelection(visible, [1], 1, 3, { shift: false, ctrl: true })).toEqual([1, 3]);
    expect(nextSelection(visible, [1, 3], 1, 3, { shift: false, ctrl: true })).toEqual([1]);
  });

  test("shift takes the run from the anchor, in either direction", () => {
    expect(nextSelection(visible, [2], 2, 4, { shift: true, ctrl: false })).toEqual([2, 3, 4]);
    expect(nextSelection(visible, [4], 4, 2, { shift: true, ctrl: false })).toEqual([2, 3, 4]);
    expect(nextSelection(visible, [], null, 3, { shift: true, ctrl: false })).toEqual([3]);
  });

  test("arrows step within the page and stop at its ends", () => {
    expect(movedSelection(visible, [2], 1)).toBe(3);
    expect(movedSelection(visible, [5], 1)).toBe(5);
    expect(movedSelection(visible, [1], -1)).toBe(1);
    expect(movedSelection(visible, [], 1)).toBe(1);
    // A selection from a previous page falls back to the first visible photo.
    expect(movedSelection(visible, [99], 1)).toBe(1);
    expect(movedSelection([], [1], 1)).toBe(null);
  });
});

describe("folder rows", () => {
  const tree = folderTree([
    { path: "/photos/trip/day1", count: 2, watched: true },
    { path: "/photos/city", count: 1, watched: true },
  ]);

  test("a row with deeper rows under it gets a chevron, a leaf does not", () => {
    const rows = folderRows(tree, []);
    expect(rows.map((row) => [row.node.label, row.hasChildren, row.expanded])).toEqual([
      ["photos", true, true],
      ["city", false, false],
      ["trip/day1", false, false],
    ]);
  });

  test("a collapsed row hides everything under it and nothing beside it", () => {
    const rows = folderRows(tree, ["/photos"]);
    expect(rows.map((row) => row.node.label)).toEqual(["photos"]);
    expect(rows[0]?.expanded).toBe(false);
    expect(folderRows(tree, ["/photos/city"]).map((row) => row.node.label)).toEqual([
      "photos",
      "city",
      "trip/day1",
    ]);
  });
});

describe("sort menu", () => {
  test("every option is a sort key catalog.list accepts", () => {
    expect(sortOptions.map((option) => option.value)).toEqual([
      "capturedAt",
      "importedAt",
      "editedAt",
      "filename",
      "rating",
    ]);
    expect(isSortKey("filename")).toBe(true);
    expect(isSortKey("camera")).toBe(false);
  });
});

describe("grid sizing", () => {
  function sized(
    photoId: number,
    width: number,
    height: number,
    capturedAt?: string,
  ): CatalogPhoto {
    return {
      photoId,
      path: `/photos/${photoId}.RAF`,
      folder: "/photos",
      filename: `${photoId}.RAF`,
      width,
      height,
      camera: "X-T5",
      capturedAt,
      importedAt: "2026-01-01T00:00:00Z",
      rating: 0,
      flag: "none",
      hasSidecar: false,
    };
  }

  function fullDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, { dateStyle: "full" });
  }

  function rowWidth(cells: { width: number }[]): number {
    return cells.reduce((sum, cell) => sum + cell.width, 0) + gridGap * (cells.length - 1);
  }

  test("the slider is clamped to its range", () => {
    expect(clampGridSize(160)).toBe(160);
    expect(clampGridSize(40)).toBe(96);
    expect(clampGridSize(9000)).toBe(320);
    expect(clampGridSize(Number.NaN)).toBe(96);
  });

  test("a cell's aspect is the photo's, clamped both ways", () => {
    expect(cellAspect(sized(1, 6000, 4000))).toBe(1.5);
    expect(cellAspect(sized(2, 4000, 6000))).toBeCloseTo(2 / 3, 5);
    expect(cellAspect(sized(3, 12000, 1000))).toBe(3);
    expect(cellAspect(sized(4, 1000, 12000))).toBeCloseTo(1 / 3, 5);
    expect(cellAspect(sized(5, 0, 0))).toBe(1);
  });

  test("full rows end flush with the pane and keep each photo's aspect", () => {
    const photos = Array.from({ length: 9 }, (_unused, index) => sized(index, 3000, 2000));
    const rows = justifyRows(photos, 1000, 160);

    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(0, -1)) {
      expect(rowWidth(row.cells)).toBe(1000);
      for (const cell of row.cells) expect(cell.width / row.height).toBeCloseTo(1.5, 1);
    }
    expect(rows.flatMap((row) => row.cells.map((cell) => cell.photo.photoId))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  test("a mixed row shares one height, so widths differ by aspect", () => {
    const rows = justifyRows(
      [sized(1, 3000, 2000), sized(2, 2000, 3000), sized(3, 4000, 3000), sized(4, 3000, 3000)],
      600,
      200,
    );

    const [first] = rows;
    expect(rowWidth(first.cells)).toBe(600);
    expect(first.cells[0].width).toBeGreaterThan(first.cells[1].width);
  });

  test("a trailing part-row stays at the target height instead of stretching", () => {
    const rows = justifyRows([sized(1, 3000, 2000)], 2000, 160);

    expect(rows).toHaveLength(1);
    expect(rows[0].height).toBe(160);
    expect(rows[0].cells[0].width).toBe(240);
  });

  test("an unmeasured pane lays out nothing", () => {
    expect(justifyRows([sized(1, 3000, 2000)], 0, 160)).toEqual([]);
  });

  test("consecutive photos from one day become one titled section", () => {
    const sections = gridSections(
      [
        sized(1, 3000, 2000, "2026-04-11T09:00:00Z"),
        sized(2, 3000, 2000, "2026-04-11T18:00:00Z"),
        sized(3, 3000, 2000, "2026-04-12T09:00:00Z"),
      ],
      1000,
      160,
    );

    expect(sections.map((entry) => [entry.title, entry.count])).toEqual([
      [fullDate("2026-04-11T09:00:00Z"), 2],
      [fullDate("2026-04-12T09:00:00Z"), 1],
    ]);
    expect(sections.map((entry) => entry.key)).toEqual([1, 3]);
  });

  test("a row never straddles two dates", () => {
    const sections = gridSections(
      [sized(1, 3000, 2000, "2026-04-11T09:00:00Z"), sized(2, 3000, 2000, "2026-04-12T09:00:00Z")],
      4000,
      160,
    );

    expect(sections).toHaveLength(2);
    for (const entry of sections) {
      expect(entry.rows.flatMap((row) => row.cells)).toHaveLength(1);
    }
  });

  test("a date that comes back under another sort opens a second section", () => {
    const sections = gridSections(
      [
        sized(1, 3000, 2000, "2026-04-11T09:00:00Z"),
        sized(2, 3000, 2000, "2026-04-12T09:00:00Z"),
        sized(3, 3000, 2000, "2026-04-11T10:00:00Z"),
      ],
      1000,
      160,
    );

    expect(sections.map((entry) => entry.key)).toEqual([1, 2, 3]);
    expect(sections[0].title).toBe(sections[2].title);
  });

  test("photos the EXIF has no capture time for get their own title", () => {
    const sections = gridSections(
      [sized(1, 3000, 2000), sized(2, 3000, 2000, "not a date")],
      1000,
      160,
    );

    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe("No capture date");
    expect(sections[0].count).toBe(2);
  });
});

describe("grid scrolling", () => {
  function day(photoId: number, capturedAt: string): CatalogPhoto {
    return {
      photoId,
      path: `/photos/${photoId}.RAF`,
      folder: "/photos",
      filename: `${photoId}.RAF`,
      width: 3000,
      height: 2000,
      camera: "X-T5",
      capturedAt,
      importedAt: "2026-01-01T00:00:00Z",
      rating: 0,
      flag: "none",
      hasSidecar: false,
    };
  }

  /** Two days of 12 photos each, five to a row at this width and target height. */
  function twoDays(): CatalogPhoto[] {
    return [
      ...Array.from({ length: 12 }, (_unused, index) => day(index + 1, "2026-04-11T09:00:00Z")),
      ...Array.from({ length: 12 }, (_unused, index) => day(index + 13, "2026-04-12T09:00:00Z")),
    ];
  }

  test("rows stack under their title, and a section under the one before it", () => {
    const [first, second] = gridSections(twoDays(), 1200, 160);

    expect(first.top).toBe(0);
    expect(first.rows[0].top).toBe(gridHeaderHeight + gridGap);
    expect(first.rows[1].top).toBe(first.rows[0].top + first.rows[0].height + gridGap);

    const last = first.rows[first.rows.length - 1];
    expect(first.height).toBe(last.top + last.height - first.top);
    expect(second.top).toBe(first.height);
    expect(second.rows[0].top).toBe(second.top + gridHeaderHeight + gridGap);
  });

  test("only the rows within a screen of the scrollport are drawn", () => {
    const sections = gridSections(twoDays(), 1200, 160);
    const total = sections.reduce((sum, entry) => sum + entry.rows.length, 0);
    const windowed = gridWindow(sections, 0, 200);

    // Every title survives: a title drawn only while its own rows are on screen could not
    // stick to the top of the scrollport.
    expect(windowed.map((entry) => entry.section.key)).toEqual(sections.map((entry) => entry.key));
    const drawn = windowed.reduce((sum, entry) => sum + entry.rows.length, 0);
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(total);
  });

  test("a scroll to the end draws the last row and not the first", () => {
    const sections = gridSections(twoDays(), 1200, 160);
    const bottom = sections[sections.length - 1];
    const windowed = gridWindow(sections, bottom.top + bottom.height, 200);
    const drawn = windowed.flatMap((entry) => entry.rows);

    expect(drawn).toContain(bottom.rows[bottom.rows.length - 1]);
    expect(drawn).not.toContain(sections[0].rows[0]);
  });

  test("an unmeasured pane draws no rows at all", () => {
    const sections = gridSections(twoDays(), 1200, 160);

    expect(gridWindow(sections, 0, 0).flatMap((entry) => entry.rows)).toEqual([]);
  });
});

describe("filmstrip scrolling", () => {
  const pitch = stripCellWidth + stripGap;

  test("an unscrolled strip draws the scrollport and a strip's width past it", () => {
    expect(stripWindow(500, 0, 10 * pitch)).toEqual({ start: 0, end: 20 });
  });

  test("scrolling moves the window and keeps a strip's width behind it", () => {
    expect(stripWindow(500, 40 * pitch, 10 * pitch)).toEqual({ start: 30, end: 60 });
  });

  test("the window never runs past either end of the catalog", () => {
    expect(stripWindow(12, 0, 10 * pitch)).toEqual({ start: 0, end: 12 });
    expect(stripWindow(500, 2 * pitch, 10 * pitch)).toEqual({ start: 0, end: 22 });
  });

  test("a strip nobody has measured yet draws nothing", () => {
    expect(stripWindow(500, 0, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("info rows", () => {
  const photo: CatalogPhoto = {
    photoId: 7,
    path: "/photos/trip/DSCF0101.RAF",
    folder: "/photos/trip",
    filename: "DSCF0101.RAF",
    width: 6024,
    height: 4024,
    camera: "Fujifilm X-T5",
    lens: "XF 35mm f/1.4",
    capturedAt: "2026-04-01T10:00:00.000Z",
    importedAt: "2026-04-02T10:00:00.000Z",
    rating: 3,
    flag: "pick",
    hasSidecar: false,
    iso: 400,
    shutter: "1/250",
    aperture: 2.8,
    focalLength: 35,
  };

  function value(label: string, row: CatalogPhoto): string | undefined {
    return infoRows(row).find((entry) => entry.label === label)?.value;
  }

  test("the exposure line is one row of what the EXIF had", () => {
    expect(value("Exposure", photo)).toBe("1/250 s · ƒ/2.8 · ISO 400 · 35 mm");
    expect(value("Camera", photo)).toBe("Fujifilm X-T5");
    expect(value("Size", photo)).toBe("6024 × 4024");
    expect(value("Rating", photo)).toBe("★★★");
    expect(value("Flag", photo)).toBe("Pick");
  });

  test("missing fields read as dashes, never as undefined", () => {
    const bare: CatalogPhoto = {
      ...photo,
      lens: undefined,
      capturedAt: undefined,
      editedAt: undefined,
      rating: 0,
      flag: "none",
      iso: undefined,
      shutter: undefined,
      aperture: undefined,
      focalLength: undefined,
    };
    expect(value("Lens", bare)).toBe("—");
    expect(value("Exposure", bare)).toBe("—");
    expect(value("Captured", bare)).toBe("—");
    expect(value("Edited", bare)).toBe("—");
    expect(value("Rating", bare)).toBe("—");
    expect(value("Flag", bare)).toBe("Unflagged");
  });

  test("the hash is shown short with the whole of it in the tooltip", () => {
    const hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const row = infoRows({ ...photo, hash }).find((entry) => entry.label === "Hash");
    expect(row).toEqual({ label: "Hash", value: "9f86d081884c", title: hash });
  });

  test("a row the engine has not hashed yet has no hash row at all", () => {
    expect(infoRows(photo).some((entry) => entry.label === "Hash")).toBe(false);
  });
});
