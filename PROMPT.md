# Latent — project brief

> A GPU-accelerated, agent-steerable raw photo editor for Linux. Lightroom's workflow,
> an op-stack instead of a slider panel, a C++ engine daemon, and an MCP server as the native API.

This file is the handoff brief. Read it fully before writing code. Nothing has been
built yet — this is greenfield as of 2026-09-16. Decisions below were made with the owner;
do not reopen them without a concrete reason.

---

## 1. Why this exists

The owner (Moritz, Linux/CachyOS, RTX 4080 SUPER 16 GB) wants a Lightroom replacement and
has rejected the existing options for concrete reasons. Do not re-litigate these:

| Option | Rejected because |
|---|---|
| darktable | UI is cumbersome (module soup), zero AI tooling |
| RawTherapee / ART | No catalog, no AI, no scripting for live edits |
| digiKam | Weak raw dev and local adjustments; has AI but no generative fill |
| Lightroom (browser) | Is Lightroom, but cloud-only catalog, no plugins, no scripting hook |
| Lightroom Classic in a GPU-passthrough VM | Works, and is scriptable via the Lua SDK's `LrSocket`, but needs a second GPU, an Adobe subscription, and VFIO config |
| Ansel (darktable fork that fixes the UI) | Worth checking as a fallback; keeps darktable's Lua API. Not yet evaluated by the owner |
| GIMP/Krita + MCP bridge | Rejected: the owner wants one application, not a toolchain |

The requirement that kills every existing option is the combination of:
**one app** + **Lightroom-grade workflow** + **natural-language steering** + **hand editing
with masks and generative fill**. Nothing on Linux offers all four.

## 2. What it must do

1. **Catalog** — import, browse, filmstrip, collections, ratings, metadata. SQLite-backed.
2. **Raw develop** — non-destructive, GPU, 16-bit float pipeline. Exposure, white balance,
   contrast, tone curve, colour, etc.
3. **Masking** — brush, gradient, radial, AI subject/sky/object selection (SAM 2), and
   text-prompted selection ("the cat") for scripts. Mask math (add/subtract/intersect).
4. **Generative fill** — inpaint a masked region via ComfyUI, result lands as an editable op.
5. **Agent steering** — describe an edit in natural language; an MCP client mutates the
   op-stack; the GUI updates live. The user then tweaks by hand.

Point 5 is the differentiator. It is not a bolt-on.

## 3. Core architectural decision: the op-stack

**Edits are an ordered JSON list of operations.** Each op is
`{ id, op, params, mask?, enabled }`. The rendered image is the source raw with the
stack applied in order. Nothing else stores edit state.

This single decision buys:

- GUI sliders write ops.
- MCP tools write ops — *the same surface*, no parallel codepath.
- Presets are a subarray.
- The agent can **read** the stack, so "undo that last thing but keep the mask" works.
- Sidecars are plain JSON: `photo.raf.latent`. Version them with git if you want.

**The op-stack lives in the engine. The UI is a view.** The UI never holds edit state, never
mutates GPU state, never keeps a shadow copy. UI → message → engine → op-stack → render →
frame → UI, always. If you find yourself adding a second source of truth, stop and redesign.

### 3.1 Op vocabulary mirrors Lightroom

Op names, parameter names, and ranges follow Lightroom's Edit panels 1:1. The scraped Adobe
documentation in `reference/lightroom/` **is the op spec**; `reference/lightroom/README.md`
has the consolidated control table (~122 rows). Reasons: the agent already knows Lightroom
semantics, presets and XMP map directly, and the owner's muscle memory transfers.

Panels → op families: Light, Color, Effects, Detail, Optics, Geometry, plus Masking (which
attaches to ops rather than being one) and Remove/Generative (Phase 2).

### 3.2 History is snapshots, not pops

The agent edits mid-stack ("bump op 3's exposure"), so undo cannot be "pop the last op".
The stack is an immutable value; the engine keeps a history array of stack snapshots plus a
cursor. Undo/redo move the cursor. Every mutation — slider, script, preset — appends a
snapshot. Structural sharing keeps this cheap. In-memory only in Phase 0; persisted history
is Phase 3.

### 3.3 Sidecar format

`photo.raf.latent` is JSON: `{ version, source: { path, hash }, stack }`. Parametric masks
(brush strokes, gradients, radials) live inline as their parameters. Raster masks (SAM 2
output, painted masks after flattening) and generative results go as PNG in a sibling
directory `photo.raf.latent.d/`, referenced by filename. The engine is the only writer.

### 3.4 The scripting API is the agent surface

Blender's model: the agent does not get twenty fine-grained tools, it gets `execute_code` and
the same API the UI uses. Latent does the same. **One `latent` Python module**, implemented
in C++ via pybind11 inside the engine, exposed to:

- the MCP tool `run_python(code)` — the only write path for agents
- an in-app Python console pane (UI sends code over the wire, engine runs it)
- saved "actions": scripts stored as macros, runnable from the UI

CPython is **embedded in the engine** (pybind11). Scripts run in-process against the
op-stack — no IPC hop, real numpy, no browser sandbox. The **MCP server is the official
Python MCP SDK running inside that embedded interpreter** (streamable HTTP on
`127.0.0.1:<port>`, plus a `latent mcp` stdio shim for clients that only speak stdio). There
is no C++ MCP SDK and none is needed.

Two views of the same truth:

```python
p = latent.photo                        # current photo
p.develop.exposure = 0.7                # sugar: find-or-create the exposure op, set its param
p.develop.temperature += 300
op = p.stack.add("clarity", amount=20, mask=latent.masks.detect("cat"))
p.stack[2].enabled = False              # explicit op list — the truth
latent.undo()
for photo in latent.catalog.selected():
    photo.stack.apply(p.stack.preset(["exposure", "temperature"]))
latent.render.preview(max=1024)         # image back to the agent
```

`photo.stack` is the op list. `photo.develop.*` is Lightroom-flat sugar that resolves to a
stack mutation — it never bypasses the stack, and setting a property that already has a
masked op targets the unmasked base op. Every script run is one history snapshot.

MCP tools: `run_python`, `get_stack`, `render_preview`, `list_photos`. Reads are structured;
writes are scripts. No `add_op`/`update_op` tools — one write path.

What the agent sees: `get_stack` returns the stack plus histogram statistics and clipping
percentages, always. `render_preview(max=1024, region?)` returns a JPEG only when asked.
Script results never auto-attach images.

**There is no in-app agent.** The agent is an external MCP client (Claude Code or any other)
talking to the running engine. Latent ships no chat pane and no LLM SDK.

### 3.5 Generative ops — "add a hat to that cat"

A generative op is a **cached raster**, not a formula. It stores the params that produced it
and the result pixels; it cannot be recomputed on the fly.

```
{ op: "generative_fill", params: { backend, model, prompt, seed }, mask, result: "<opId>.png", inputHash, resultRect }
```

`resultRect` is where the crop came from, in image pixels snapped to 8; the composite
needs it and cannot recompute it from a mask that may have moved since. Built 2026-09-16
(`engine/src/generative/`, `composite.wgsl`, `engine/workflows/`): `generative_fill` and
`remove` sit at `PipelineStage::Generative`, so "below" means every op under that stage
regardless of stack order — a tone or colour edit never marks a fill stale and applies to
the patch; crop, noise reduction and optics edits do. ComfyUI ran end to end with SDXL
inpaint; the Flux Fill graph is wired and switches on when its weights land.

Backends implement one C++ interface:
`GenerativeBackend::inpaint({ image, mask, prompt, model, seed }) → PNG bytes`. ComfyUI is
the first and default implementation. A hosted API (BFL Flux Fill, Gemini image edit) is a
second implementation later — no-VRAM path — and needs no change to ops, staleness, crop or
compositing. Rejected as *primary*: diffusers subprocess (rebuilds Comfy's model/VRAM
management, ships torch), `stable-diffusion.cpp` (thin inpaint support, quality gap).

Flow, in order:

1. **Region.** Interactive: click/box → SAM 2. Agent: text → box via Florence-2 (open-vocab
   detection, ONNX) → SAM 2. `latent.masks.detect("cat")`. SAM 2 has no text input; the
   detector in front is what makes "that cat" work from a script.
2. **Op added** at the end of the stack by default. Movable like any op.
3. **Input render.** Engine renders the stack *below* the op, crops the mask bbox plus
   padding, downscales to ≤1536 px long edge, converts to display sRGB 8-bit (what Flux Fill /
   Qwen-Image-Edit expect). Mask cropped identically.
4. **Backend.** ComfyUI executes graphs, nothing else, so Latent ships the graphs:
   - *Design-time, checked in.* One API-format graph per task in `engine/workflows/`:
     `inpaint-flux-fill`, `inpaint-qwen-edit`, `remove`, `upscale`, `denoise`. Built from a
     ComfyUI template via `comfy workflow decompose` → fragment → blueprint YAML → `comfy
     workflow compose` → `<task>.compiled.json`. Flux Fill graph: `LoadImage(crop)` +
     `LoadImage(mask)` → `InpaintModelConditioning` ← `UNETLoader` + `DualCLIPLoader` +
     `VAELoader` + `CLIPTextEncode(prompt)` → `KSampler(seed)` → `VAEDecode` → `SaveImage`.
   - *Run-time, per op.* (1) write `crop.png` + `mask.png` to a temp dir; (2) `comfy upload`
     both — server input dir, local or cloud; (3) substitute the graph's variable inputs by
     node id — image, mask, prompt, seed, model — the compiled file is a template, never
     edited on disk; (4) `comfy --json run --workflow <filled> --wait --no-watch`, consume
     NDJSON (`queued`, `progress`, `executed`, final `envelope`), forward progress to the UI,
     map error codes (`server_not_running`, `node_not_found`, `cloud_unauthorized`) to
     user-facing states; (5) fetch the output PNG, store it, set `result`.
   - *First run.* `comfy --json system-stats` + `models list` confirm server and weights; if
     missing, point at `comfy model download` rather than failing silently.
   The engine never touches ComfyUI's HTTP API directly; the CLI owns transport, routing,
   auth, errors. The global `~/.claude/skills/comfy` skill documents the CLI.
5. **Result stored** as PNG in `photo.raf.latent.d/`, op gets `result`. Engine uploads it,
   linearises sRGB → Rec.2020, and a composite pass does `mix(below, result, feather(mask))`
   at the op's position. Ops above still apply to the generated pixels.
6. **Staleness.** `inputHash` is the hash of the sub-stack below the op. If it no longer
   matches, the op renders with a stale badge. Re-run is always explicit — never automatic.

Same mechanics for Remove, denoise and upscale: model-produced rasters with an input hash,
one graph each. VRAM: Flux Fill fp8 ≈ 12 GB next to the engine's textures on one 16 GB card
is tight; ComfyUI unloads between jobs, or the CLI routes to cloud.

### 3.6 Export

The engine renders full-res with the same passes as the preview — pixel-identical by
construction — reads back, and encodes in-process: JPEG (libjpeg-turbo), 16-bit TIFF
(libtiff), AVIF 10-bit (libavif + aom), 16-bit PNG (libpng). Resize happens in linear
space on the GPU before the display transform; output sharpening (screen / matte / glossy)
is the last pass. Output profile per export (sRGB, Display P3, AdobeRGB, Rec.2020,
ProPhoto): matrix + OETF in the final GPU pass (`export.wgsl`), so the readback is already
in the target space; the ICC embedded via lcms2 is built from the same primaries. Built
2026-09-16: `export.run` job, `latent.export`, MCP `export`; 24 MP JPEG 353 ms, TIFF16
1.5 s, AVIF 4.2 s. Not yet: tiled export above `maxTextureDimension2D`, EXIF/IPTC,
export presets. Batch export is an engine job queue; the UI shows
progress and stays responsive because the engine is a separate process. DNG export is
Phase 3.

### 3.7 Masks and layers

There are no pixel layers. A **layer** in the UI is one op of the stack with a mask,
`opacity` and `enabled`. The stack already is the layer stack: ordered, reorderable,
toggleable, each entry with its own mask. Luminar's layer list and Lightroom's masking panel
are two views over the same data.

**Mask model.** `Op.mask` is optional. A mask is a list of components combined top-down:

```json
{
  "components": [
    { "id": "m1", "kind": "subject", "mode": "add", "invert": false, "feather": 0, "opacity": 100 },
    { "id": "m2", "kind": "luminance", "mode": "intersect", "range": [0.4, 1.0], "smoothness": 0.1 },
    { "id": "m3", "kind": "brush", "mode": "subtract", "strokes": "brush/m3.bin", "size": 40, "flow": 80 }
  ]
}
```

Component kinds, mirroring Lightroom's Masking panel (`reference/lightroom/masking.md`):
`subject`, `sky`, `background`, `objects` (box or brush hint → SAM 2), `people` (per person,
parts later), `text` (prompt → Florence-2 box → SAM 2), `brush` (strokes with size/feather/
flow, erase), `linear` (two points + feather), `radial` (centre, radii, angle, feather,
invert), `luminance` (range + smoothness), `color` (sampled colours + range), `depth`
(Phase 2). `mode` ∈ `add | subtract | intersect`. Every component has `invert`, `feather`,
`opacity`.

**Coordinates are image space.** Every component coordinate — linear points, radial
centre and radii, brush points and size, object boxes — is normalised 0..1 over the
uncropped decoded photo, never over the cropped view, so a mask painted on a subject stays
on it through crop, straighten, rotate, flip and Transform. The geometry stage is one
matrix (`engine/src/ops/geometry.{h,cpp}`); `mask.wgsl` carries each view pixel back
through it before evaluating a shape, brush/AI rasters are stored at image-proxy size and
sampled through it, and `mask.detect` sees a geometry-bypassed render of the sub-stack
below the op. `mask.preview` still answers a view-space raster; `view.render` and
`mask.preview` carry `imageTransform` (3×3, image-normalised → view pixel) so the overlay
converts both ways. Sidecars written before this (`Mask.space` absent) are migrated at load.

**Rasters live in the engine.** Each component rasterises to an `r8unorm` texture at proxy
and at full res, cached under `photo.raf.latent.d/masks/<componentId>.<hash>.png` where
`hash` covers the component params, the geometry stage and, for AI kinds, the model id and
the source hash.
Combining components is a compute pass; the combined mask is what the op's pass samples.
An op with a mask runs as `out = mix(in, op(in), mask * opacity)`. AI components are jobs
(`job.progress`), never inline in a slider tick; until a job lands the component contributes
nothing and the UI shows it pending. Stale ≠ auto re-run, same rule as generative ops.

**Protocol.** `op.update` accepts the full `mask`; `mask.preview { photoId, opId,
componentId? }` returns an `LMSK` binary frame (r8, proxy size) for the overlay; `mask.detect
{ photoId, kind, hint }` starts the AI job and returns `jobId`; brush strokes go up as
`mask.stroke { photoId, opId, componentId, points, erase }` appended incrementally and
persisted by the engine, never as a raster from the UI. `ops.describe` marks which ops are
maskable (all develop ops; not geometry).

**UI.** A Masks rail mode: mask list per op, component list per mask, overlay in the viewer
(red tint, `O` toggles, `Shift+O` cycles overlay style), brush/gradient tools drawn in the
viewer, local-adjustment sliders reuse the generated panels with the op's mask selected.
A Layers rail mode: the stack top-down, one row per op with mask thumbnail, eye, opacity,
drag to reorder, duplicate, delete. Selecting a row selects its op in the Edit column.

**Python.** `photo.stack[i].mask.add("subject")`, `.add("brush").stroke(points)`,
`masks.detect("the dog")`, `op.opacity = 60`. MCP tool `render_preview` accepts `mask=` to
return the raster as an image block so an agent can check what it selected.

## 4. Stack

**A C++ engine daemon owns everything that touches pixels, state, or the agent. Electron is a
thin client.** The owner cannot read or write Rust; native code is C++. Tauri was rejected
(Rust backend, and laggy on Linux). Electron's earlier justification — WebGPU in the
window — no longer applies; it stays because Chromium's canvas path is fast and the daemon
model wants a client that is nothing but UI.

| Layer | Use | Do not |
|---|---|---|
| Engine language | C++20, CMake + Ninja, clang, clang-format, clang-tidy, Catch2 | Rust, C++ < 20 |
| Engine deps | **vcpkg manifest** (`engine/vcpkg.json`), pinned | System packages as the source of truth |
| GPU | `webgpu.h` via **wgpu-native** (prebuilt; Rust inside, opaque). WGSL shaders. Dawn is a drop-in later | Raw Vulkan |
| Raw decode | LibRaw, direct C++ | Write a demosaic algorithm |
| Colour | LibRaw camera matrix → **linear sRGB primaries** working space in WGSL (LibRaw `output_color = 1`; Rec.2020 was the plan, sRGB is what shipped — see `NEXT.md`) → display transform in the final pass. lcms2 for ICC on export and the display profile | OCIO, hand-rolled transforms |
| Catalog | sqlite3 C API, WAL | Anything else |
| Scripting | Embedded CPython via pybind11; `latent` module in C++; pure-Python helpers in `engine/python/latent/` | Pyodide, subprocess Python |
| MCP | Official Python MCP SDK inside the embedded interpreter, streamable HTTP on 127.0.0.1; `latent mcp` stdio shim | A C++ MCP implementation, stdio-only |
| AI inference | onnxruntime C++ API, CUDA / TensorRT EP: SAM 2, Florence-2, denoise | Training, ORT Web |
| Generative | `GenerativeBackend` interface; default = spawn `comfy` CLI; hosted API impl later | Raw `/prompt` HTTP |
| Export encode | libjpeg-turbo, libtiff, libavif (aom), libpng, lcms2 | Encoding in the UI |
| Engine ↔ UI | One WebSocket (uWebSockets): JSON-RPC 2.0 text frames for commands/state, binary frames for preview pixels | Shared memory, N-API addons in Electron, REST |
| Wire contract | `protocol/*.schema.json` — single source; TS types generated into `packages/protocol` | Hand-written types on both sides |
| Shell | Electron: main spawns `latentd`, opens one window | Anything in main beyond process + window management |
| Renderer | Svelte 5 (runes) + Vite + Tailwind 4, **no SvelteKit** | Any other framework |
| Design system | `@neoworks-dev/ui` via `bun link` (see `.claude/skills/ui-components`) | Hand-rolled buttons, hex colours |
| UI plugin kernel | `@neoworks/extension-system` via `bun link` (see `.claude/skills/extension-system`) | A second plugin mechanism |
| JS runtime / pm | bun (workspaces) | npm/yarn/pnpm |

### 4.1 Process model

```
latentd (C++ daemon, one binary)                    latent (Electron)
├── gpu        wgpu-native device, texture pool,     main
│              ping-pong pass graph, readback          └── spawn latentd, open window, nothing else
├── raw        LibRaw decode → rgba16uint upload     renderer (Chromium)
├── ops        registry, stack, history, sidecars    ├── extension-system Context (UI kernel)
│              ← THE TRUTH                           ├── engine   WebSocket client, typed RPC, frame sink
├── catalog    sqlite3                               ├── canvas   draws the latest binary frame
├── python     embedded CPython, `latent` module,    ├── panes / slots / commands registries
│              MCP server (Python SDK), console       └── plugins/* panel UIs, filmstrip, masks, curves
├── ai         onnxruntime: SAM 2, Florence-2
├── generative GenerativeBackend: comfy CLI, hosted
├── export     encoders, job queue
└── server     WebSocket: JSON-RPC + frame stream
```

- **Preview is a stream.** The engine renders a viewport-resolution proxy (what you edit
  on; full-res only for export and 1:1 tiles) and sends rgba8 binary frames. Budget per
  slider tick: render ≤ 4 ms, readback 2–5 ms, loopback 3–5 ms, canvas upload 1–2 ms →
  under 16 ms end to end. Measured in the probe (§8), not assumed.
- **Every UI action is a message.** Slider drag → `ops.update` → engine → new snapshot →
  render → frame. Coalesce drags client-side to one in-flight request; the engine renders
  the latest state, never a queue of stale ones.
- **The engine publishes op schemas** (`ops.describe`): name, params, ranges, defaults,
  panel. Generic panels are generated from that; only curves, masking, crop and the
  filmstrip are hand-built UI plugins.
- **Engine runs headless.** `latentd --no-ui` serves MCP and the socket with no window.
  CLI, batch jobs, tests and agents use it without Electron.
- **One window.** One renderer, one engine connection, one MCP target. Compare views are
  panes inside the window. No second `BrowserWindow`.
- **Pixels never take the JSON path.** Frames, thumbnails, preview JPEGs for the agent all go
  as binary WebSocket frames or files on disk.

### 4.2 Where things live

The op *definitions* — schema, WGSL, defaults — are engine code, one directory per
Lightroom panel under `engine/src/ops/<panel>/`. UI plugins under `plugins/` contribute
panels, panes, commands and slots through the extension-system kernel, registering via
`ctx.effect` so they unload cleanly. Reference for the UI-kernel patterns — registries,
panes, slots, `provideKernelContext` — is `/home/moritz/Documents/neoworks/nib-harness-gui`
(`packages/ui-contracts`, `apps/web/src/lib/client`). It uses its own thinner
`@nib-ui/kernel`; the *patterns* transfer, the API does not — Latent uses
`@neoworks/extension-system` (`ctx.plugin`, `inject`, `ctx.provide`, `Service`).

```ts
export const lightPanelPlugin: Plugin = {
  name: "light-panel",
  inject: ["engine", "panes"],
  apply(ctx) {
    ctx.effect(() => ctx.panes.register({ id: "light", component: GeneratedPanel, params: { panel: "light" } }));
  },
};
```

## 5. Repo layout

```
engine/                  C++20 daemon `latentd`. CMakeLists.txt, CMakePresets.json, vcpkg.json
  src/gpu/               wgpu-native device, textures, pass graph, readback
  src/ops/<panel>/       op definitions + WGSL per Lightroom panel; registry, stack, history
  src/raw/               LibRaw
  src/catalog/           sqlite3
  src/python/            pybind11 `latent` module, interpreter host
  src/ai/                onnxruntime sessions
  src/generative/        GenerativeBackend, comfy CLI backend
  src/export/            encoders, job queue
  src/server/            WebSocket JSON-RPC + frames
  shaders/               *.wgsl
  python/latent/         pure-Python API helpers, MCP server, stdio shim
  workflows/             ComfyUI fragments + blueprints + compiled graphs
  tests/                 Catch2 + pytest for the Python surface
protocol/                JSON Schema for every message; the wire contract
apps/desktop/            Electron main + preload (electron-vite)
apps/editor/             Renderer: Svelte 5 + Vite + Tailwind 4. Boots the UI Context.
packages/protocol/       TS types generated from protocol/ (never hand-edited)
packages/contracts/      UI service interfaces (panes, slots, commands, engine client)
plugins/*                UI plugins: generated panels, curves, masking, crop, filmstrip, catalog, console, export
reference/lightroom/     scraped Adobe docs — the op spec
tools/                   oxlint + eslint local lint plugins (copied from nib-harness-gui)
```

TS toolchain, copied verbatim from nib-harness-gui: `oxlint --type-aware`, ESLint for
`.svelte` markup only, Prettier, `svelte-check`, `bun test`. C++: `cmake --preset dev`,
`ctest`, `clang-format`, `clang-tidy`. Details in `CLAUDE.md`.

## 6. GPU constraints — read before writing shaders

Native `webgpu.h`, not the browser. Most browser limits are gone; the discipline stays.

- **Request limits explicitly.** `maxTextureDimension2D ≥ 16384` (NVIDIA gives 32768).
  Request `shader-f16`. Fail loudly if the adapter can't.
- **Images live in textures, not buffers.** Ping-pong two `rgba16float` textures through
  render passes for the op chain. Storage textures and compute passes are available
  natively and are fine for histograms, masks and SAM post-processing — use them where a
  fragment pass would be contorted, not by default.
- **Upload as `rgba16uint`, convert once.** LibRaw hands back 16-bit integer RGB. Upload
  verbatim; the first pass scales by white/black level into linear `rgba16float`.
- **Proxy vs full-res.** Edit on a viewport-sized proxy; render full-res only for export
  and 1:1 tiles. Same op-stack, different source texture — never a second codepath.
- **Memory.** 45 MP rgba16float ≈ 363 MB per texture; ping-pong doubles it, plus ONNX
  sessions and ComfyUI next door. 16 GB is comfortable; do not design for less until there
  is a second user.
- **Readback is the tax.** Every frame to the UI is a `copyTextureToBuffer` + map. Keep it
  at proxy resolution and rgba8; never read back full-res for preview.

## 7. Phases

**Phase 0 — spine.** Engine probe (§8), engine skeleton with WebSocket server and
`ops.describe`, op-stack + history + sidecar I/O with tests, LibRaw decode → texture,
exposure/WB/contrast/curve passes, frame stream into an Electron canvas, generated Light
panel, full catalog (import, folders, filmstrip, ratings, flags, collections, metadata),
single-photo export (JPEG, TIFF16, AVIF, PNG), embedded Python with `stack` + `develop`
sugar, MCP server with `run_python` / `get_stack` / `render_preview` / `list_photos`.
Mostly plumbing, and the hardest part to get right.

**Phase 0.5 — feel.** The generated panels prove the plumbing; they are not a photo editor
yet. Bar: Lightroom desktop (`reference/lightroom/lightroom-ui-*.png`, `lightroom-mobile.png`)
and Luminar (`reference/lightroom/luminar-*.png`). Concretely:

- Sliders: wide track with a large hit area, click-anywhere-on-track jumps, thumb drag, value
  field scrubbable by drag and editable on click, arrow keys ±step and Shift ±10×step,
  double-click on label or thumb resets to default, centre detent at 0 for bipolar ops, WB
  Temp/Tint tracks tinted blue→yellow / green→magenta like Lightroom, `+`/`−` signed
  readouts. Keep the one-in-flight coalescing.
- Panels: collapsible sections with a chevron, Lightroom order (Profile → Light → Point Curve
  → Color → Effects → Detail → Optics → Geometry), per-section eye to bypass, per-section
  reset, sticky section headers, section-level "edited" dot. Histogram at the top of the right
  column; clipping toggles.
- Right rail: icon strip for Edit / Crop / Masks / Heal / Presets / History / Info, like
  Lightroom's. Modes swap the right column; one column, no second window.
- Viewer: before/after (`\`), 1:1 / fit / zoom (`Z`, scroll-wheel, drag-pan), compare pane,
  loupe info overlay, `Tab` hides all panes, `F` fullscreen.
- Filmstrip + Library: Lightroom density, hover reveals rating/flag controls, grid view
  (`G`) with size slider, sort menu, quick filter bar, search box.
- Design pass over every pane against `@neoworks-dev/ui` tokens: type scale, spacing, borders,
  focus rings, disabled states, tooltips with shortcuts.

Done when a Lightroom user sits down and does not ask where anything is.

**Phase 1 — masking.** SAM 2 subject/sky/object detection, Florence-2 text → box for
`masks.detect()`, brush, gradient, radial, mask math. This is where it passes digiKam and ART.

**Phase 2 — AI ops.** Generative fill and remove on a masked region (§3.5), denoise, upscale.
ComfyUI does the work via the `comfy` CLI; the engine owns crop/composite and staleness.

Status 2026-09-16: Phase 0–1 landed, Phase 2's generative fill/remove landed (denoise and
upscale not), Phase 3's HDR merge and panorama landed (16-bit linear TIFF sources, float/DNG
later). `NEXT.md` is the ordered remainder.

**Phase 3 — the long tail.** Lens profiles, tethering, soft proofing, print, HDR merge, pano,
colour labels, smart collections, XMP round-trip, persisted history, DNG export, catalog AI
(CLIP/SigLIP embeddings for text search, face clustering, auto-cull), Dawn instead of
wgpu-native if ever needed. This is where Lightroom clones die: ~90% of remaining effort for
~10% of daily use. It is acceptable for this to never finish — the app is built for one user.

## 8. First task

**Do not start with the UI.** Probe the engine stack and confirm the design is viable on
this machine. One throwaway CMake target, numbers reported before anything else:

1. wgpu-native headless: request adapter/device, print limits and features
   (`maxTextureDimension2D`, `maxBufferSize`, `shader-f16`). Allocate two 8256×5504
   `rgba16float` textures, run one trivial ping-pong pass, no device loss.
2. LibRaw: decode one RAF and one NEF to 16-bit RGB; time it; upload as `rgba16uint`.
3. Frame path: render a 2560×1440 proxy, read back rgba8, push over a WebSocket to a bare
   Electron window drawing on a canvas. Measure end-to-end latency for 100 consecutive
   "slider ticks". Target < 16 ms. **If this misses 30 ms, stop and report** — the daemon
   model is then wrong and the fallback is the engine as an N-API addon inside the window.
4. pybind11: embed CPython, expose one function, run a script. Then start the official
   Python MCP SDK's streamable-HTTP server from inside the interpreter and call a tool from
   Claude Code.
5. onnxruntime C++ with CUDA EP: load the SAM 2 image encoder, run one inference, time it.

After the probe passes, in order: engine skeleton + protocol schema → `ops` (types,
registry, history, sidecar codec, tests) → LibRaw → exposure-only pass streamed to canvas →
rest of Phase 0.

### 8.1 Probe results — 2026-09-16, this machine

Code: `engine/probe/`. All five steps run; numbers are measured, not estimated.

| Step | Result |
|---|---|
| 1 wgpu-native | RTX 4080 SUPER via Vulkan (driver 615.71). `maxTextureDimension2D` 32768, `maxBufferSize` 1 TiB, `shader-f16` yes, float32-filterable yes. 2× 8256×5504 rgba16float allocated, sampled ping-pong pass **1.22 ms**, full-res readback 249 ms (363 MB — never do this for preview). Device ready in 145 ms. `wgpuInstanceWaitAny` panics "not implemented" in v29.0.1.1; use `AllowProcessEvents` + `wgpuInstanceProcessEvents`/`wgpuDevicePoll`. |
| 2 LibRaw | Sony ILCE-6400 ARW 24.2 MP: open+unpack+AHD demosaic **1223 ms** single-threaded, RGB→RGBA pad 85 ms. vcpkg libraw 0.22.2. |
| 3 Frame path | 2560×1440 rgba8 over loopback WebSocket into an Electron canvas, 100 slider ticks: **p50 17.1 ms, p95 22.9 ms, mean 20.8 ms** (max 347 = first frame). Engine side 1.6 ms render + 5.0 ms readback; the rest is transport + `putImageData`. Under the 30 ms kill line; daemon model stands. Optimisation later: WebGL texture upload instead of `putImageData`. **Follow-up (same day, 811×1245 = 4 MB frames):** canvas was never the cost (`putImageData` 0.4 ms). Chromium's WebSocket receive is ~11 ms p50 for 4 MB, linear in bytes (0.5 MB → 2.6 ms), a Worker-owned socket is slower, `desynchronized` widens p95. After WebGL2 painter: request→pixels-on-GPU 11.0 / 16.2 ms p50/p95, +~8 ms vsync to presented. Remaining lever is bytes: half-res proxy while dragging, full on release. |
| 4 Python + MCP | Bundled CPython 3.12.13 from vcpkg embedded via pybind11: interpreter up in **5.7 ms**. `PyConfig.home` must point at the vcpkg prefix and the executable needs `-rdynamic` (static libpython; extension modules resolve symbols against it). MCP Python SDK **2.2.0** (`MCPServer`, not `FastMCP`) served streamable HTTP from inside the daemon; `initialize` + `tools/call` round trip from curl returned a value computed in C++. |
| 5 ORT CUDA | onnxruntime 1.30.0 cuda13 prebuilt links and loads the SAM 2 hiera-base-plus encoder (`~/.local/share/latent/models/`). Session init failed at first only because another process held 11.9 of 16 GB VRAM at the time (ComfyUI). Re-run with free VRAM: first run 222 ms, steady-state **82 ms** per 1024² encode, `RESULT PASS`. |
| 6 Zoom (same day) | Second frame-path measurement at proxy 1082×1177 with four agents loading the machine: Fit 41.5 ms p50 total (engine 5.4–7.4, wire 25.5–26.8), 1:1 38.5 ms (engine 5.8–10.7, wire 23.9–24.5). Zoom only changes which source texels the sampling pass reads; the frame stays the view's size, so magnification is free and the wire share is still bytes. |

#### 8.1.1 Mask models — 2026-09-16

Prepared, validated and timed in `scripts/models/` (full I/O tables, preprocessing and
C++ port notes in `scripts/models/README.md`). All numbers CUDA EP, p50 of 10 after
warm-up, sample raw decoded to 1026×1536.

| Model | Store size | Stage | p50 | Session load | VRAM peak |
|---|---|---|---|---|---|
| SAM 2 hiera-base-plus | 360 MB | encoder 1024² | **102.4 ms** | 458 ms | 2560 MB |
| | | decoder, 1 box prompt | **6.4 ms** | | |
| Florence-2 base (4 ONNX graphs) | 1248 MB | vision encoder 768² | **48.3 ms** | 1562 ms | 2088 MB |
| | | text encoder + greedy decode (9 tokens) | **21.2 ms** | | |
| BiRefNet-lite fp16 | 114 MB | alpha matte 1024² | **201.1 ms** | 1130 ms | 6214 MB |
| SegFormer-B2 ADE20K | 110 MB | semantic 512² | **21.4 ms** | 194 ms | 868 MB |

Text prompt → mask end to end is ~180 ms (Florence 70 + SAM 2 encode 102 + decode 6).
All mask kinds are jobs; none is in a slider tick.

**Florence-2 → SAM 2 is the right tool for `text` and nothing else.** Florence never
abstains, so `sky` on a studio backdrop returned 57 % of the frame, and `<OD>` saturates
at ~30 detections it spends on shoes, so a crowd came back as 3 of ~40 people. Measured
on three CC0 photos plus the sample raw: `subject`/`background` → BiRefNet-lite (MIT,
salient-object alpha, matches Lightroom's Select Subject), `sky`/`people` → SegFormer-B2
ADE20K classes 2 and 12 (0.0000 sky on the studio raw, 39 % people on the crowd).
SegFormer's licence is NVIDIA Source Code License-**NC** — fine personally, a blocker if
Latent is ever sold.

Two traps found. `probe_onnx`'s "input image is not float32" is a use-after-free in the
probe, not a model property: `Ort::TypeInfo` from `GetInputTypeInfo` is a temporary and
`GetTensorTypeAndShapeInfo()` is a non-owning view into it — keep the `TypeInfo` in a
named local. And the SAM 2 decoder's `num_labels` dim cannot exceed 1 (`has_mask_input`
is rank 1 and fails to broadcast at `/Mul_14`), so multi-object prompts are a loop.

VRAM, not disk, is the limit: all four sessions resident plus BiRefNet's 822 MB
transient exhausted 16 GB. Load one mask model per job, drop the session, keep only the
SAM 2 encoder output cached per photo (16.8 MB, saves 100 ms per extra prompt).

## 9. Naming

**Latent** — the latent image is the exposed-but-undeveloped image on film, invisible until
developer reaches it. Also latent space. One word for both halves of the project.

Daemon `latentd`, CLI `latent`, config `~/.config/latent/`, catalog
`~/.local/share/latent/catalog.db`, sidecars `.latent`.

The npm name `latent` is taken (0.0.1, unrelated). Workspace packages are private and
scoped `@latent/*`; nothing publishes. GitHub/domain availability unchecked.

## 10. Working agreement

- The owner prefers terse, direct communication. No filler, no hedging, no praise.
- Ask when a decision materially changes architecture; otherwise decide and state the
  assumption.
- The owner reads and writes C++ and TypeScript. Not Rust. Never propose Rust code.
- Edit files with the Edit/Write tools, never via `sed`/`python` scripts.
- Show visual output when working on anything that renders. Launching the app, driving it
  (Playwright-electron / CDP) and capturing a PNG is allowed and expected — a preview image
  beats a description of one. For engine-only work, write the frame to a PNG and show it.
- Git: commit only when asked. Identity is the global config (`moritz.utcke@gmx.de`).
- `CLAUDE.md` holds the standing rules for code style, lint, tests, and gotchas.
