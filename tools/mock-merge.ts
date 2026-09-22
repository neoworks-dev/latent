// Photo Merge in the mock engine: HDR, Panorama, HDR Panorama and the preview job the
// dialog shows. Everything here is synthetic — the point is that the UI's whole round trip
// runs without LibRaw or a GPU: a job that ticks, a PNG the engine serves over its own
// listener, a catalog row for the merged file, and a `job.progress` whose last notification
// carries the result.
//
// The picture differs visibly per kind on purpose: a screenshot of the dialog proves the
// image came from the call rather than from a placeholder.
import type { MergeKind, NotificationName } from "@latent/protocol";
import { deflateSync } from "node:zlib";
import { basename, dirname, join } from "node:path";
import type { MockCatalog } from "./mock-catalog";

/** The Lightroom options a merge call can carry; every one is optional on the wire. */
export interface MergeOptions {
  autoAlign: boolean;
  deghost: "none" | "low" | "medium" | "high";
  projection: "spherical" | "cylindrical" | "perspective";
  boundaryWarp: number;
  autoCrop: boolean;
}

/** Lightroom's output filename suffix per kind; the engine names the TIFF the same way. */
const kindSuffixes: Record<MergeKind, string> = {
  hdr: "HDR",
  panorama: "Pano",
  hdrPanorama: "HDRPano",
  starTrail: "Trails",
};

/** The schema's own photo-count bounds, refused here the way the engine refuses them. */
const photoCounts: Record<MergeKind, { min: number; max: number }> = {
  hdr: { min: 2, max: 7 },
  panorama: { min: 2, max: 12 },
  hdrPanorama: { min: 4, max: 48 },
  starTrail: { min: 2, max: 500 },
};

const methodKinds: Record<string, MergeKind> = {
  "merge.hdr": "hdr",
  "merge.panorama": "panorama",
  "merge.hdrPanorama": "hdrPanorama",
  "merge.starTrail": "starTrail",
};

/** Where the mock pretends it wrote the preview PNGs it serves. */
const previewDir = "/tmp/latent-mock/previews";

/** What a job needs from the engine that owns the job map and the timers. */
export interface MergeJobHandle {
  cancelled: boolean;
  finished: boolean;
}

export interface MergeHost {
  readonly catalog: MockCatalog;
  broadcast(method: NotificationName, params: unknown): void;
  /** Reserves a cancellable job id in the engine's own job map. */
  startJob(): { jobId: number; job: MergeJobHandle };
  timer(callback: () => void, delayMs: number): void;
  /** `http://127.0.0.1:<port>` — the listener the preview URL points back at. */
  origin(): string;
}

export function mergeOutputPath(kind: MergeKind, source: string): string {
  const name = basename(source);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return join(dirname(source), `${stem}-${kindSuffixes[kind]}.tif`);
}

export function mergeOptions(params: Record<string, unknown>): MergeOptions {
  return {
    autoAlign: params.autoAlign !== false,
    deghost: deghostOf(params.deghost),
    projection: projectionOf(params.projection),
    boundaryWarp: clamp(numberOf(params.boundaryWarp, 0), 0, 100),
    autoCrop: params.autoCrop !== false,
  };
}

/**
 * Photo Merge's four methods. The engine hands this the job map and its timers, so a
 * cancelled merge stops at the same place a cancelled import does.
 */
export class MockMerge {
  /** `<name>` → the PNG bytes the HTTP route serves at `/preview/<name>.png`. The buffer
   *  is spelled out because `Response` only takes a view over a plain `ArrayBuffer`. */
  private readonly previews = new Map<string, Uint8Array<ArrayBuffer>>();

  constructor(private readonly host: MergeHost) {}

  handle(method: string, params: Record<string, unknown>): { result: unknown } {
    if (method === "merge.preview") return { result: { jobId: this.startPreview(params) } };
    const kind = methodKinds[method];
    if (!kind) throw new Error(`unknown method ${method}`);
    return { result: { jobId: this.startMerge(kind, params) } };
  }

  /** The PNG behind a `/preview/<name>.png` request, or undefined for any other path. */
  servePreview(pathname: string): Uint8Array<ArrayBuffer> | undefined {
    const match = /^\/preview\/(.+)\.png$/.exec(pathname);
    if (!match?.[1]) return undefined;
    return this.previews.get(match[1]);
  }

  /**
   * The preview: a few ticks, then a PNG written into the store and named by an absolute
   * URL on the engine's own listener. A renderer puts that straight in an `<img src>`,
   * which a `file://` path could not do. Nothing reaches the catalog.
   */
  private startPreview(params: Record<string, unknown>): number {
    const kind = kindOf(params.kind);
    const photoIds = idsOf(params.photoIds);
    requireCount(kind, photoIds.length);
    const options = mergeOptions(params);
    const longEdge = clamp(numberOf(params.longEdge, 1024), 256, 4096);
    const { jobId, job } = this.host.startJob();
    const started = performance.now();

    this.tickJob(jobId, job, 3, `${kindLabel(kind)} preview`, () => {
      const name = `merge-preview-${jobId}`;
      const picture = paintMerge(kind, photoIds.length, options, longEdge);
      this.previews.set(name, encodePng(picture.rgba, picture.width, picture.height));
      return {
        previewUrl: `${this.host.origin()}/preview/${name}.png`,
        previewPath: join(previewDir, `${name}.png`),
        width: picture.width,
        height: picture.height,
        durationMs: performance.now() - started,
      };
    });
    return jobId;
  }

  /**
   * The merge itself: ticks once per source frame, registers the written file as a catalog
   * row, announces it as an import, and names the row in the job's last notification.
   */
  private startMerge(kind: MergeKind, params: Record<string, unknown>): number {
    const photoIds = idsOf(params.photoIds);
    requireCount(kind, photoIds.length);
    const first = photoIds[0];
    if (first === undefined) throw new Error("merge needs at least one photo");
    const source = this.host.catalog.photo(first);
    const outputPath =
      typeof params.outputPath === "string"
        ? params.outputPath
        : mergeOutputPath(kind, source.path);
    const { jobId, job } = this.host.startJob();
    const started = performance.now();

    this.tickJob(jobId, job, photoIds.length, `merging ${photoIds.length} photos`, () => {
      const row = this.host.catalog.ensurePhoto(outputPath);
      // The same notification an import publishes: the merged file is a new catalog row,
      // and every client re-lists off it.
      this.host.broadcast("catalog.changed", { photoIds: [row.photoId], reason: "import" });
      return {
        photoId: row.photoId,
        path: row.path,
        width: row.width,
        height: row.height,
        durationMs: performance.now() - started,
      };
    });
    return jobId;
  }

  /**
   * One job's whole life: `total` ticks 60 ms apart, then `finish()` produces the result
   * that rides the last notification. Cancellation lands between ticks, like every other
   * job in the mock — the last notification then carries `cancelled` and no result.
   */
  private tickJob(
    jobId: number,
    job: MergeJobHandle,
    total: number,
    message: string,
    finish: () => Record<string, unknown>,
  ): void {
    let done = 0;
    const tick = (): void => {
      done += 1;
      if (job.cancelled) {
        job.finished = true;
        this.host.broadcast("job.progress", {
          jobId,
          kind: "merge",
          done,
          total,
          finished: true,
          state: "cancelled",
          message: `${message} cancelled`,
        });
        return;
      }
      if (done < total) {
        this.host.broadcast("job.progress", {
          jobId,
          kind: "merge",
          done,
          total,
          finished: false,
          state: "running",
          message,
        });
        this.host.timer(tick, 60);
        return;
      }
      job.finished = true;
      this.host.broadcast("job.progress", {
        jobId,
        kind: "merge",
        done: total,
        total,
        finished: true,
        state: "done",
        message,
        result: finish(),
      });
    };
    this.host.timer(tick, 60);
  }
}

function kindLabel(kind: MergeKind): string {
  if (kind === "hdr") return "HDR";
  if (kind === "panorama") return "panorama";
  if (kind === "starTrail") return "star trails";
  return "HDR panorama";
}

function kindOf(value: unknown): MergeKind {
  if (value === "hdr" || value === "panorama" || value === "hdrPanorama") return value;
  if (value === "starTrail") return value;
  throw new Error(`merge.preview needs a kind, got ${String(value)}`);
}

function idsOf(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error("photoIds must be an array");
  return value.map((entry) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new Error(`photoIds holds ${String(entry)}, which is not a photo id`);
    }
    return entry;
  });
}

function requireCount(kind: MergeKind, count: number): void {
  const bounds = photoCounts[kind];
  if (count >= bounds.min && count <= bounds.max) return;
  throw new Error(`${kind} takes ${bounds.min} to ${bounds.max} photos, got ${count}`);
}

function deghostOf(value: unknown): MergeOptions["deghost"] {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "none";
}

function projectionOf(value: unknown): MergeOptions["projection"] {
  if (value === "cylindrical" || value === "perspective") return value;
  return "spherical";
}

function numberOf(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// ---- the picture ------------------------------------------------------------------

export interface MergePicture {
  rgba: Uint8Array;
  width: number;
  height: number;
}

/**
 * The synthetic merged picture. An HDR merge is one frame with a blown sun and a lifted
 * shadow, and the ghosts a lower Deghost Amount leaves behind; a panorama is a much wider
 * mosaic with one tile per source, whose uneven edges Boundary Warp pulls toward the frame
 * and Auto Crop removes. That makes the two trivially distinguishable in a screenshot.
 */
export function paintMerge(
  kind: MergeKind,
  sources: number,
  options: MergeOptions,
  longEdge: number,
): MergePicture {
  if (kind === "hdr") {
    const width = longEdge;
    const height = Math.round(longEdge * 0.66);
    return { rgba: paintHdr(width, height, sources, options), width, height };
  }
  if (kind === "starTrail") {
    const width = longEdge;
    const height = Math.round(longEdge * 0.66);
    return { rgba: paintStarTrail(width, height, sources), width, height };
  }
  const width = longEdge;
  const height = Math.round(longEdge * 0.3);
  return {
    rgba: paintPanorama(width, height, sources, kind === "hdrPanorama", options),
    width,
    height,
  };
}

function paintHdr(
  width: number,
  height: number,
  frames: number,
  options: MergeOptions,
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  // None leaves three ghosts, High leaves none — the slider's whole job, made visible.
  const ghosts = { none: 3, low: 2, medium: 1, high: 0 }[options.deghost];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      const sun = Math.exp(-(((u - 0.72) ** 2 + (v - 0.26) ** 2) / 0.012));
      const sky = 1 - v * 0.55;
      const ground = v > 0.62 ? 0.18 + 0.3 * (1 - v) : 0;
      // The lifted shadow an exposure stack buys: the ground keeps detail instead of
      // clipping to black, and a band per merged frame says how deep the stack was.
      const band = ground > 0 ? 0.05 * Math.sin(v * frames * 18) : 0;
      let red = clamp(0.25 * sky + sun * 1.4 + ground + band, 0, 1);
      let green = clamp(0.4 * sky + sun * 1.25 + ground * 0.9 + band, 0, 1);
      let blue = clamp(0.75 * sky + sun * 0.95 + ground * 0.7 + band, 0, 1);
      for (let ghost = 0; ghost < ghosts; ghost++) {
        const cx = 0.18 + ghost * 0.16;
        const blob = Math.exp(-(((u - cx) ** 2 + (v - 0.72) ** 2) / 0.0016));
        red = clamp(red + blob * 0.5, 0, 1);
        blue = clamp(blue + blob * 0.4, 0, 1);
      }
      writePixel(rgba, (y * width + x) * 4, red, green, blue, 1);
    }
  }
  return rgba;
}

/** Arcs around the pole over a dark sky, with a black ridge along the bottom: what a lighten
 *  stack of a night sequence looks like, and nothing like the other two kinds. */
function paintStarTrail(width: number, height: number, frames: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  const pole = { u: 0.32, v: 0.24 };
  // One arc per star, each swept by an angle that grows with the number of frames stacked.
  const sweep = Math.min(1.2, 0.05 * frames);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      const ridge = 0.78 + 0.06 * Math.sin(u * 7);
      if (v > ridge) {
        writePixel(rgba, (y * width + x) * 4, 0.03, 0.03, 0.04, 1);
        continue;
      }
      const radius = Math.hypot(u - pole.u, (v - pole.v) * 0.8);
      const angle = Math.atan2(v - pole.v, u - pole.u);
      // A trail is lit where the star's own arc passes: a ring, cut to an arc by the sweep.
      const ring = Math.abs(((radius * 46) % 1) - 0.5) < 0.06 ? 1 : 0;
      const along = angle > -sweep && angle < sweep ? 1 : 0;
      const trail = ring * along;
      const sky = 0.06 + 0.05 * (1 - v);
      writePixel(
        rgba,
        (y * width + x) * 4,
        clamp(sky * 0.7 + trail * 0.85, 0, 1),
        clamp(sky * 0.8 + trail * 0.8, 0, 1),
        clamp(sky * 1.3 + trail * 0.7, 0, 1),
        1,
      );
    }
  }
  return rgba;
}

function paintPanorama(
  width: number,
  height: number,
  tiles: number,
  toned: boolean,
  options: MergeOptions,
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  const warp = options.boundaryWarp / 100;
  // The wavy margin a hand-held sweep leaves. Boundary Warp stretches it into the frame,
  // Auto Crop throws what is left away — either way the black edge shrinks.
  const swing = 0.09 * (1 - warp);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      const wave = swing * Math.sin(u * Math.PI * 3);
      const top = swing * 0.5 + wave;
      const bottom = 1 - swing * 0.5 + wave;
      const offset = (y * width + x) * 4;
      if (!options.autoCrop && (v < top || v > bottom)) {
        writePixel(rgba, offset, 0.04, 0.04, 0.05, 1);
        continue;
      }
      const tile = Math.min(tiles - 1, Math.floor(u * tiles));
      const seam = Math.abs((u * tiles) % 1) < 0.006 ? 0.25 : 0;
      const hue = (tile * 47 + (options.projection === "perspective" ? 140 : 0)) % 360;
      const [red, green, blue] = hslToRgb(
        hue / 360,
        0.42,
        toned ? 0.42 + 0.3 * (1 - v) : 0.55 - v * 0.2,
      );
      writePixel(
        rgba,
        offset,
        clamp(red + seam, 0, 1),
        clamp(green + seam, 0, 1),
        clamp(blue + seam, 0, 1),
        1,
      );
    }
  }
  return rgba;
}

function writePixel(
  rgba: Uint8Array,
  offset: number,
  red: number,
  green: number,
  blue: number,
  alpha: number,
): void {
  rgba[offset] = Math.round(red * 255);
  rgba[offset + 1] = Math.round(green * 255);
  rgba[offset + 2] = Math.round(blue * 255);
  rgba[offset + 3] = Math.round(alpha * 255);
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const shift = lightness - chroma / 2;
  const channel = (offset: number): number => {
    const position = (offset / 12 + hue) % 1;
    const wave = Math.max(0, Math.min(1, Math.min(4 * position, 4 - 4 * position, 1)));
    return clamp(chroma * wave + shift, 0, 1);
  };
  return [channel(0), channel(8), channel(4)];
}

// ---- PNG --------------------------------------------------------------------------

const crcTable = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let index = 0; index < 4; index++) body[index] = type.charCodeAt(index);
  body.set(data, 4);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  chunk.set(body, 4);
  view.setUint32(8 + data.length, crc32(body), false);
  return chunk;
}

/**
 * Eight-bit RGBA into a PNG. The renderer gets the preview over HTTP, so it has to be a
 * real image file; `deflateSync` is node's own zlib, and a filter byte of zero per row is
 * all the encoder any synthetic picture needs.
 */
export function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width, false);
  headerView.setUint32(4, height, false);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  const chunks = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw))),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.length;
  }
  return png;
}
