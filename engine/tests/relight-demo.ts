// What a virtual light costs, and what one looks like (PROMPT.md 3.8).
//
//   bun engine/tests/relight-demo.ts [--photo <raw>]
//
// Estimates the photo's depth map, writes it as a PNG, then writes three frames — the
// picture as it was, the same picture with the light on, and the same light with its rays
// turned up — and prints the per-tick render cost of each against the unlit frame, because
// the two relight passes march the depth map 48 times per pixel and that has to stay
// inside the 16 ms slider budget (PROMPT.md 8.1).
import { existsSync, rmSync } from "node:fs";
import {
  connect,
  encodePng,
  engineExecutable,
  maskToRgba,
  samplePath,
  startEngine,
  type Client,
} from "./harness";

const argument = process.argv.indexOf("--photo");
const photoPath = argument > 0 ? process.argv[argument + 1]! : samplePath;
const prefix = process.env.LATENT_RELIGHT_PREFIX ?? "/tmp/latent-relight";
const scratch = `/tmp/latent-relight-${process.pid}`;

if (!existsSync(engineExecutable)) {
  console.error(`relight-demo: ${engineExecutable} not built`);
  process.exit(1);
}
if (!existsSync(photoPath)) {
  console.log(`relight-demo: skipping, no photo at ${photoPath}`);
  process.exit(77);
}

const engine = startEngine(scratch);
const client = await connect(await engine.endpoint);
const photo = await client.call("photo.open", { path: photoPath });
const photoId: number = photo.photoId;
const view = await client.call("view.open", { photoId, width: 1280, height: 720 });
const viewId: number = view.viewId;

async function waitForJob(client: Client, jobId: number): Promise<string> {
  for (let i = 0; i < 3000; i++) {
    const done = client.notifications.find(
      (n) => n.method === "job.progress" && n.params.jobId === jobId && n.params.finished,
    );
    if (done) return `${done.params.state}: ${done.params.message ?? done.params.error ?? ""}`;
    await Bun.sleep(20);
  }
  throw new Error("relight-demo: the job never finished");
}

/** p50 of `count` renders of the stack that is already set. */
async function tick(count = 15): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    samples.push((await client.call("view.render", { viewId })).renderMs);
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
}

async function shot(name: string, stack: unknown[]): Promise<number> {
  await client.call("stack.set", { photoId, stack });
  const ms = await tick();
  const frame = client.frame!;
  await Bun.write(`${prefix}-${name}.png`, encodePng(frame.pixels, frame.width, frame.height));
  console.log(`  ${name.padEnd(8)} ${ms.toFixed(2)} ms  -> ${prefix}-${name}.png`);
  return ms;
}

console.log(`photo ${photoPath} (${photo.width}x${photo.height}), depth ${photo.depthReady}`);

const started = performance.now();
const job = await client.call("depth.estimate", { photoId });
const state = await waitForJob(client, job.jobId);
console.log(`depth.estimate: ${state} in ${(performance.now() - started).toFixed(0)} ms`);

const preview = await client.call("depth.preview", { photoId });
const map = client.depths.at(-1)!;
await Bun.write(`${prefix}-depth.png`, encodePng(maskToRgba(map), map.width, map.height));
console.log(`  depth map ${preview.width}x${preview.height} -> ${prefix}-depth.png`);

// A low sun behind the subject: the light sits deep in the scene, so anything nearer than
// it blocks both the shading and the rays.
const light = {
  id: "relight1",
  op: "relight",
  params: {
    x: 0.42,
    y: 0.22,
    distance: 85,
    intensity: 55,
    radius: 30,
    kelvin: 3000,
    falloff: 50,
    occlusion: 90,
    softness: 55,
    // Off here so the two frames below separate what the light does to a surface from what
    // it does to the air; a light added in the UI has them on.
    rays: 0,
  },
  enabled: true,
};

console.log("\n| frame | render ms (p50) |");
console.log("|---|---|");
await shot("before", []);
await shot("light", [light]);
await shot("rays", [
  { ...light, params: { ...light.params, rays: 90, rayLength: 100, rayDecay: 20 } },
]);

const sidecar = `${photoPath}.latent`;
if (existsSync(sidecar)) await Bun.file(sidecar).delete();
rmSync(`${photoPath}.latent.d`, { recursive: true, force: true });
client.close();
engine.process.kill("SIGTERM");
await engine.process.exited;
rmSync(scratch, { recursive: true, force: true });
