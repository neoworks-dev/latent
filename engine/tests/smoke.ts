// End-to-end smoke test: spawn latentd, drive the real protocol over a WebSocket, script it
// through the embedded Python, call its MCP server over HTTP the way an agent would, import
// a folder into the catalog, and write the frame it sends back as a PNG. Run with
// `bun engine/tests/smoke.ts`; ctest runs the same command. Exits 77 (ctest's skip code)
// when the sample raw is missing.
import { existsSync, rmSync } from "node:fs";
import {
  assert,
  channelMean,
  connect,
  detailEnergy,
  difference,
  encodePng,
  engineExecutable,
  letterboxShare,
  mean,
  samplePath,
  startEngine,
  timed,
} from "./harness";

const outputPath = process.env.LATENT_SMOKE_PNG ?? "/tmp/latent-smoke.png";
// Never the real catalog, config or thumbnail cache: this test owns throwaway copies.
const scratch = `/tmp/latent-smoke-${process.pid}`;
const catalogPath = `${scratch}/catalog.db`;

if (!existsSync(engineExecutable)) {
  console.error(`smoke: ${engineExecutable} not built`);
  process.exit(1);
}
if (!existsSync(samplePath)) {
  console.log(`smoke: skipping, no sample raw at ${samplePath}`);
  process.exit(77);
}

const engine = startEngine(scratch);
const started = performance.now();
const endpoint = await engine.endpoint;
console.log(`startup ${(performance.now() - started).toFixed(0)} ms -> ${endpoint}`);

async function waitFor(what: string, predicate: () => boolean, budgetMs = 60000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`smoke: timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

const ui = await connect(endpoint);

const hello = await timed("engine.hello", () => ui.call("engine.hello", { client: "smoke" }));
console.log(`  engine ${hello.engineVersion}, protocol ${hello.protocolVersion}, gpu ${hello.gpu.adapter}`);
console.log(`  catalog ${hello.catalogPath}, mcp ${hello.mcpUrl}`);
assert(hello.protocolVersion === 1, "protocolVersion must be 1");
assert(hello.gpu.maxTextureDimension2D >= 16384, "maxTextureDimension2D too small");
assert(hello.catalogPath === catalogPath, `engine.hello must name the catalog it opened, got ${hello.catalogPath}`);
assert(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(hello.mcpUrl ?? ""), `engine.hello must carry the MCP url, got ${hello.mcpUrl}`);

const described = await timed("ops.describe", () => ui.call("ops.describe"));
const names = described.ops.map((op: { name: string }) => op.name);
console.log(`  ${names.length} ops: ${names.join(", ")}`);
// Lightroom's global develop controls, panel by panel.
const expectedOps = [
  "exposure", "contrast", "highlights", "shadows", "whites", "blacks", "tone_curve",
  "white_balance", "vibrance", "saturation", "color_mixer", "color_grading",
  "texture", "clarity", "dehaze", "vignette", "grain",
  "sharpening", "noise_reduction", "color_noise_reduction",
  "chromatic_aberration", "lens_correction", "defringe",
  "crop", "rotate", "flip", "transform",
];
for (const expected of expectedOps) {
  assert(names.includes(expected), `ops.describe is missing ${expected}`);
}
assert(names.length === expectedOps.length, `ops.describe has ops nobody asked for: ${names}`);

// Every op is placed in a Lightroom section and every param says how to draw it, so a
// generated panel needs nothing but this call. Enums are the exception: the panel draws a
// select from `values`, and a display kind would only send it to the wrong control.
const sectionsSeen: string[] = [];
for (const op of described.ops) {
  assert(typeof op.section === "string" && op.section.length > 0, `${op.name} has no section`);
  assert(typeof op.order === "number" && op.order >= 1, `${op.name} has no order`);
  if (sectionsSeen.at(-1) !== op.section) sectionsSeen.push(op.section);
  for (const param of op.params) {
    if (param.type === "enum") {
      assert(Array.isArray(param.values) && param.values.length > 0, `${op.name}.${param.name} has no values`);
      continue;
    }
    assert(param.display && typeof param.display.kind === "string", `${op.name}.${param.name} has no display hint`);
  }
}
assert(
  sectionsSeen.join(",") === "Light,Color,Effects,Detail,Optics,Geometry",
  `ops.describe must arrive in Lightroom's panel order, got ${sectionsSeen}`,
);

const whiteBalance = described.ops.find((op: any) => op.name === "white_balance");
console.log(`  white_balance ${whiteBalance.section} #${whiteBalance.order}: ${whiteBalance.params.map((p: any) => `${p.name} ${p.type}`).join(", ")}`);
assert(whiteBalance.section === "Color" && whiteBalance.order === 1, "white balance sits first in Color");
assert(whiteBalance.params[0].name === "mode" && whiteBalance.params[0].default === "relative", "white balance defaults to the relative mode older sidecars use");
assert(whiteBalance.params[2].display.kind === "kelvin" && whiteBalance.params[2].unit === "K", "the absolute temperature is a Kelvin slider");
assert(whiteBalance.params[2].min === 2000 && whiteBalance.params[2].max === 50000, "Kelvin runs 2000..50000");
assert(whiteBalance.params[3].display.tint === "tint", "the tint slider carries the tint gradient");
assert(described.ops.find((op: any) => op.name === "exposure").params[0].display.tint === undefined, "an untinted slider must not invent a tint");
assert(described.ops.find((op: any) => op.name === "tone_curve").params.some((p: any) => p.display.kind === "curve"), "the tone curve must ask for a curve editor");
assert(described.ops.find((op: any) => op.name === "color_mixer").params.length === 24, "the colour mixer is eight bands of hue, saturation and luminance");
assert(described.ops.find((op: any) => op.name === "color_mixer").params.every((p: any) => p.display.kind === "hsl"), "the colour mixer asks for the hand-built control");

const sidecarPath = `${samplePath}.latent`;
if (existsSync(sidecarPath)) await Bun.file(sidecarPath).delete();

const photo = await timed("photo.open", () => ui.call("photo.open", { path: samplePath }));
console.log(`  photo ${photo.photoId}: ${photo.camera} ${photo.width}x${photo.height} hash ${photo.hash.slice(0, 12)}…`);
let photoId: number = photo.photoId;
assert(/^[0-9a-f]{64}$/.test(photo.hash), "photo.open must return a sha-256 hex hash");
assert(photo.sidecarLoaded === false, "there is no sidecar yet, so nothing can have been loaded");
assert(photo.catalog && photo.catalog.photoId === photo.photoId, "photo.open must carry the catalog row");
assert(photo.catalog.filename === "DSC00120.ARW" && photo.catalog.camera.includes("Sony"), "the catalog row is wrong");
assert(photo.catalog.hash === photo.hash, "the catalog row must carry the same hash photo.open returns");

// The decode runs on a worker: another client must keep being answered while it happens.
const busy = connect(endpoint).then(async (second) => {
  const reply = await second.call("engine.hello", { client: "during-decode" });
  second.close();
  return reply;
});
assert((await busy).protocolVersion === 1, "the engine must answer other sockets during a decode");

const view = await timed("view.open", () => ui.call("view.open", { photoId, width: 1280, height: 720 }));
let viewId: number = view.viewId;

await timed("view.render (neutral)", () => ui.call("view.render", { viewId }));
const neutral = ui.frame;
assert(neutral, "no frame for the neutral render");

// op.add without params is legal: the registry defaults fill it in.
const defaulted = await timed("op.add (defaults)", () => ui.call("op.add", { photoId, op: "contrast" }));
assert(defaulted.stack.length === 1 && defaulted.stack[0].params.value === 0, "op.add without params should use the defaults");
await ui.call("op.remove", { photoId, opId: defaulted.stack[0].id });

const added = await timed("op.add exposure +1", () =>
  ui.call("op.add", { photoId, op: "exposure", params: { value: 1.0 } }),
);
const opId: string = added.stack[0].id;
assert(added.stack.length === 1, "stack should hold one op");
assert(added.stack[0].op === "exposure" && added.stack[0].params.value === 1, "op.add stored the wrong op");
assert(added.canUndo === true, "canUndo should be true after op.add");

const render = await timed("view.render (+1 EV)", () => ui.call("view.render", { viewId }));
console.log(`  render ${render.renderMs.toFixed(2)} ms, readback ${render.readbackMs.toFixed(2)} ms, seq ${render.seq}`);
assert(ui.frame && ui.frame.seq === render.seq, "frame seq does not match the result");
assert(ui.frame.target === viewId, "frame viewId does not match");
assert(ui.frame.width === 1280 && ui.frame.height === 720, "frame is the wrong size");
assert(render.width === 1280 && render.height === 720, "view.render must report the frame size");
assert(render.revision === added.revision, `view.render must report the revision it rendered: ${render.revision} vs ${added.revision}`);

// +1 EV must be visibly brighter than the neutral render of the same pixels.
const brightNeutral = mean(neutral.pixels);
const brightExposed = mean(ui.frame.pixels);
console.log(`  mean level ${brightNeutral.toFixed(1)} -> ${brightExposed.toFixed(1)}`);
assert(brightExposed > brightNeutral + 5, "exposure +1 did not brighten the frame");

await Bun.write(outputPath, encodePng(ui.frame.pixels, ui.frame.width, ui.frame.height));
console.log(`  wrote ${outputPath}`);

assert(existsSync(sidecarPath), `no sidecar at ${sidecarPath}`);
console.log(`--- ${sidecarPath}\n${await Bun.file(sidecarPath).text()}---`);

// Resizing happens through view.render, and the frame that comes back proves it.
const resized = await timed("view.render (resize)", () =>
  ui.call("view.render", { viewId, width: 640, height: 480 }),
);
assert(ui.frame && ui.frame.width === 640 && ui.frame.height === 480, "view.render did not resize the target");
assert(resized.seq > render.seq, "seq must increase per frame");
await timed("view.render (restore)", () => ui.call("view.render", { viewId, width: 1280, height: 720 }));

// ---- the whole op set -------------------------------------------------------------------
// One op at a time, over the wire, on the real photo. engine/tests/render_test.cpp proves
// every op is a no-op at its defaults; this proves each one reaches the pixels and moves
// them the way its panel says it should.
async function renderOnly(op: string, params: Record<string, unknown>) {
  await ui.call("stack.set", { photoId, stack: op === "" ? [] : [{ op, params, enabled: true }] });
  const timing = await ui.call("view.render", { viewId });
  return { frame: ui.frame!, timing };
}

const base = (await renderOnly("", {})).frame;
const baseMean = mean(base.pixels);
const baseDetail = detailEnergy(base.pixels);
const baseBars = letterboxShare(base.pixels);
console.log(`  neutral: mean ${baseMean.toFixed(1)}, detail ${baseDetail.toFixed(2)}, bars ${(baseBars * 100).toFixed(1)}%`);

const dehazed = (await renderOnly("dehaze", { value: 80 })).frame;
console.log(`  dehaze +80: mean ${mean(dehazed.pixels).toFixed(1)}, detail ${detailEnergy(dehazed.pixels).toFixed(2)}`);
assert(mean(dehazed.pixels) < baseMean - 2, "dehaze should pull the haze out and darken the frame");
assert(detailEnergy(dehazed.pixels) > baseDetail, "dehaze should raise contrast, not lower it");

const vignetted = (await renderOnly("vignette", { amount: -90 })).frame;
console.log(`  vignette -90: mean ${mean(vignetted.pixels).toFixed(1)}`);
assert(mean(vignetted.pixels) < baseMean - 5, "a negative vignette must darken the frame overall");

const sharpened = (await renderOnly("sharpening", { amount: 150, radius: 1, detail: 60 })).frame;
console.log(`  sharpening 150: detail ${detailEnergy(sharpened.pixels).toFixed(2)}`);
assert(detailEnergy(sharpened.pixels) > baseDetail * 1.1, "sharpening must add high-frequency detail");

const denoised = (await renderOnly("noise_reduction", { luminance: 100, detail: 0 })).frame;
assert(detailEnergy(denoised.pixels) < baseDetail, "noise reduction must take detail away");

const curved = (await renderOnly("tone_curve", { shadows: 100, darks: 60 })).frame;
console.log(`  tone_curve shadows +100: mean ${mean(curved.pixels).toFixed(1)}`);
assert(mean(curved.pixels) > baseMean + 5, "lifting the curve's shadow region must brighten the frame");
const contrasty = (await renderOnly("tone_curve", { rgb: [{ x: 0, y: 0 }, { x: 0.25, y: 0.1 }, { x: 0.75, y: 0.9 }, { x: 1, y: 1 }] })).frame;
assert(detailEnergy(contrasty.pixels) > baseDetail, "an S point curve must add contrast");

// Crop and rotate change the shape of the image inside the view, so the letterbox bars
// grow: the frame stays 1280x720 and the picture inside it does not.
const cropped = await renderOnly("crop", { left: 0.3, top: 0.2, right: 0.7, bottom: 0.5 });
console.log(`  crop: ${cropped.timing.width}x${cropped.timing.height}, bars ${(letterboxShare(cropped.frame.pixels) * 100).toFixed(1)}%`);
assert(cropped.timing.width === 1280 && cropped.timing.height === 720, "the view size does not change with the crop");
// The sample is a portrait frame in a landscape view, so it is already heavily barred;
// a crop that is proportionally wider than the photo fills more of the view, not less.
assert(letterboxShare(cropped.frame.pixels) < baseBars - 0.05, "the crop did not change the image rect inside the view");
const turned = (await renderOnly("rotate", { value: 90 })).frame;
assert(Math.abs(letterboxShare(turned.pixels) - baseBars) > 0.05, "rotating 90 degrees must change the image rect");

// Kelvin white balance warms the frame: more red, less blue than the as-shot neutral.
const warm = (await renderOnly("white_balance", { mode: "kelvin", kelvin: 9000 })).frame;
const warmth = channelMean(warm.pixels, 0) - channelMean(warm.pixels, 2);
const neutralWarmth = channelMean(base.pixels, 0) - channelMean(base.pixels, 2);
console.log(`  white_balance 9000 K: red-blue ${neutralWarmth.toFixed(1)} -> ${warmth.toFixed(1)}`);
assert(warmth > neutralWarmth + 2, "9000 K must warm the picture relative to the 5500 K reference");

// Everything else only has to prove it reaches the pixels at all.
const strongValues: Record<string, Record<string, unknown>> = {
  exposure: { value: 1 },
  contrast: { value: 70 },
  highlights: { value: -80 },
  shadows: { value: 80 },
  whites: { value: 70 },
  blacks: { value: -70 },
  vibrance: { value: 90 },
  saturation: { value: -90 },
  color_mixer: { blueSaturation: -100, redHue: 60 },
  color_grading: { shadowHue: 220, shadowSaturation: 90, highlightHue: 45, highlightSaturation: 70 },
  texture: { value: 100 },
  clarity: { value: 100 },
  grain: { amount: 100 },
  color_noise_reduction: { amount: 100 },
  chromatic_aberration: { enabled: true },
  lens_correction: { distortion: 60, vignetting: 70 },
  defringe: { purpleAmount: 100, purpleHueLow: 0, purpleHueHigh: 100, greenAmount: 100, greenHueLow: 0, greenHueHigh: 100 },
  flip: { horizontal: true },
  transform: { vertical: 50, scale: 120 },
};
for (const [op, params] of Object.entries(strongValues)) {
  const frame = (await renderOnly(op, params)).frame;
  const moved = difference(base.pixels, frame.pixels);
  assert(moved > 0.001, `${op} at ${JSON.stringify(params)} did not change the frame`);
}
console.log(`  ${Object.keys(strongValues).length + 8} ops each moved the frame on their own`);

// Every op at once, at the resolution the UI uses: the frame budget in one number.
const everything = expectedOps.map((op) => ({ op, params: strongValues[op] ?? {}, enabled: true }));
everything.find((entry) => entry.op === "dehaze")!.params = { value: 60 };
everything.find((entry) => entry.op === "sharpening")!.params = { amount: 100, masking: 30 };
everything.find((entry) => entry.op === "noise_reduction")!.params = { luminance: 50 };
everything.find((entry) => entry.op === "tone_curve")!.params = { shadows: 40, highlights: -40 };
everything.find((entry) => entry.op === "white_balance")!.params = { mode: "kelvin", kelvin: 7000 };
everything.find((entry) => entry.op === "vignette")!.params = { amount: -60 };
everything.find((entry) => entry.op === "crop")!.params = { left: 0.05, top: 0.05, right: 0.95, bottom: 0.95 };
everything.find((entry) => entry.op === "rotate")!.params = { value: 0 };
await ui.call("stack.set", { photoId, stack: everything });
let worst = { renderMs: 0, readbackMs: 0 };
for (let i = 0; i < 20; i++) {
  const timing = await ui.call("view.render", { viewId });
  if (timing.renderMs > worst.renderMs) worst = timing;
}
const full = await ui.call("view.render", { viewId });
console.log(`  all ${everything.length} ops at 1280x720: render ${full.renderMs.toFixed(2)} ms, readback ${full.readbackMs.toFixed(2)} ms (worst render ${worst.renderMs.toFixed(2)} ms)`);
assert(full.renderMs + full.readbackMs < 16, `the whole op set must stay inside the 16 ms frame budget, took ${(full.renderMs + full.readbackMs).toFixed(2)} ms`);

// A drag that starts by creating the op: op.add is transient too, so the add and every
// tick of the drag collapse into the one snapshot the committed update takes.
const beforeDrag = await ui.call("stack.get", { photoId });
const dragAdd = await timed("op.add transient", () =>
  ui.call("op.add", { photoId, op: "clarity", params: { value: 10 }, transient: true }),
);
const dragId: string = dragAdd.stack.at(-1).id;
assert(dragAdd.stack.length === beforeDrag.stack.length + 1, "a transient add still puts the op in the stack");
for (const value of [25, 40, 60]) {
  await ui.call("op.update", { photoId, opId: dragId, params: { value }, transient: true });
}
const dragEnd = await ui.call("op.update", { photoId, opId: dragId, params: { value: 75 } });
assert(dragEnd.stack.at(-1).params.value === 75, "the drag should end at the last value");
const afterDragUndo = await timed("history.undo (drag)", () => ui.call("history.undo", { photoId }));
assert(afterDragUndo.stack.length === beforeDrag.stack.length, "one undo must drop the whole drag, the op with it");
assert(!afterDragUndo.stack.some((op: any) => op.id === dragId), "undo left the transiently added op behind");
const afterDragRedo = await timed("history.redo (drag)", () => ui.call("history.redo", { photoId }));
assert(afterDragRedo.stack.at(-1).params.value === 75, "redo must bring the op back at the value the drag ended on");

// Everything above rewrote the stack; hand the rest of the file back the history it had
// before this section — every snapshot undone, then the one exposure op, at its own id.
while ((await ui.call("stack.get", { photoId })).canUndo) await ui.call("history.undo", { photoId });
await ui.call("stack.set", {
  photoId,
  stack: [{ id: opId, op: "exposure", params: { value: 1 }, enabled: true }],
});

const transient = await timed("op.update transient", () =>
  ui.call("op.update", { photoId, opId, params: { value: 2.0 }, transient: true }),
);
assert(transient.stack[0].params.value === 2, "transient update did not apply");

const clamped = await timed("op.update clamp", () =>
  ui.call("op.update", { photoId, opId, params: { value: 99 } }),
);
assert(clamped.stack[0].params.value === 5, "out-of-range exposure should clamp to 5");
const clampLog = ui.notifications.find((n) => n.method === "engine.log" && String(n.params.message).includes("clamped"));
assert(clampLog, "expected an engine.log warning about the clamp");
assert(clampLog.params.photoId === photoId, "engine.log about one photo must carry its photoId");

const undone = await timed("history.undo", () => ui.call("history.undo", { photoId }));
assert(undone.stack.length === 1 && undone.stack[0].params.value === 1, "undo should drop the clamped value");
const empty = await timed("history.undo", () => ui.call("history.undo", { photoId }));
assert(empty.stack.length === 0, "the stack should be empty again");

const state = await timed("stack.get", () => ui.call("stack.get", { photoId }));
assert(state.stack.length === 0, "stack.get disagrees with history.undo");
assert(state.canRedo === true, "canRedo should be true after two undos");
assert(state.histogram && state.histogram.bins === 256, "stack.get should carry a histogram");
const histogramTotal = state.histogram.r.reduce((sum: number, count: number) => sum + count, 0);
console.log(
  `  histogram ${histogramTotal} px, clipped ${state.histogram.clippedShadowsPct.toFixed(2)}% / ${state.histogram.clippedHighlightsPct.toFixed(2)}%`,
);
assert(histogramTotal > 0, "empty histogram");
assert(
  ui.notifications.some((n) => n.method === "stack.changed" && n.params.source === "history"),
  "expected a stack.changed notification from history",
);
assert(
  ui.notifications.some((n) => n.method === "stack.changed" && n.params.source === "load"),
  "expected a stack.changed notification from photo.open",
);

// A second socket sees someone else's edit as `external`, never as its own `ui`.
const observer = await connect(endpoint);
await timed("op.add (two clients)", () => ui.call("op.add", { photoId, op: "vibrance", params: { value: 10 } }));
await waitFor("the observer's stack.changed", () => observer.notifications.some((n) => n.method === "stack.changed"));
const ownEdit = ui.notifications.filter((n) => n.method === "stack.changed").at(-1);
const seenEdit = observer.notifications.filter((n) => n.method === "stack.changed").at(-1);
assert(ownEdit!.params.source === "ui", "the client that made the change must see source ui");
assert(seenEdit!.params.source === "external", "another client must see source external");
assert(seenEdit!.params.revision === ownEdit!.params.revision, "both clients must see the same revision");
assert(ownEdit!.params.client === "ui" && seenEdit!.params.client === "external", "client follows source for a UI edit");
await ui.call("history.undo", { photoId });

// ---- embedded Python ------------------------------------------------------------------
const pythonStarted = performance.now();
const script = await ui.call("python.run", {
  code: "latent.photo.develop.exposure = 1.0\nprint('ops', len(latent.photo.stack))\nlatent.photo.develop.exposure",
});
const pythonMs = performance.now() - pythonStarted;
console.log(`python.run                ${pythonMs.toFixed(1)} ms -> ${JSON.stringify(script)}`);
assert(script.ok === true, `python.run failed: ${script.stderr}`);
assert(script.stdout === "ops 1\n", `python.run did not capture stdout: ${JSON.stringify(script.stdout)}`);
assert(script.value === "1.0", "python.run should return the repr of the last expression");

assert(typeof script.durationMs === "number" && script.durationMs > 0, `python.run must report durationMs, got ${script.durationMs}`);

const fromPython = ui.notifications.filter((n) => n.method === "stack.changed" && n.params.source === "python");
assert(fromPython.length > 0, "a script's edit must notify with source python");
assert(fromPython.at(-1)!.params.client === "python", "a script's edit is client python");
assert(fromPython.at(-1)!.params.stack.some((op: any) => op.op === "exposure"), "develop.exposure did not create an exposure op");
assert(
  observer.notifications.some((n) => n.method === "stack.changed" && n.params.source === "python"),
  "every client sees a script's edit as python, not external",
);

await timed("view.render (scripted)", () => ui.call("view.render", { viewId }));
const brightScripted = mean(ui.frame!.pixels);
console.log(`  mean level ${brightNeutral.toFixed(1)} -> ${brightScripted.toFixed(1)} after the script`);
assert(brightScripted > brightNeutral + 5, "the scripted exposure did not brighten the frame");

const repeat = await ui.call("python.run", {
  code: "latent.photo.develop.exposure += 0.5\nprint(len(latent.photo.stack_json()))",
});
assert(repeat.ok === true, `python.run += failed: ${repeat.stderr}`);
assert(repeat.stdout.trim() === "1", "+= must edit the same op, not add one");

// One script exercises the whole stack surface and reports it as JSON on stdout.
const scripted = await ui.call("python.run", {
  code: [
    "import json",
    "p = latent.photo",
    "op = p.stack.add('vibrance', value=25)",
    "op.params['value'] = 30",
    "op.enabled = False",
    "preset = p.stack.preset(['exposure'])",
    "print(json.dumps([len(p.stack), op.op, op.params['value'], op.enabled, len(preset),",
    "                  p.histogram()['bins'], len(latent.render.preview(max=256)), p.stack[-1].id == op.id]))",
  ].join("\n"),
  photoId,
});
assert(scripted.ok === true, `stack API script failed: ${scripted.stderr}`);
console.log(`  stack API -> ${scripted.stdout.trim()}`);
const scriptedValues = JSON.parse(scripted.stdout);
assert(scriptedValues[0] === 2 && scriptedValues[1] === "vibrance", "stack.add did not add one op");
assert(scriptedValues[2] === 30.0 && scriptedValues[3] === false, "op.params/op.enabled writes did not stick");
assert(scriptedValues[4] === 1 && scriptedValues[5] === 256, "preset/histogram came back wrong");
assert(scriptedValues[6] > 1000, "render.preview should return a real JPEG");
assert(scriptedValues[7] === true, "indexing the stack should find the op that was just added");

// Each of the three writes above was its own snapshot, so undo walks back one at a time.
const undoneByScript = await ui.call("python.run", {
  code: "latent.undo()\nprint(latent.photo.stack[-1].enabled, len(latent.photo.stack))",
});
assert(undoneByScript.stdout.trim() === "True 2", `latent.undo() did not undo the disable: ${undoneByScript.stdout}`);
const rewound = await ui.call("python.run", { code: "latent.undo()\nlatent.undo()\nprint(len(latent.photo.stack))" });
assert(rewound.stdout.trim() === "1", `two more undos should drop the vibrance op: ${rewound.stdout}`);

// Output streams to the calling socket while the script runs; the result repeats it whole.
const streamed = await ui.call("python.run", { code: "print('first')\nprint('second')" });
const chunks = ui.notifications.filter((n) => n.method === "python.output" && n.params.runId === streamed.runId);
console.log(`  python.output ${chunks.length} chunk(s) for run ${streamed.runId}`);
assert(typeof streamed.runId === "number", "python.run must report a runId when it streams");
assert(chunks.length >= 2, "expected one python.output per print");
assert(chunks.every((n) => n.params.stream === "stdout"), "prints belong on stdout");
assert(chunks.map((n) => n.params.text).join("") === streamed.stdout, "the stream and the result disagree");

// python.finished closes the stream: after the run's last chunk, before the result — it is
// already in the log now, and nothing of that run follows it.
const finishedIndex = ui.notifications.findIndex((n) => n.method === "python.finished" && n.params.runId === streamed.runId);
const lastChunkIndex = ui.notifications.map((n) => n.method === "python.output" && n.params.runId === streamed.runId).lastIndexOf(true);
const finishedRun = ui.notifications[finishedIndex]!;
console.log(`  python.finished after ${finishedIndex - lastChunkIndex} notification(s): ${JSON.stringify(finishedRun.params)}`);
assert(finishedIndex > lastChunkIndex, "python.finished must follow the run's last python.output");
assert(finishedRun.params.ok === true, "a successful run must report ok in python.finished");
assert(finishedRun.params.durationMs === streamed.durationMs, "python.finished and the result must report the same duration");
assert(typeof streamed.durationMs === "number", "python.run must report durationMs");

const interrupted = await timed("python.run (timeout)", () =>
  ui.call("python.run", { code: "while True:\n    pass", timeoutMs: 250 }),
);
assert(interrupted.ok === false, "a script over its budget must fail");
assert(interrupted.stderr.includes("KeyboardInterrupt"), `expected a KeyboardInterrupt, got ${interrupted.stderr}`);
const interruptedEnd = ui.notifications.find((n) => n.method === "python.finished" && n.params.runId === interrupted.runId)!;
assert(interruptedEnd && interruptedEnd.params.ok === false, "an interrupted run must still announce python.finished, with ok false");
assert(interruptedEnd.params.durationMs >= 200, `the interrupted run should have burned its budget, got ${interruptedEnd.params.durationMs} ms`);
const alive = await ui.call("python.run", { code: "1 + 1" });
assert(alive.ok === true && alive.value === "2", "the interpreter must survive an interrupted script");

const enumerated = await ui.call("python.run", {
  code: "print([p.id for p in latent.photos()], [p.id for p in latent.catalog.selected()], latent.photo.filename)",
});
assert(enumerated.stdout.trim() === `[${photoId}] [${photoId}] DSC00120.ARW`, `photo enumeration is wrong: ${enumerated.stdout}`);

const broken = await ui.call("python.run", { code: "latent.photo.develop.nonsense = 1" });
assert(broken.ok === false, "a failing script must report ok: false");
assert(broken.stderr.includes("Traceback"), "a failing script must return its traceback in stderr");

// ---- MCP over streamable HTTP ----------------------------------------------------------
const mcpUrl = await engine.mcpUrl;
assert(mcpUrl === hello.mcpUrl, `engine.hello's mcpUrl must be the announced one: ${hello.mcpUrl} vs ${mcpUrl}`);
const portFile = `${scratch}/config/latent/mcp.port`;
assert(existsSync(portFile), `the daemon must write its MCP port to ${portFile}`);
assert(mcpUrl.includes((await Bun.file(portFile).text()).trim()), "mcp.port must match the announced port");

let mcpSession = "";
async function mcp(body: unknown): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (mcpSession) headers["Mcp-Session-Id"] = mcpSession;
  const response = await fetch(mcpUrl, { method: "POST", headers, body: JSON.stringify(body) });
  mcpSession = response.headers.get("mcp-session-id") ?? mcpSession;
  const text = await response.text();
  const line = text.split("\n").find((part) => part.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : null;
}

const initialized = await timed("mcp initialize", () =>
  mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
  }),
);
assert(initialized.result.serverInfo.name === "latent", "the MCP server should identify as latent");
await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });

const toolList = await timed("mcp tools/list", () => mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
const toolNames = toolList.result.tools.map((tool: { name: string }) => tool.name).sort();
console.log(`  tools: ${toolNames.join(", ")}`);
assert(JSON.stringify(toolNames) === JSON.stringify(["get_stack", "list_photos", "render_preview", "run_python"]), "wrong MCP tool set");

const beforeAgent = mean(ui.frame!.pixels);
const agentRun = await timed("mcp run_python", () =>
  mcp({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "run_python", arguments: { code: "latent.photo.develop.exposure = 2.5\nlatent.photo.develop.exposure", photo_id: photoId } },
  }),
);
assert(agentRun.result.structuredContent.ok === true, `agent script failed: ${JSON.stringify(agentRun.result)}`);
assert(agentRun.result.structuredContent.value === "2.5", "agent script returned the wrong value");
await waitFor("stack.changed from mcp", () =>
  ui.notifications.some((n) => n.method === "stack.changed" && n.params.source === "mcp"),
);
const fromAgent = ui.notifications.filter((n) => n.method === "stack.changed" && n.params.source === "mcp").at(-1)!;
console.log(`  stack.changed source=${fromAgent.params.source} client=${fromAgent.params.client} received by the UI socket`);
assert(fromAgent.params.client === "mcp:run_python", `an agent's edit must name its tool, got ${fromAgent.params.client}`);

await timed("view.render (agent)", () => ui.call("view.render", { viewId }));
const brightAgent = mean(ui.frame!.pixels);
console.log(`  mean level ${beforeAgent.toFixed(1)} -> ${brightAgent.toFixed(1)} after the agent's edit`);
assert(brightAgent > beforeAgent + 5, "the agent's exposure did not brighten the frame");

const agentStack = await timed("mcp get_stack", () =>
  mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_stack", arguments: { photo_id: photoId } } }),
);
const agentState = agentStack.result.structuredContent;
assert(agentState.histogram.bins === 256, "get_stack must always carry a histogram");
assert(typeof agentState.clipping.highlightsPct === "number", "get_stack must carry clipping percentages");
assert(agentState.stack.some((op: any) => op.op === "exposure"), "get_stack lost the exposure op");

const preview = await timed("mcp render_preview", () =>
  mcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "render_preview", arguments: { max_size: 512 } } }),
);
const image = preview.result.content[0];
assert(image.type === "image" && image.mimeType === "image/jpeg", "render_preview must return a JPEG image block");
const jpeg = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
assert(jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[2] === 0xff, "render_preview did not return JPEG bytes");
console.log(`  preview ${jpeg.length} bytes of JPEG`);

const listed = await timed("mcp list_photos", () =>
  mcp({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_photos", arguments: {} } }),
);
assert(JSON.parse(listed.result.content[0].text).photoId === photoId, "list_photos should show the open photo");

// ---- catalog --------------------------------------------------------------------------
const importStarted = performance.now();
const job = await timed("catalog.import", () => ui.call("catalog.import", { paths: ["/home/moritz/Downloads"], recursive: false }));
assert(job.jobId >= 1, "catalog.import must return a jobId");
assert(job.thumbnailJobId > job.jobId, "catalog.import must name the thumbnail job it queues");
await waitFor("the import job to finish", () =>
  ui.notifications.some((n) => n.method === "job.progress" && n.params.jobId === job.jobId && n.params.finished),
);
const importDone = ui.notifications.find((n) => n.method === "job.progress" && n.params.jobId === job.jobId && n.params.finished)!;
const importMs = performance.now() - importStarted;
console.log(`  imported ${importDone.params.done}/${importDone.params.total} files in ${importMs.toFixed(0)} ms (${importDone.params.message})`);
assert(importDone.params.kind === "import", "the job must report kind import");
assert(importDone.params.parentJobId === undefined, "an import job has no parent");
assert(
  ui.notifications.some((n) => n.method === "catalog.changed" && n.params.reason === "import"),
  "an import must end with catalog.changed",
);

// The thumbnail job the import promised: it reports under its own id and names its parent.
await waitFor("the thumbnail job to finish", () =>
  ui.notifications.some((n) => n.method === "job.progress" && n.params.jobId === job.thumbnailJobId && n.params.finished),
);
const thumbnailsDone = ui.notifications.find((n) => n.method === "job.progress" && n.params.jobId === job.thumbnailJobId && n.params.finished)!;
console.log(`  thumbnail job ${job.thumbnailJobId} (parent ${thumbnailsDone.params.parentJobId}): ${thumbnailsDone.params.done}/${thumbnailsDone.params.total} ${thumbnailsDone.params.state}`);
assert(thumbnailsDone.params.kind === "thumbnails", "the queued job must report kind thumbnails");
assert(thumbnailsDone.params.parentJobId === job.jobId, "the thumbnail job must name the import that queued it");

const catalogList = await timed("catalog.list", () => ui.call("catalog.list", { sort: "filename", limit: 50 }));
console.log(`  catalog holds ${catalogList.total} photo(s): ${catalogList.photos.map((p: any) => p.filename).join(", ")}`);
assert(catalogList.total >= 1, "the import registered nothing");
const row = catalogList.photos.find((p: any) => p.path === samplePath);
assert(row, "the sample raw is not in the catalog");
assert(row.photoId === photoId, "photo.open and catalog.import must agree on the id");
assert(row.camera.includes("Sony") && row.width > 0 && row.hasSidecar === true, "catalog metadata is wrong");
assert(typeof row.editedAt === "string", "editedAt must be stamped by the edits above");

const folders = await timed("catalog.folders", () => ui.call("catalog.folders"));
assert(folders.folders.some((f: any) => f.path === "/home/moritz/Downloads" && f.count >= 1), "catalog.folders missed the folder");

const thumbStarted = performance.now();
const thumb = await timed("catalog.thumbnail", () => ui.call("catalog.thumbnail", { photoId, size: 256 }));
const thumbMs = performance.now() - thumbStarted;
await waitFor("the LTHM frame", () => ui.thumbnails.length > 0);
const thumbnailFrame = ui.thumbnails.at(-1)!;
console.log(`  thumbnail ${thumb.width}x${thumb.height} in ${thumbMs.toFixed(0)} ms, ${thumbnailFrame.pixels.length} JPEG bytes`);
assert(thumbnailFrame.target === photoId, "the LTHM frame must be tagged with the photoId");
assert(Math.max(thumb.width, thumb.height) === 256, "the thumbnail long edge must be the requested size");
assert(
  thumbnailFrame.pixels[0] === 0xff && thumbnailFrame.pixels[1] === 0xd8 && thumbnailFrame.pixels[2] === 0xff,
  "the LTHM payload is not a JPEG",
);

// 512 was never queued by the import job, so this one is generated on the worker thread
// and the frame arrives when it is ready.
const uncachedStarted = performance.now();
const bigger = await timed("catalog.thumbnail (miss)", () => ui.call("catalog.thumbnail", { photoId, size: 512 }));
console.log(`  generated ${bigger.width}x${bigger.height} in ${(performance.now() - uncachedStarted).toFixed(0)} ms`);
await waitFor("the second LTHM frame", () => ui.thumbnails.length > 1);
assert(Math.max(bigger.width, bigger.height) === 512, "the generated thumbnail is the wrong size");
assert(ui.thumbnails.at(-1)!.pixels[0] === 0xff, "the generated thumbnail is not a JPEG");

// The batch form: one frame per photo, all of them before the result.
const batchBefore = ui.thumbnails.length;
const batchIds = [...catalogList.photos.map((p: any) => p.photoId), 99999];
const batch = await timed("catalog.thumbnails", () => ui.call("catalog.thumbnails", { photoIds: batchIds, size: 320 }));
console.log(`  batch requested ${batch.requested}, sent ${batch.sent}, missing ${JSON.stringify(batch.missing)}`);
assert(batch.requested === batchIds.length, "catalog.thumbnails should count the ids it was given");
assert(batch.missing.includes(99999), "an unknown id belongs in missing, not in an error");
assert(ui.thumbnails.length - batchBefore === batch.sent, "every counted thumbnail must have arrived as a frame");

const listed2 = await ui.call("catalog.list", { query: "dsc001" });
assert(listed2.total === 1 && listed2.photos[0].filename === "DSC00120.ARW", "catalog.list query did not match");
const byIds = await ui.call("catalog.list", { photoIds: [photoId] });
assert(byIds.total === 1 && byIds.photos[0].photoId === photoId, "catalog.list photoIds did not filter");
assert((await ui.call("catalog.list", { photoIds: [] })).total === 0, "an empty photoIds list asks for nothing");

assert((await ui.call("job.cancel", { jobId: job.jobId })).cancelled === false, "a finished job cannot be cancelled");

const rated = await timed("catalog.setRating", () => ui.call("catalog.setRating", { photoId, rating: 4 }));
assert(rated.rating === 4, "catalog.setRating did not stick");
await waitFor("catalog.changed for the rating", () =>
  ui.notifications.some((n) => n.method === "catalog.changed" && n.params.reason === "rating"),
);
const flagged = await timed("catalog.setFlag", () => ui.call("catalog.setFlag", { photoId, flag: "pick" }));
assert(flagged.flag === "pick", "catalog.setFlag did not stick");

const collections = await timed("catalog.collectionSet", () => ui.call("catalog.collectionSet", { name: "Smoke", add: [photoId] }));
assert(collections.collections.some((c: any) => c.name === "Smoke" && c.count === 1), "the collection was not created");
const collectionId = collections.collections.find((c: any) => c.name === "Smoke").collectionId;
const inCollection = await ui.call("catalog.list", { collectionId });
assert(inCollection.total === 1, "catalog.list did not filter by collection");
await ui.call("catalog.collectionSet", { collectionId, delete: true });
assert((await ui.call("catalog.collections")).collections.length === 0, "the collection was not deleted");

// catalog.remove drops rows, never files.
const strays = catalogList.photos.filter((p: any) => p.photoId !== photoId).map((p: any) => p.photoId);
const removal = await timed("catalog.remove", () => ui.call("catalog.remove", { photoIds: [...strays, 99999] }));
console.log(`  removed ${removal.removed} row(s)`);
assert(removal.removed === strays.length, "catalog.remove counted the wrong number of rows");
assert(
  strays.length === 0 || ui.notifications.some((n) => n.method === "catalog.changed" && n.params.reason === "remove"),
  "catalog.remove must publish catalog.changed",
);
assert(existsSync(samplePath), "catalog.remove must never touch a file on disk");
assert((await ui.call("catalog.list", {})).total === catalogList.total - strays.length, "the rows are still listed");

// ---- errors ---------------------------------------------------------------------------
const badOp = await ui.fail("op.add", { photoId, op: "lens_blur", params: {} });
assert(badOp.startsWith("-32602"), `unknown op should be invalid params, got ${badOp}`);

const badId = await ui.fail("stack.get", { photoId: 999 });
assert(badId.startsWith("-32602"), `unknown photoId should be invalid params, got ${badId}`);

// An id that does not fit LTHM's u32 target is refused; a truncated frame would be worse.
const framesBefore = ui.thumbnails.length;
const hugeId = 0x1_0000_0000;
const hugeSingle = await ui.fail("catalog.thumbnail", { photoId: hugeId });
const hugeBatch = await ui.fail("catalog.thumbnails", { photoIds: [photoId, hugeId] });
console.log(`  thumbnail cap: ${hugeSingle}`);
assert(hugeSingle.startsWith("-32602") && hugeSingle.includes("4294967295"), `an id over the frame limit must be -32602, got ${hugeSingle}`);
assert(hugeBatch.startsWith("-32602"), `the batch must refuse an unrepresentable id, got ${hugeBatch}`);
assert(ui.thumbnails.length === framesBefore, "a refused thumbnail request must send no frame");

for (const notification of ["stack.changed", "engine.log", "catalog.changed", "job.progress", "python.output", "python.finished"]) {
  const called = await ui.fail(notification, {});
  assert(called.startsWith("-32601"), `${notification} as a method should be -32601, got ${called}`);
}

// stack.set is the script/agent write path; it takes ids the caller invented.
const replaced = await timed("stack.set", () =>
  ui.call("stack.set", {
    photoId,
    stack: [
      { id: "cafe0001", op: "white_balance", params: { temperature: 20, tint: -5 }, enabled: true },
      { id: "cafe0002", op: "vibrance", params: { value: 30 }, enabled: true },
    ],
  }),
);
assert(replaced.stack.length === 2, "stack.set did not replace the stack");
assert(replaced.stack[0].op === "white_balance" && replaced.stack[1].op === "vibrance", "stack.set reordered");
await timed("view.render (wb+vib)", () => ui.call("view.render", { viewId }));

const shortened = await timed("op.remove", () => ui.call("op.remove", { photoId, opId: "cafe0001" }));
assert(shortened.stack.length === 1 && shortened.stack[0].id === "cafe0002", "op.remove removed the wrong op");

// Close and reopen: the stack must come back from the sidecar, not from memory.
await timed("view.close", () => ui.call("view.close", { viewId }));
await timed("photo.close", () => ui.call("photo.close", { photoId }));
const reopened = await timed("photo.open (sidecar)", () => ui.call("photo.open", { path: samplePath }));
assert(reopened.photoId === photoId, "the catalog id must be stable across close and open");
assert(reopened.sidecarLoaded === true, "reopening must report that the sidecar was restored");
photoId = reopened.photoId;
const restored = await timed("stack.get (sidecar)", () => ui.call("stack.get", { photoId }));
assert(restored.stack.length === 1, "the sidecar stack did not come back");
assert(restored.stack[0].id === "cafe0002", "the sidecar lost the op id");
assert(restored.stack[0].params.value === 30, "the sidecar lost the vibrance value");
assert(restored.canUndo === false, "a freshly loaded stack has nothing to undo");
assert(restored.histogram === undefined, "no view has rendered this photo yet");

await timed("photo.close", () => ui.call("photo.close", { photoId }));
observer.close();
ui.close();

engine.process.kill("SIGTERM");
const exitCode = await engine.process.exited;
console.log(`latentd exited with ${exitCode} after SIGTERM`);
assert(exitCode === 0, `latentd should exit 0, got ${exitCode}`);
assert(!existsSync(portFile), "the daemon must remove its mcp.port file on the way out");
rmSync(scratch, { recursive: true, force: true });
console.log(`smoke: ok in ${(performance.now() - started).toFixed(0)} ms`);
