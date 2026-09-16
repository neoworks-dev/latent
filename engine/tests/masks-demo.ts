// What a mask costs, and what one looks like.
//
//   bun engine/tests/masks-demo.ts
//
// Prints the per-tick render cost of five masked ops against the same five unmasked at
// 1280x720 — the size the frame budget is quoted at — to show that a cached mask is only
// a blend, then writes two PNGs: the picture with a radial-masked +2 EV exposure and a
// brush-masked -100 saturation, and the combined mask of the exposure op.
import { existsSync, rmSync } from "node:fs";
import {
  connect,
  encodePng,
  engineExecutable,
  maskToRgba,
  samplePath,
  startEngine,
} from "./harness";

const imagePath = process.env.LATENT_MASKS_PNG ?? "/tmp/latent-masks.png";
const rasterPath = process.env.LATENT_MASK_RASTER_PNG ?? "/tmp/latent-mask-raster.png";
const scratch = `/tmp/latent-masks-${process.pid}`;

if (!existsSync(engineExecutable)) {
  console.error(`masks-demo: ${engineExecutable} not built`);
  process.exit(1);
}
if (!existsSync(samplePath)) {
  console.log(`masks-demo: skipping, no sample raw at ${samplePath}`);
  process.exit(77);
}

const engine = startEngine(scratch);
const client = await connect(await engine.endpoint);
const photo = await client.call("photo.open", { path: samplePath });
const photoId: number = photo.photoId;
const view = await client.call("view.open", { photoId, width: 1280, height: 720 });
const viewId: number = view.viewId;

function component(id: string, kind: string, extra: Record<string, unknown> = {}) {
  return { id, kind, mode: "add", ...extra };
}

// One of every inline kind, each on its own op, all at once.
const maskedStack = [
  {
    id: "op000001",
    op: "exposure",
    params: { value: 1.2 },
    enabled: true,
    mask: { components: [component("m1", "radial", { params: { center: [0.5, 0.42], radius: [0.3, 0.34] }, feather: 60 })] },
  },
  {
    id: "op000002",
    op: "contrast",
    params: { value: 60 },
    enabled: true,
    mask: { components: [component("m2", "linear", { params: { start: [0, 0.1], end: [0, 0.9] } })] },
  },
  {
    id: "op000003",
    op: "highlights",
    params: { value: -80 },
    enabled: true,
    mask: { components: [component("m3", "luminance", { params: { range: [0.6, 1], smoothness: 0.2 } })] },
  },
  {
    id: "op000004",
    op: "saturation",
    params: { value: -100 },
    enabled: true,
    mask: { components: [component("m4", "brush", { params: { size: 0.14, flow: 100 }, feather: 60 })] },
  },
  {
    id: "op000005",
    op: "vibrance",
    params: { value: 80 },
    enabled: true,
    mask: { components: [component("m5", "color", { params: { samples: [[0.35, 0.3, 0.22]], range: 0.25, smoothness: 0.2 } })] },
  },
];
const unmaskedStack = maskedStack.map(({ mask, ...op }) => op);

/** Median render/readback of `runs` renders, in milliseconds, with no stack write between. */
async function measure(runs = 40) {
  const render: number[] = [];
  const readback: number[] = [];
  for (let i = 0; i < runs; i++) {
    const timing = await client.call("view.render", { viewId });
    render.push(timing.renderMs);
    readback.push(timing.readbackMs);
  }
  render.sort((a, b) => a - b);
  readback.sort((a, b) => a - b);
  return { render: render[render.length >> 1]!, readback: readback[readback.length >> 1]! };
}

/** A slider drag: one transient op.update per tick, then a render. */
async function drag(opId: string, values: number[]) {
  const ticks: number[] = [];
  for (const value of values) {
    await client.call("op.update", { photoId, opId, params: { value }, transient: true });
    ticks.push((await client.call("view.render", { viewId })).renderMs);
  }
  ticks.sort((a, b) => a - b);
  return ticks[ticks.length >> 1]!;
}

const dragValues = Array.from({ length: 25 }, (_, i) => 0.4 + i * 0.02);

await client.call("stack.set", { photoId, stack: [] });
const empty = await measure();

await client.call("stack.set", { photoId, stack: unmaskedStack });
const unmasked = await measure();
const unmaskedDrag = await drag("op000001", dragValues);

await client.call("stack.set", { photoId, stack: maskedStack });
// Paint the brush component before measuring: an empty brush is a cheap mask.
for (let i = 0; i < 6; i++) {
  await client.call("mask.stroke", {
    photoId,
    opId: "op000004",
    componentId: "m4",
    points: [
      [0.2 + i * 0.05, 0.3],
      [0.25 + i * 0.05, 0.5],
      [0.2 + i * 0.05, 0.7],
    ],
    transient: i < 5,
  });
}
const firstTick = (await client.call("view.render", { viewId })).renderMs;
const masked = await measure();
const maskedDrag = await drag("op000001", dragValues);

console.log("\n| stack at 1280x720 | render ms (p50) | readback ms (p50) |");
console.log("|---|---|---|");
console.log(`| empty | ${empty.render.toFixed(2)} | ${empty.readback.toFixed(2)} |`);
console.log(`| 5 ops, no masks | ${unmasked.render.toFixed(2)} | ${unmasked.readback.toFixed(2)} |`);
console.log(`| 5 ops, 5 masks (cached) | ${masked.render.toFixed(2)} | ${masked.readback.toFixed(2)} |`);
console.log(`| 5 ops, 5 masks (first tick, rasterising) | ${firstTick.toFixed(2)} | - |`);
console.log(`\nslider drag, 25 transient op.update + view.render ticks (p50 render):`);
console.log(`  unmasked ${unmaskedDrag.toFixed(2)} ms, masked ${maskedDrag.toFixed(2)} ms`);

// The picture: a radial-masked exposure lift on the subject and a brush-masked
// desaturation down one side, so both mask kinds are visible in one frame.
await client.call("stack.set", {
  photoId,
  stack: [
    {
      id: "demo0001",
      op: "exposure",
      params: { value: 2 },
      enabled: true,
      mask: {
        components: [
          component("radial", "radial", {
            params: { center: [0.5, 0.4], radius: [0.26, 0.3] },
            feather: 45,
          }),
        ],
      },
    },
    {
      id: "demo0002",
      op: "saturation",
      params: { value: -100 },
      enabled: true,
      mask: { components: [component("brush", "brush", { params: { size: 0.22, flow: 100 }, feather: 70 })] },
    },
  ],
});
// Across the hat, which is the only strongly coloured thing in the frame: a desaturation
// anywhere else in this shot would be invisible and prove nothing.
await client.call("mask.stroke", {
  photoId,
  opId: "demo0002",
  componentId: "brush",
  points: Array.from({ length: 12 }, (_, i) => [0.34 + i * 0.03, 0.26 + i * 0.004]),
});

await client.call("view.render", { viewId, width: 900, height: 1200 });
const shot = await client.call("view.render", { viewId });
const frame = client.frame!;
await Bun.write(imagePath, encodePng(frame.pixels, frame.width, frame.height));
console.log(`\nwrote ${imagePath} (${frame.width}x${frame.height}, render ${shot.renderMs.toFixed(2)} ms)`);

const preview = await client.call("mask.preview", { photoId, opId: "demo0001", viewId });
const raster = client.masks.at(-1)!;
await Bun.write(rasterPath, encodePng(maskToRgba(raster), raster.width, raster.height));
console.log(
  `wrote ${rasterPath} (${preview.width}x${preview.height}, coverage ${(preview.coverage * 100).toFixed(1)}%)`,
);

const brush = await client.call("mask.preview", { photoId, opId: "demo0002", componentId: "brush", viewId });
console.log(`brush component coverage ${(brush.coverage * 100).toFixed(1)}%`);

const sidecar = `${samplePath}.latent`;
if (existsSync(sidecar)) await Bun.file(sidecar).delete();
rmSync(`${samplePath}.latent.d`, { recursive: true, force: true });
client.close();
engine.process.kill("SIGTERM");
await engine.process.exited;
rmSync(scratch, { recursive: true, force: true });
