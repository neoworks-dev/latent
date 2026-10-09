# Latent — agent rules

Read `PROMPT.md` first. It holds why + architecture. The backlog is the GitHub tracker on
`neoworks-dev/latent` — `gh issue list`, ordered by the Priority issue field (see _Issues_). This file: how to
work here.

## Voice

Terse. Direct. No filler, hedging, praise. State wrong assumptions + why. Quote shortest log
snippet that identifies problem. Ask only when answer changes architecture, safety, or public
API; else decide, state assumption, proceed. Owner reads C++ + TS. **Never Rust.**

## Shape

Two halves, one truth:

- `engine/` — C++20 daemon `latentd`. Owns pixels, op-stack, history, sidecars, catalog,
  Python, MCP, AI, export, ComfyUI. Truth lives here.
- `apps/` + `plugins/` + `packages/` — Electron + Svelte UI. View only. Talks to engine over
  one WebSocket (JSON-RPC text + binary frames). Never holds edit state.

Wire contract: `protocol/*.schema.json`. TS types generated into `packages/protocol`; never
hand-edit generated files. C++ side reads same schemas in tests.

Op spec: `reference/lightroom/README.md` (scraped Adobe docs, 2026-09-16). Op names/ranges
mirror Lightroom 1:1.

## Engine (C++)

- C++20. Run presets **from `engine/`** with `export VCPKG_ROOT=$HOME/.local/share/vcpkg`:
  `cmake --preset dev && cmake --build --preset dev && ctest --preset dev`. Build dir
  `engine/build/dev`. Deps: `engine/vcpkg.json` manifest, pinned. Never `apt`/`pacman` a dep
  in. wgpu-native + onnxruntime = pinned prebuilt tarballs via `engine/cmake/*.cmake` into
  `engine/third_party/` (gitignored).
- GPU via `webgpu.h` (wgpu-native). WGSL in `engine/shaders/`. Images in textures, ping-pong
  `rgba16float` render passes; storage/compute allowed for histograms, masks. Upload raw as
  `rgba16uint`, scale first pass. Working space is **linear sRGB primaries** (LibRaw
  `output_color = 1`, `ops.wgsl` header); export and generative rasters transform from
  there. Proxy-res preview only; full-res only for export (`Renderer::render_export`).
- Masks are keyed to **image space**: 0..1 over the uncropped decoded photo. The geometry
  stage is one matrix in `engine/src/ops/geometry.{h,cpp}`; every mask pass, the proxy's
  sampling pass, `imageTransform` on the wire and the legacy sidecar migration read it.
  Never re-derive it. Lens distortion is not in the matrix (no closed-form inverse); the
  shader applies it forwards. `view.render`'s `viewport` (zoom/pan) is sticky per view and
  is not edit state: never in the stack or the sidecar. `geometry: "full"` renders with the
  crop rect and straighten bypassed (the crop tool's view).
- Generative ops (`generative_fill`, `remove`) are `PipelineStage::Generative` rasters:
  `result` PNG + `inputHash` + `resultRect`, composited by `composite.wgsl`; every op below
  that stage feeds the hash, ops above apply to the patch. `LATENT_GENERATIVE_STUB=1` swaps
  the ComfyUI backend for a local fill. Graphs in `engine/workflows/` (README lists the
  substituted node ids). `comfy --json <cmd>` is one envelope, `comfy --json-stream` is
  NDJSON; a Typer usage error prints nothing and exits 2.
- Merged photos (HDR/pano) are 16-bit linear TIFF + `<file>.latent-source.json`; LibRaw
  refuses a plain TIFF, so metadata/thumbnail paths need the source-TIFF branch
  (`read_source_row`, `make_any_thumbnail`). `~/Pictures/Photos` has no exposure bracket.
- Python: embedded CPython 3.12 **from vcpkg** (bundled, not system), pybind11 module
  `latent` in `engine/src/python/`. Pure-Python side + MCP server in `engine/python/latent/`.
  MCP = official Python SDK **2.x** (`from mcp.server.mcpserver import MCPServer`; `FastMCP`
  is the dead 1.x name), never C++. Embedding rules: set `PyConfig.home` to the vcpkg prefix
  (`Python3_STDLIB/../..`) or nothing imports; link the executable with `-rdynamic` (static
  libpython; extension modules like pydantic_core resolve symbols against the exe); catch
  `py::error_already_set` inside the interpreter's lifetime or it core-dumps at teardown.
  `-rdynamic` must export libpython **only**: every other static archive is on
  `--exclude-libs` (`engine/src/CMakeLists.txt`), because a shared library loaded later
  binds to the executable first — cuDNN once took our zlib's `inflate` and segfaulted.
  A daemon crash mid-test reads as a timeout; `coredumpctl list latentd` first. pip
  into the bundled interpreter: `build/dev/vcpkg_installed/x64-linux/tools/python3/python3.12 -m pip`.
- wgpu-native v29: `wgpuInstanceWaitAny` panics "not implemented". Use
  `WGPUCallbackMode_AllowProcessEvents` + `wgpuInstanceProcessEvents` / `wgpuDevicePoll(device,
  true)`. WGSL uniform structs: order `vec2f` before `f32` so sizes match C++. uWebSockets
  header path `<uwebsockets/App.h>`.
- Style: `clang-format` (repo `.clang-format`), `clang-tidy` clean. `snake_case` functions/
  vars, `PascalCase` types, no raw `new`/`delete`, `std::span`/`std::string_view` at
  boundaries, RAII for every GPU/LibRaw/ORT handle. No exceptions across the C API boundary
  of wgpu-native/LibRaw — check returns.
- Generative ops = cached rasters + `inputHash`. Stale ≠ auto re-run. Backends behind
  `GenerativeBackend`. ComfyUI only via `comfy` CLI (`~/.local/bin/comfy`, skill at
  `~/.claude/skills/comfy`). Graphs in `engine/workflows/`: fragments + blueprint, `comfy
  workflow compose`; compiled JSON is a template, substitute by node id at runtime.
- `<photo>.latent` sidecar sits beside the photo; every raster it names (masks, stroke
  mirrors, depth, generative patches) lives in `$XDG_DATA_HOME/latent/rasters/<sha256>/`
  (`raster_dir_for(photo.hash)`, `engine/src/ops/mask.h`), keyed by the file's content hash
  so a move outside the app orphans nothing. Never write beside the photo: older builds did
  (`<photo>.latent.d/`), the scan imported those PNGs as photos (#36); open/export migrate
  them. Test harness pins `XDG_DATA_HOME` to its scratch dir.
- Relight (`PROMPT.md` §3.8) needs the photo's depth map: `depth.estimate` → Depth Anything
  V2 Small → `depth.png` in the raster dir, **16-bit** (0 far / 65535 near), image space like
  a mask raster but uploaded at its own size as `r16uint` and filtered in the shader — 8 bits
  terraces a sky and the shadow march draws a contour on every terrace, and a nearest-
  neighbour resample blocks it. An 8-bit map from an older build reads as absent.
  Not edit state — no undo step, no staleness — and a `relight` op renders nothing until it
  exists, like a generative op without its raster. `LATENT_DEPTH_STUB=1` swaps the model.
  Two passes in `relight.wgsl`: the shafts march writes (shaft shape, visibility, front) and
  the shading pass reads it. The march answers a 0..1 shape only; brightness is the light's
  falloff applied once in the shading pass, windowed to zero past the reach ring — summing it
  along the ray instead lifts every pixel and reads as haze. The `depth` mask kind stores the
  map itself as its raster and bands it in the shader, so its range is a slider and not
  another model run.
- SAM 2 has no text input. Text select = Florence-2 box → SAM 2. ORT with CUDA EP.
  Florence-2 never abstains → only the `text` kind uses it; `subject`/`background` =
  BiRefNet-lite, `sky`/`people` = SegFormer-B2 ADE20K (classes 2/12). Models prepared by
  `scripts/models/fetch.py` into `~/.local/share/latent/models/<model>/` with
  `config.json` + top-level `manifest.json` (sha256). I/O tables, preprocessing, timings
  and C++ port notes: `scripts/models/README.md`. SAM 2 decoder `num_labels` must be 1.
  Engine side: `engine/src/ai/` (`latent_ai` lib), one ORT session per job, dropped after;
  only the SAM 2 embedding is cached (most recent photo). `LATENT_MODEL_STORE` overrides
  the store path (tests use it); `LATENT_MASK_STUB=1` swaps in shape stubs. The process
  `Ort::Env` is leaked on purpose: destroying it after a CUDA session corrupted the heap
  at exit one run in three.
- Frame budget: < 16 ms slider tick end-to-end. Measured 2026-09-16: request→GPU 11.0 ms
  p50 at 811×1245 after WebGL2 painter; ~11 ms of it is Chromium's WebSocket receive of a
  4 MB frame, linear in bytes. Canvas draw is 0.0 ms. Numbers in `PROMPT.md` §8.1. Lever
  left: fewer bytes (half-res proxy while dragging). Re-measure after any frame-path change
  (`node apps/desktop/scripts/screenshot.ts --engine real --flow latency`); never read back
  full-res for preview (249 ms).
- Sample raw for tests: `~/Downloads/DSC00120.ARW` (Sony A6400, 24 MP). Bulk set for
  catalog flows: `~/Pictures/Photos/` (280 Panasonic RW2), e.g.
  `--engine real --flow catalog --photo ~/Downloads/DSC00120.ARW --dir ~/Pictures/Photos`. Models:
  `~/.local/share/latent/models/`. ORT CUDA needs free VRAM; ComfyUI can hold 12 GB.

## UI (TS)

Linked packages, not on npm, both via `bun link`:

| Package | Source |
|---|---|
| `@neoworks/extension-system` | `/home/moritz/Documents/neoworks/extension-system` |
| `@neoworks-dev/ui` | `/home/moritz/Documents/neoworks/neoworks.dev/packages/ui` |

Unresolved → `cd <source> && bun link`, then `bun link <name>` here. Never install from
registry, vendor, or delete dep as workaround. Never edit `node_modules/`. Fix library bugs in
source repo, say so.

Skills vendored: `.claude/skills/extension-system` (kernel API, effect rules, mistakes),
`.claude/skills/ui-components` (design system + `COMPONENTS.md`). Read before writing plugin
or UI. Check `@neoworks-dev/ui` for component first; custom → one sentence why.

Kernel rules (extension-system, not nib's kernel):
- API: `ctx.plugin`, `inject`, `ctx.provide`, `ctx.effect`, `Service`. nib's `ctx.use`/
  `ctx.require` don't exist here.
- Every raw side effect (DOM listener, `setInterval`, WebSocket handler) → `ctx.effect` with
  inverse. Test = mount, unmount, state identical.
- Plugin's own `ctx`, never outer. Declare services via `declare module
  '@neoworks/extension-system' { interface Context { engine: EngineClient } }`.
- No `_`-prefixed, symbol, numeric service keys — bypass proxy.
- Reactive stores as services: `*.svelte.ts` class with `$state`, provided by key. Any file
  using runes must end in `.svelte.ts`.
- Plugins are object form `{ name, inject, apply }` typed `Plugin.Object<Config>`; function
  form can't take `.name =` (read-only in TS).
- Editor-tsserver may show duplicate-`Context` errors from two `node_modules` copies of the
  linked kernel; trust `svelte-check`/`tsc`, not the IDE squiggles.
- Generic panels generated from `ops.describe`. Hand-built UI only: curves, masking, crop,
  filmstrip, console, export.

Code style: readability > cleverness. Full-word `camelCase` (`photoId`, never `pid`). Guard
clauses, early return, ≤2 indent levels. No nested ternary, no chained `??`, no branch that
only yields `""`/`[]`/`{}`. Cast at call site = wrong signature; fix callee. No 3–5 line
single-use helpers. `$derived` with one consumer → inline. Comments only for non-obvious
rules, API quirks, hardware constraints.

## Verification (every change)

```bash
# UI
bun test              # each workspace has tests/
bun run lint          # oxlint --type-aware (TS + svelte <script>) + eslint (.svelte markup only)
bun run check:svelte  # svelte-check; neither linter sees templates
bun run format        # prettier --check; format:fix to apply
bun run typecheck
# Engine
cmake --build --preset dev && ctest --preset dev
```

Lint split fixed: oxlint owns TS, ESLint owns svelte markup, never give ESLint
`projectService`. Local rules in `tools/oxlint-local-plugin.ts` + `tools/eslint-local-plugin.js`.
Config files user-owned — don't edit to pass. No `eslint-disable`/`oxlint-disable`/`NOLINT`
without stating why. Never weaken/skip tests for green. No tests → one-sentence rationale.

Visual work: drive your own instance with `node apps/desktop/scripts/screenshot.ts` (it
spawns `latentd` + Electron over CDP), capture PNG, show it. Engine-only: dump frame to PNG,
show it. Preview beats description. Never launch or restart my instance of the app; tell me
to restart it when a merge touches the engine or Electron main.

## Git

Commit the worktree first if it's dirty, then write your changes. Short, to-the-point commit
title; a body explaining the change when the title doesn't carry it; ask if you're unsure
what to write. On a feature branch, only commit what that branch is for. Identity: global
config (`moritz.utcke@gmx.de`). Never force-push.

No trailers, ever: no `Co-Authored-By` on a commit, no "Generated with Claude Code" on a PR.

## Writing

Commits and issues carry only what matters. Say the thing, explain what a reader won't see for
themselves, stop. No restating the diff, no summarising what you just said, no section that
exists because the format seemed to want one.

Write issues and their comments the way you'd explain it to a colleague, in complete
sentences.

- Start with a 2–3 sentence summary: what happened, why, and the fix.
- Use short headings, with short paragraphs of normal prose under them.
- Never join ideas with arrows, slashes, colons or dashes. Write "first X, then Y" instead of
  "X → Y", and "A and B" instead of "A / B".
- Use at most two code identifiers per sentence. Say what each one does the first time it
  appears.
- Use bullets only for genuinely separate items, and make each bullet a full sentence.
- Use tables only for numbers or timelines.
- Use one date format everywhere: 2026-10-07 18:28.
- Put error messages, paths and commands in code formatting, and long logs in a collapsed
  `<details>` block.
- Put side findings in a short "Out of scope" section at the end.

Titles say the thing in plain words, no number prefix (`Embedded preview while the raw
decodes`, not `57. Previews`).

## How we work

One agent at a time, with me giving feedback as it goes. Keep each step small enough for me
to read in one sitting, and stop to show me rather than piling up work I then have to catch
up on.

`main` is what I've reviewed and what I run Latent from. It stays checked out in the repo
root: never switch branches there.

Straight to `main` in the root, no branch: typos, one-liners, and anything that only touches
how we work rather than the app — this file, `.claude/skills/`, `scripts/issue-meta.sh`,
editor config.

Everything else happens on a branch off `main`, in a worktree under `.worktrees/<branch>`
(`git worktree add .worktrees/<branch> -b <branch> main`). Name it `<issue-number>-<slug>`
when there is an issue (`31-job-queue`), `<slug>` when there isn't. One branch is one thing;
anything found along the way gets written down as an issue and stays off the branch, unless
the branch can't finish without it. A worktree has its own `engine/build/dev`, so its first
engine build configures from scratch; the `flock` rule under Gotchas still holds, because the
GPU, the VRAM and the sample raw are shared.

Before starting on anything, check whether it is already half-built: `git branch` and
`git worktree list` for the feature, and read what is on the branch. Sessions end
mid-feature, and a branch is where that work is — starting again writes it a second time and
loses whatever the first attempt learned. If a branch for it exists, continue on it.

No pull requests unless I ask for one. Review happens here, on the diff, before the merge.

## Issues

Issues on `neoworks-dev/latent` carry goals across sessions. A session ends and its context
goes with it; an issue is the only thing that carries a goal to the next one. So:

- Work that finishes in this session, with me here, needs no issue.
- Work that won't finish in one session gets one, however loosely defined it still is.
- Something concrete found along the way, that isn't what we're doing now, gets one instead
  of being done.

Write them as soon as the list exists, not once the work starts. Splitting a large ask into
several issues is usually right; say which ones.

Write to GitHub as the bot: issues, comments and labels go through `gh bot`
(`gh bot issue comment 12 --body …`), so they show as `neoworks-bot[bot]`, not as me. Plain
`gh` is for reading only. The bot as author already says a model wrote it, so no "written by
Claude" line in the text. If `gh bot` fails, say so rather than falling back to plain `gh`.
`gh bot api user` answers 403 (app token); that is not an auth failure.

Every issue carries four things. Type, Priority and Effort are GitHub's own issue type and
the org's issue fields, not labels; set them right after `gh bot issue create` with
`scripts/issue-meta.sh <n> --type Feature --priority High --effort Medium`.

- **Type** is `Feature`, `Bug` or `Task` (infra, docs, perf work and decisions).
- **Priority** is `Urgent` (blocks real use), `High` (a Lightroom switcher hits it in the
  first day), `Medium` (regular workflow) or `Low` (niche).
- **Effort** is `Low` (under a day), `Medium` (a few days) or `High` (a week or more, or a
  new subsystem).
- **Area** is a label, one or two of `area:engine`, `area:ui`, `area:protocol`,
  `area:pipeline`, `area:masks`, `area:generative`, `area:merge`, `area:catalog`,
  `area:export`, `area:ai-models`, `area:color`, `area:geometry`, `area:python-mcp` and
  `area:viewer`. Three means split it.

`status:blocked` and `status:needs-repro` stay labels, added only when they apply. The old
`type:` and `priority:` labels are on issues filed before 2026-10-09; don't add them to new
ones. The backlog is ordered by the Priority field.

## Done means verified

Work is done when it has been shown to work, not when the code is written. Shown means one
of:

- shown fixed in a driven run of `screenshot.ts`, with a screenshot (and one from before, if
  you reproduced it), or an engine frame dumped to PNG;
- a test that fails without the fix and passes with it.

Every check in _Verification_ passes on the branch either way.

Then hand it over and stop: what changed in a sentence or two, the evidence, and the branch.
When it has an issue, the evidence also goes on the issue as a `gh bot issue comment` — that
comment is what I read, so it's written for someone who wasn't in the session.

When I tell you what's happening, that's the reproduction: take it as given and go find the
cause, don't re-check what I already saw. Reach for a driven run when the code doesn't make
the cause clear, or a fix based on reading it didn't work.

## Merging

I review the branch's diff, and it merges into `main` when I say so — never before, and never
without evidence. Merge in the root with `git merge --no-ff <branch>`, so the branch stays one
unit in the history; if it conflicts, resolve it in the merge commit. Push `main`. Then remove
the worktree and delete the branch, and close its issue with `gh bot issue close <n>`.

## Gotchas

- `@neoworks/extension-system` own tests need vitest (fake timers); Latent UI tests use `bun
  test` + real timers — `await` fiber settle.
- `ctx.plugin()` returns thenable Fiber, not run sync. `inject` unsatisfied → `PENDING`
  forever, no error. Check `fiber.state`.
- Electron main does nothing but spawn `latentd` + window. If you're adding logic to main,
  it belongs in the engine or the renderer.
- Pixels never in JSON. Frames/thumbnails/agent previews = binary frames or files.
- Coalesce slider drags: one in-flight `ops.update`, engine renders latest state only.
- `latent` npm name taken. Workspace scope `@latent/*`, all private.
- LibRaw output 16-bit int RGB; white/black level per camera from LibRaw `color` struct.
- One `BrowserWindow`. Compare views = panes, never second window.
- A service setter called from a pane's `$effect` must not read the `$state` it writes
  (`ViewerState.geometry` is a plain field for that reason) or the effect re-runs forever.
- The viewer overlay's painter is a plain function: a tool drawing stack-derived geometry
  calls `overlay.redraw()` itself when the stack changes without a frame behind it.
- nlohmann reads `{{"a", x}, {"b", y}}` in a nested initialiser as an **array**; an op whose
  `mask` is an array silently renders unmasked. Parse a string literal in tests.
- `structuredClone` refuses a Svelte `$state` proxy; copy a mask out of the stack via JSON.
- `apps/desktop/scripts/screenshot.ts` spawns Electron itself and drives it over CDP with
  `--remote-allow-origins=*`. Playwright's `_electron.launch` hangs forever on this Electron:
  it attaches to the inspector and then waits on a DevTools websocket upgrade Chromium
  refuses for an Origin it was not told to allow, and the failure is a bare timeout.
- A driven run gives the engine a scratch `XDG_DATA_HOME`, which is also where the model
  store resolves from — so `LATENT_MODEL_STORE` is pinned to the real one. Without that pin
  every AI feature answers "model … not installed (run scripts/models/fetch.py)" in a flow
  while the same build finds the models the moment the app is launched by hand.
- Agents running at once share the GPU, VRAM and the sample raw even from separate
  worktrees: every engine build, ctest and real-engine run goes through
  `flock /tmp/latent-engine.lock`, and each agent works on its own copy of the sample raw
  (the sidecar next to it is clobbered otherwise).

## Packaging

`go-task appimage` (`Taskfile.yml`) → `dist/Latent-x86_64.AppImage`: Release `latentd`
(`engine/build/release`), vcpkg Python with the MCP SDK, ORT + CUDA provider, Electron from
`node_modules`, built editor. `AppRun` relocates through `LATENT_ENGINE`,
`LATENT_PYTHON_HOME`, `LATENT_PYTHON_PACKAGE_DIR`. Models and CUDA/cuDNN are not bundled.
