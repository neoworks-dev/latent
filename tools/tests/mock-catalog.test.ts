import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogPhoto } from "@latent/protocol";
import { FRAME_HEADER_BYTES } from "@latent/protocol";
import { isRawPath, MockCatalog, scanRawFiles, sortPhotos } from "../mock-catalog";

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "latent-catalog-"));
  mkdirSync(join(root, "trip"));
  writeFileSync(join(root, "a.ARW"), "");
  writeFileSync(join(root, "b.raf"), "");
  writeFileSync(join(root, "notes.txt"), "");
  writeFileSync(join(root, "trip", "c.nef"), "");
  return root;
}

describe("import scan", () => {
  test("raw extensions are matched case-insensitively, everything else is ignored", () => {
    expect(isRawPath("/x/DSC0001.ARW")).toBe(true);
    expect(isRawPath("/x/a.dng")).toBe(true);
    expect(isRawPath("/x/a.jpg")).toBe(false);
    expect(isRawPath("/x/arw")).toBe(false);
  });

  test("a directory walk finds raws, descends only when asked, and dedupes", () => {
    const root = tree();
    expect(scanRawFiles([root], true).map((path) => path.slice(root.length))).toEqual([
      "/a.ARW",
      "/b.raf",
      "/trip/c.nef",
    ]);
    expect(scanRawFiles([root], false).map((path) => path.slice(root.length))).toEqual([
      "/a.ARW",
      "/b.raf",
    ]);
    expect(scanRawFiles([root, join(root, "a.ARW")], false)).toHaveLength(2);
    expect(scanRawFiles(["/nonexistent-latent-path"], true)).toEqual([]);
  });
});

describe("catalog rows", () => {
  test("a path keeps its photoId, so photo.open and import agree", () => {
    const catalog = new MockCatalog();
    const first = catalog.ensurePhoto("/photos/a.arw");
    const again = catalog.ensurePhoto("/photos/a.arw");
    expect(again.photoId).toBe(first.photoId);
    expect(catalog.ensurePhoto("/photos/b.arw").photoId).not.toBe(first.photoId);
  });

  test("metadata is synthesised from the path, so two runs agree", () => {
    const camera = new MockCatalog().ensurePhoto("/photos/a.arw").camera;
    expect(new MockCatalog().ensurePhoto("/photos/a.arw").camera).toBe(camera);
  });

  test("folders are grouped with counts", () => {
    const catalog = new MockCatalog();
    catalog.ensurePhoto("/photos/trip/a.arw");
    catalog.ensurePhoto("/photos/trip/b.arw");
    catalog.ensurePhoto("/photos/city/c.arw");
    expect(catalog.folders().folders).toEqual([
      { path: "/photos/city", count: 1, watched: false },
      { path: "/photos/trip", count: 2, watched: false },
    ]);
  });

  test("only a real directory becomes a watched root", () => {
    const catalog = new MockCatalog();
    catalog.ensurePhoto(join(import.meta.dir, "a.arw"));
    catalog.watchFolder(join(import.meta.dir, "a.arw"), true);
    expect(catalog.folders().folders[0]?.watched).toBe(false);
    catalog.watchFolder(import.meta.dir, true);
    expect(catalog.folders().folders[0]?.watched).toBe(true);
  });
});

describe("list filters, sort and paging", () => {
  function seeded(): MockCatalog {
    const catalog = new MockCatalog();
    for (const name of ["a", "b", "c", "d"]) catalog.ensurePhoto(`/photos/trip/${name}.arw`);
    catalog.ensurePhoto("/photos/city/e.arw");
    return catalog;
  }

  test("folder, flag and rating narrow the result and total counts matches", () => {
    const catalog = seeded();
    expect(catalog.list({}).total).toBe(5);
    expect(catalog.list({ folder: "/photos/trip" }).total).toBe(4);

    catalog.setRating(1, 3);
    catalog.setRating(2, 5);
    catalog.setFlag(3, "reject");
    expect(catalog.list({ minRating: 3 }).total).toBe(2);
    expect(catalog.list({ minRating: 4 }).photos.map((photo) => photo.photoId)).toEqual([2]);
    expect(catalog.list({ flag: "reject" }).photos.map((photo) => photo.photoId)).toEqual([3]);
    expect(catalog.list({ flag: "none" }).total).toBe(4);
  });

  test("rating clamps to 0–5", () => {
    const catalog = seeded();
    expect(catalog.setRating(1, 9).rating).toBe(5);
    expect(catalog.setRating(1, -2).rating).toBe(0);
  });

  test("sort and descending apply before paging, total stays the match count", () => {
    const catalog = seeded();
    const page = catalog.list({ sort: "filename", limit: 2, offset: 1 });
    expect(page.photos.map((photo) => photo.filename)).toEqual(["b.arw", "c.arw"]);
    expect(page.total).toBe(5);

    const descending = catalog.list({ sort: "filename", descending: true, limit: 2 });
    expect(descending.photos.map((photo) => photo.filename)).toEqual(["e.arw", "d.arw"]);
  });

  test("rows missing the sort key sort last in ascending order", () => {
    const rows = [
      { filename: "b", editedAt: "2026-01-02" },
      { filename: "a" },
      { filename: "c", editedAt: "2026-01-01" },
    ] as CatalogPhoto[];
    expect(sortPhotos(rows, "editedAt", false).map((row) => row.filename)).toEqual(["c", "b", "a"]);
  });

  test("equal sort keys break the tie by filename, then by photoId", () => {
    const rows = [
      { photoId: 9, filename: "b", rating: 3 },
      { photoId: 4, filename: "a", rating: 3 },
      { photoId: 2, filename: "a", rating: 3 },
    ] as CatalogPhoto[];
    // Both tie-breakers stay ascending whatever `descending` does to the primary key.
    expect(sortPhotos(rows, "rating", false).map((row) => row.photoId)).toEqual([2, 4, 9]);
    expect(sortPhotos(rows, "rating", true).map((row) => row.photoId)).toEqual([2, 4, 9]);
  });

  test("photoIds picks exactly those rows and keeps the list's order", () => {
    const catalog = seeded();
    const listed = catalog.list({ photoIds: [4, 1], sort: "filename" });
    expect(listed.photos.map((photo) => photo.filename)).toEqual(["a.arw", "d.arw"]);
    expect(listed.total).toBe(2);
    // An id that is not in the catalog is left out, not an error.
    expect(catalog.list({ photoIds: [1, 99] }).total).toBe(1);
    expect(catalog.list({ photoIds: [] }).total).toBe(0);
  });

  test("query matches filename or camera, case-insensitively, and AND-s with a folder", () => {
    const catalog = seeded();
    const camera = catalog.photo(1).camera;
    expect(catalog.list({ query: "C.ARW" }).photos.map((photo) => photo.filename)).toEqual([
      "c.arw",
    ]);
    expect(catalog.list({ query: camera.toLowerCase() }).total).toBeGreaterThan(0);
    expect(catalog.list({ query: "" }).total).toBe(5);
    expect(catalog.list({ query: "nothing-matches-this" }).total).toBe(0);
    expect(catalog.list({ folder: "/photos/city", query: "a.arw" }).total).toBe(0);
  });

  test("remove drops the row and its collection membership, never the file", () => {
    const catalog = seeded();
    catalog.collectionSet({ name: "Keepers" });
    catalog.collectionSet({ collectionId: 1, add: [1, 2] });

    expect(catalog.remove([1, 99])).toBe(1);
    expect(catalog.has(1)).toBe(false);
    expect(catalog.list({}).total).toBe(4);
    expect(catalog.collections().collections[0]?.count).toBe(1);

    // Re-importing the same path is a new row: the file was never touched.
    const reimported = catalog.ensurePhoto("/photos/trip/a.arw");
    expect(reimported.photoId).not.toBe(1);
    expect(catalog.remove([])).toBe(0);
  });

  test("an unknown photo or collection is an error, not an empty answer", () => {
    const catalog = seeded();
    expect(() => catalog.photo(99)).toThrow("unknown photoId 99");
    expect(() => catalog.list({ collectionId: 7 })).toThrow("unknown collectionId 7");
  });
});

describe("collections", () => {
  test("create, add, rename, filter by and delete", () => {
    const catalog = new MockCatalog();
    catalog.ensurePhoto("/photos/a.arw");
    catalog.ensurePhoto("/photos/b.arw");

    const created = catalog.collectionSet({ name: "Keepers" }).collections;
    expect(created).toEqual([{ collectionId: 1, name: "Keepers", count: 0 }]);

    catalog.collectionSet({ collectionId: 1, add: [1, 2] });
    expect(catalog.list({ collectionId: 1 }).total).toBe(2);

    catalog.collectionSet({ collectionId: 1, remove: [2] });
    expect(catalog.list({ collectionId: 1 }).photos.map((photo) => photo.photoId)).toEqual([1]);

    const renamed = catalog.collectionSet({ collectionId: 1, name: "Best" }).collections;
    expect(renamed[0]).toEqual({ collectionId: 1, name: "Best", count: 1 });

    expect(catalog.collectionSet({ collectionId: 1, delete: true }).collections).toEqual([]);
  });

  test("adding a photo that is not in the catalog is refused", () => {
    const catalog = new MockCatalog();
    catalog.collectionSet({ name: "Keepers" });
    expect(() => catalog.collectionSet({ collectionId: 1, add: [42] })).toThrow("unknown photoId");
  });
});

describe("thumbnails", () => {
  test("an LTHM frame carries the photoId, jpeg format and decodable jpeg bytes", () => {
    const catalog = new MockCatalog();
    const photo = catalog.ensurePhoto("/photos/a.arw");
    const { frame, width, height } = catalog.thumbnailFrame(photo.photoId, 256);

    const header = new DataView(frame);
    const magic = String.fromCharCode(
      header.getUint8(0),
      header.getUint8(1),
      header.getUint8(2),
      header.getUint8(3),
    );
    expect(magic).toBe("LTHM");
    expect(header.getUint32(4, true)).toBe(width);
    expect(header.getUint32(8, true)).toBe(height);
    expect(header.getUint32(16, true)).toBe(photo.photoId);
    expect(header.getUint32(20, true)).toBe(1);

    const jpeg = new Uint8Array(frame, FRAME_HEADER_BYTES);
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    expect([jpeg.at(-2), jpeg.at(-1)]).toEqual([0xff, 0xd9]);
  });

  test("two photos get different pictures", () => {
    const catalog = new MockCatalog();
    const first = catalog.thumbnailFrame(catalog.ensurePhoto("/photos/a.arw").photoId, 64);
    const second = catalog.thumbnailFrame(catalog.ensurePhoto("/photos/b.arw").photoId, 64);
    expect(new Uint8Array(first.frame, FRAME_HEADER_BYTES)).not.toEqual(
      new Uint8Array(second.frame, FRAME_HEADER_BYTES),
    );
  });
});
