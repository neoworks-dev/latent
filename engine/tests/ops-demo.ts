// Renders the op set against the sample raw and reports what each op costs.
//
//   bun engine/tests/ops-demo.ts
//
// Prints a per-op render cost table at 1280x720 (the size the frame budget is quoted at)
// and writes a proxy PNG with a heavy dehaze + vignette + crop + sharpening + grain to
// /tmp/latent-ops.png, so the passes can be looked at rather than described.
import { existsSync, rmSync } from "node:fs";
import { connect, encodePng, engineExecutable, samplePath, startEngine } from "./harness";

const outputPath = process.env.LATENT_OPS_PNG ?? "/tmp/latent-ops.png";
const scratch = `/tmp/latent-ops-${process.pid}`;

if (!existsSync(engineExecutable)) {
  console.error(`ops-demo: ${engineExecutable} not built`);
  process.exit(1);
}
if (!existsSync(samplePath)) {
  console.log(`ops-demo: skipping, no sample raw at ${samplePath}`);
  process.exit(77);
}

// One non-default value per op, strong enough to see and to time.
const strongValues: Record<string, Record<string, unknown>> = {
  exposure: { value: 0.8 },
  contrast: { value: 60 },
  highlights: { value: -70 },
  shadows: { value: 70 },
  whites: { value: 50 },
  blacks: { value: -50 },
  tone_curve: { shadows: 40, highlights: -40, rgb: [{ x: 0, y: 0.03 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }] },
  white_balance: { mode: "kelvin", kelvin: 7000, tint: 10 },
  vibrance: { value: 60 },
  saturation: { value: 20 },
  color_mixer: { blueSaturation: -60, blueLuminance: -30, orangeSaturation: 40 },
  color_grading: { shadowHue: 220, shadowSaturation: 40, highlightHue: 45, highlightSaturation: 30, balance: 20 },
  texture: { value: 60 },
  clarity: { value: 60 },
  dehaze: { value: 60 },
  vignette: { amount: -60, midpoint: 40, feather: 60, roundness: 20 },
  grain: { amount: 60, size: 30, roughness: 60 },
  sharpening: { amount: 100, radius: 1.2, detail: 40, masking: 30 },
  noise_reduction: { luminance: 40, detail: 50, contrast: 20 },
  color_noise_reduction: { amount: 50, detail: 50, smoothness: 50 },
  manual_denoise: { luminance: 50, detail: 50, color: 70, colorDetail: 50 },
  chromatic_aberration: { enabled: true },
  lens_correction: { distortion: 30, vignetting: 40 },
  defringe: { purpleAmount: 60, greenAmount: 40 },
  crop: { left: 0.05, top: 0.05, right: 0.95, bottom: 0.9, angle: 1.5 },
  rotate: { value: 0 },
  flip: { horizontal: false },
  transform: { vertical: 15, scale: 105 },
};

const engine = startEngine(scratch);
const endpoint = await engine.endpoint;
const client = await connect(endpoint);
const photo = await client.call("photo.open", { path: samplePath });
const photoId: number = photo.photoId;
const view = await client.call("view.open", { photoId, width: 1280, height: 720 });
const viewId: number = view.viewId;

/** Median render/readback of `runs` renders of the given stack, in milliseconds. */
async function measure(stack: unknown[], runs = 25) {
  await client.call("stack.set", { photoId, stack });
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

const described = await client.call("ops.describe");
const baseline = await measure([]);
console.log(`\nempty stack: render ${baseline.render.toFixed(2)} ms, readback ${baseline.readback.toFixed(2)} ms\n`);
console.log("| op | section | render ms | over neutral |");
console.log("|---|---|---|---|");
for (const op of described.ops) {
  const params = strongValues[op.name] ?? {};
  const timing = await measure([{ op: op.name, params, enabled: true }]);
  const delta = timing.render - baseline.render;
  console.log(
    `| ${op.name} | ${op.section} | ${timing.render.toFixed(2)} | ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} |`,
  );
}

const everything = described.ops.map((op: { name: string }) => ({
  op: op.name,
  params: strongValues[op.name] ?? {},
  enabled: true,
}));
const all = await measure(everything);
console.log(
  `\nall ${everything.length} ops: render ${all.render.toFixed(2)} ms + readback ${all.readback.toFixed(2)} ms = ${(all.render + all.readback).toFixed(2)} ms`,
);

// The one op that costs more while it is being dragged than while it sits in the stack:
// a geometry change re-runs the full-res sampling pass that builds the proxy.
const drag: number[] = [];
for (let i = 0; i < 25; i++) {
  await client.call("stack.set", {
    photoId,
    stack: [{ op: "crop", params: { left: 0.01 * i, top: 0.02, right: 0.95, bottom: 0.98 }, enabled: true }],
  });
  drag.push((await client.call("view.render", { viewId })).renderMs);
}
drag.sort((a, b) => a - b);
console.log(`crop drag (proxy rebuilt every tick): render ${drag[drag.length >> 1]!.toFixed(2)} ms\n`);

// The picture: the passes that are easiest to judge by eye, hard enough to be obvious.
await client.call("view.render", { viewId, width: 900, height: 1200 });
await client.call("stack.set", {
  photoId,
  stack: [
    { op: "crop", params: { left: 0.08, top: 0.05, right: 0.92, bottom: 0.78, angle: 2 }, enabled: true },
    { op: "exposure", params: { value: 0.6 }, enabled: true },
    { op: "dehaze", params: { value: 85 }, enabled: true },
    { op: "vignette", params: { amount: -85, midpoint: 35, feather: 55, roundness: 30 }, enabled: true },
    { op: "sharpening", params: { amount: 140, radius: 1.4, detail: 50, masking: 20 }, enabled: true },
    { op: "grain", params: { amount: 70, size: 20, roughness: 60 }, enabled: true },
  ],
});
const demo = await client.call("view.render", { viewId });
const frame = client.frame!;
await Bun.write(outputPath, encodePng(frame.pixels, frame.width, frame.height));
console.log(`wrote ${outputPath} (${frame.width}x${frame.height}, render ${demo.renderMs.toFixed(2)} ms)`);

const sidecar = `${samplePath}.latent`;
if (existsSync(sidecar)) await Bun.file(sidecar).delete();
client.close();
engine.process.kill("SIGTERM");
await engine.process.exited;
rmSync(scratch, { recursive: true, force: true });
