// The mock engine's catalog: the same semantics `engine/src/catalog/` will have against
// SQLite, in a Map. Ids are stable per path — `photo.open` and `catalog.import` agree on
// them, which is what the UI's thumbnail cache and selection depend on.
//
// Everything here is pure in-memory state plus one filesystem walk, so it is unit-tested
// directly; the socket plumbing stays in mock-engine.ts.
import { readdirSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
  CatalogChangedParams,
  CatalogCollection,
  CatalogCollectionSetParams,
  CatalogCollectionsResult,
  CatalogFoldersResult,
  CatalogListParams,
  CatalogListResult,
  CatalogPhoto,
  PhotoFlag,
} from "@latent/protocol";
import { FRAME_HEADER_BYTES } from "@latent/protocol";
import { encodeJpeg } from "./jpeg";

/** What the desktop file dialog offers and what an import walk picks up. */
export const rawExtensions = ["raf", "nef", "arw", "cr2", "cr3", "dng", "orf", "rw2", "pef"];

export function isRawPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return rawExtensions.includes(path.slice(dot + 1).toLowerCase());
}

/**
 * Every raw file under `paths`: files are taken as they are, directories are walked.
 * Unreadable entries are skipped — an import must not die on one bad symlink.
 */
export function scanRawFiles(paths: string[], recursive: boolean): string[] {
  const found = new Set<string>();
  const walk = (directory: string): void => {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(child);
        continue;
      }
      if (isRawPath(child)) found.add(resolve(child));
    }
  };
  for (const path of paths) {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      walk(path);
      continue;
    }
    if (isRawPath(path)) found.add(resolve(path));
  }
  return [...found];
}

function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const cameras = ["Fujifilm X-T5", "Sony A6400", "Canon R6", "Nikon Z6 II", "Pentax K-3"];
const lenses = ["XF 35mm f/1.4", "FE 24-70mm f/2.8", "RF 50mm f/1.2", "Z 85mm f/1.8"];
const shutters = ["1/2000", "1/500", "1/250", "1/125", "1/60", "1/15"];

/** Plausible EXIF for a file the mock never decodes: derived from the path, so stable. */
function synthesise(photoId: number, path: string, importedAt: string): CatalogPhoto {
  const hash = hashOf(path);
  const portrait = hash % 5 === 0;
  const capturedAt = new Date(Date.UTC(2026, 3, 1) + (hash % 720) * 3_600_000).toISOString();
  return {
    photoId,
    path,
    folder: dirname(path),
    filename: basename(path),
    width: portrait ? 4024 : 6024,
    height: portrait ? 6024 : 4024,
    camera: cameras[hash % cameras.length] ?? "Mock Camera",
    lens: lenses[(hash >> 3) % lenses.length],
    capturedAt,
    importedAt,
    rating: 0,
    flag: "none",
    hasSidecar: false,
    iso: 100 * 2 ** (hash % 6),
    shutter: shutters[(hash >> 5) % shutters.length],
    aperture: [1.4, 1.8, 2.8, 4, 5.6, 8][(hash >> 7) % 6],
    focalLength: [16, 23, 35, 50, 85, 135][(hash >> 9) % 6],
  };
}

type SortKey = NonNullable<CatalogListParams["sort"]>;

/** Ascending order for one sort key; rows missing the key sort last, then by filename. */
function compare(a: CatalogPhoto, b: CatalogPhoto, sort: SortKey): number {
  if (sort === "rating") return a.rating - b.rating;
  const left = a[sort];
  const right = b[sort];
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The tie-breaker the schema documents: equal sort keys order by filename ascending, then
 * by photoId. Both are ascending whatever `descending` does to the primary key, so a page
 * boundary never reshuffles between two calls.
 */
export function sortPhotos(
  photos: CatalogPhoto[],
  sort: SortKey,
  descending: boolean,
): CatalogPhoto[] {
  const direction = descending ? -1 : 1;
  return [...photos].sort((a, b) => {
    const primary = compare(a, b, sort) * direction;
    if (primary !== 0) return primary;
    const byFilename = a.filename.localeCompare(b.filename);
    if (byFilename !== 0) return byFilename;
    return a.photoId - b.photoId;
  });
}

/** `query` is a substring of the filename or the camera, case-insensitive. */
function matchesQuery(photo: CatalogPhoto, query: string): boolean {
  const needle = query.toLowerCase();
  if (!needle) return true;
  return (
    photo.filename.toLowerCase().includes(needle) || photo.camera.toLowerCase().includes(needle)
  );
}

export function matchesFilter(
  photo: CatalogPhoto,
  params: CatalogListParams,
  members: Set<number> | null,
): boolean {
  if (params.folder !== undefined && photo.folder !== params.folder) return false;
  if (params.photoIds !== undefined && !params.photoIds.includes(photo.photoId)) return false;
  if (params.query !== undefined && !matchesQuery(photo, params.query)) return false;
  if (members && !members.has(photo.photoId)) return false;
  if (params.flag !== undefined && photo.flag !== params.flag) return false;
  if (params.minRating !== undefined && photo.rating < params.minRating) return false;
  return true;
}

interface Collection {
  collectionId: number;
  name: string;
  members: Set<number>;
}

export class MockCatalog {
  private readonly byId = new Map<number, CatalogPhoto>();
  private readonly idByPath = new Map<string, number>();
  private readonly collectionsById = new Map<number, Collection>();
  /** Absolute directory -> whether the watch covers what is under it. */
  private readonly watchedRoots = new Map<string, boolean>();
  private nextPhotoId = 1;
  private nextCollectionId = 1;
  private thumbnailSeq = 0;

  /** The row for this path, adding it to the catalog when it is new. Ids never move. */
  ensurePhoto(path: string): CatalogPhoto {
    const absolute = resolve(path);
    const existing = this.idByPath.get(absolute);
    if (existing !== undefined) return this.photo(existing);
    const photoId = this.nextPhotoId++;
    const row = synthesise(photoId, absolute, new Date().toISOString());
    this.byId.set(photoId, row);
    this.idByPath.set(absolute, photoId);
    return row;
  }

  photo(photoId: number): CatalogPhoto {
    const row = this.byId.get(photoId);
    if (!row) throw new Error(`unknown photoId ${photoId}`);
    return row;
  }

  has(photoId: number): boolean {
    return this.byId.has(photoId);
  }

  list(params: CatalogListParams): CatalogListResult {
    const members = this.membersOf(params.collectionId);
    const matched = [...this.byId.values()].filter((photo) =>
      matchesFilter(photo, params, members),
    );
    const sorted = sortPhotos(matched, params.sort ?? "capturedAt", params.descending === true);
    const offset = params.offset ?? 0;
    const limit = params.limit ?? sorted.length;
    return { photos: sorted.slice(offset, offset + limit), total: matched.length };
  }

  /**
   * Importing a directory also asks the engine to keep watching it (catalog/watcher.h).
   * Anything that is not a directory is ignored: picking three files out of a folder is
   * not asking to be told about the rest of it.
   */
  watchFolder(path: string, recursive: boolean): void {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      return;
    }
    if (!stats.isDirectory()) return;
    const absolute = resolve(path);
    this.watchedRoots.set(absolute, recursive || this.watchedRoots.get(absolute) === true);
  }

  folders(): CatalogFoldersResult {
    const counts = new Map<string, number>();
    for (const photo of this.byId.values()) {
      counts.set(photo.folder, (counts.get(photo.folder) ?? 0) + 1);
    }
    return {
      folders: [...counts.entries()]
        .map(([path, count]) => ({ path, count, watched: this.isWatched(path) }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  private isWatched(folder: string): boolean {
    for (const [root, recursive] of this.watchedRoots) {
      if (folder === root) return true;
      if (recursive && folder.startsWith(`${root}/`)) return true;
    }
    return false;
  }

  setRating(photoId: number, rating: number): CatalogPhoto {
    const photo = this.photo(photoId);
    photo.rating = Math.min(5, Math.max(0, Math.round(rating)));
    return photo;
  }

  setFlag(photoId: number, flag: PhotoFlag): CatalogPhoto {
    const photo = this.photo(photoId);
    photo.flag = flag;
    return photo;
  }

  /**
   * Drops rows and everything that points at them — collection membership, the path
   * index. The files are not touched; that is the whole point of `catalog.remove`.
   * Returns how many rows actually went away.
   */
  remove(photoIds: number[]): number {
    let removed = 0;
    for (const photoId of new Set(photoIds)) {
      const photo = this.byId.get(photoId);
      if (!photo) continue;
      this.byId.delete(photoId);
      this.idByPath.delete(photo.path);
      for (const collection of this.collectionsById.values()) collection.members.delete(photoId);
      removed += 1;
    }
    return removed;
  }

  /** Marks a photo as edited; the engine does this on every committed stack change. */
  markEdited(photoId: number): void {
    const photo = this.byId.get(photoId);
    if (!photo) return;
    photo.editedAt = new Date().toISOString();
    photo.hasSidecar = true;
  }

  collections(): CatalogCollectionsResult {
    const collections: CatalogCollection[] = [...this.collectionsById.values()].map(
      (collection) => ({
        collectionId: collection.collectionId,
        name: collection.name,
        count: collection.members.size,
      }),
    );
    return { collections: collections.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /** Create, rename, delete, add and remove, in one method, the way the schema has it. */
  collectionSet(params: CatalogCollectionSetParams): CatalogCollectionsResult {
    const collection = this.resolveCollection(params);
    if (params.delete === true) {
      this.collectionsById.delete(collection.collectionId);
      return this.collections();
    }
    if (params.name !== undefined) collection.name = params.name;
    for (const photoId of params.add ?? []) {
      if (!this.byId.has(photoId)) throw new Error(`unknown photoId ${photoId}`);
      collection.members.add(photoId);
    }
    for (const photoId of params.remove ?? []) collection.members.delete(photoId);
    return this.collections();
  }

  /**
   * An LTHM frame (frames.md) with a synthetic JPEG whose colour comes from the photo id,
   * so every filmstrip cell is visibly its own photo.
   */
  thumbnailFrame(
    photoId: number,
    size: number,
  ): { frame: ArrayBuffer; width: number; height: number } {
    const photo = this.photo(photoId);
    const portrait = photo.height > photo.width;
    const width = portrait ? Math.round(size * 0.66) : size;
    const height = portrait ? size : Math.round(size * 0.66);
    const jpeg = encodeJpeg(paintThumbnail(photoId, width, height), width, height, 72);

    const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + jpeg.length);
    const header = new DataView(buffer);
    const magic = "LTHM";
    for (let index = 0; index < magic.length; index++) {
      header.setUint8(index, magic.charCodeAt(index));
    }
    header.setUint32(4, width, true);
    header.setUint32(8, height, true);
    header.setUint32(12, ++this.thumbnailSeq, true);
    header.setUint32(16, photoId, true);
    header.setUint32(20, 1, true); // jpeg
    new Uint8Array(buffer, FRAME_HEADER_BYTES).set(jpeg);
    return { frame: buffer, width, height };
  }

  private membersOf(collectionId: number | undefined): Set<number> | null {
    if (collectionId === undefined) return null;
    const collection = this.collectionsById.get(collectionId);
    if (!collection) throw new Error(`unknown collectionId ${collectionId}`);
    return collection.members;
  }

  private resolveCollection(params: CatalogCollectionSetParams): Collection {
    if (params.collectionId === undefined) {
      const collectionId = this.nextCollectionId++;
      const created: Collection = {
        collectionId,
        name: params.name ?? `Collection ${collectionId}`,
        members: new Set(),
      };
      this.collectionsById.set(collectionId, created);
      return created;
    }
    const existing = this.collectionsById.get(params.collectionId);
    if (!existing) throw new Error(`unknown collectionId ${params.collectionId}`);
    return existing;
  }
}

/** A per-photo picture: hue from the id, a horizon, a sun and a vignette. */
function paintThumbnail(photoId: number, width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const hue = (photoId * 47) % 360;
  const horizon = 0.52 + 0.14 * Math.sin(photoId);
  const sunX = 0.2 + ((photoId * 0.17) % 0.6);
  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const ground = v > horizon;
      const shade = ground ? 0.25 + 0.35 * (1 - (v - horizon)) : 0.55 + 0.4 * (1 - v);
      const sun = Math.max(0, 1 - Math.hypot((u - sunX) * 1.6, v - horizon * 0.55) * 4);
      const tint = ground ? hue + 40 : hue;
      const [red, green, blue] = hsvToRgb(tint % 360, ground ? 0.55 : 0.4, shade + sun * 0.5);
      const vignette = 1 - 0.35 * Math.hypot(u - 0.5, v - 0.5);
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.min(255, red * vignette * 255);
      pixels[offset + 1] = Math.min(255, green * vignette * 255);
      pixels[offset + 2] = Math.min(255, blue * vignette * 255);
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function hsvToRgb(hue: number, saturation: number, value: number): [number, number, number] {
  const sector = hue / 60;
  const chroma = value * saturation;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = value - chroma;
  const wheel: [number, number, number][] = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ];
  const [red, green, blue] = wheel[Math.floor(sector) % 6] ?? [0, 0, 0];
  return [base + red, base + green, base + blue];
}

export type CatalogReason = CatalogChangedParams["reason"];
