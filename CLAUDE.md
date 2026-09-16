# Latent — agent rules

Read `PROMPT.md` first. It holds why + architecture. This file: how to work here.

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
  `rgba16uint`, scale first pass. Working space linear Rec.2020. Proxy-res preview only;
  full-res for export/1:1.
- Python: embedded CPython 3.12 **from vcpkg** (bundled, not system), pybind11 module
  `latent` in `engine/src/python/`. Pure-Python side + MCP server in `engine/python/latent/`.
  MCP = official Python SDK **2.x** (`from mcp.server.mcpserver import MCPServer`; `FastMCP`
  is the dead 1.x name), never C++. Embedding rules: set `PyConfig.home` to the vcpkg prefix
  (`Python3_STDLIB/../..`) or nothing imports; link the executable with `-rdynamic` (static
  libpython; extension modules like pydantic_core resolve symbols against the exe); catch
  `py::error_already_set` inside the interpreter's lifetime or it core-dumps at teardown. pip
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
- SAM 2 has no text input. Text select = Florence-2 box → SAM 2. ORT with CUDA EP.
  Florence-2 never abstains → only the `text` kind uses it; `subject`/`background` =
  BiRefNet-lite, `sky`/`people` = SegFormer-B2 ADE20K (classes 2/12). Models prepared by
  `scripts/models/fetch.py` into `~/.local/share/latent/models/<model>/` with
  `config.json` + top-level `manifest.json` (sha256). I/O tables, preprocessing, timings
  and C++ port notes: `scripts/models/README.md`. SAM 2 decoder `num_labels` must be 1.
- Frame budget: < 16 ms slider tick end-to-end. Measured 2026-09-16: request→GPU 11.0 ms
  p50 at 811×1245 after WebGL2 painter; ~11 ms of it is Chromium's WebSocket receive of a
  4 MB frame, linear in bytes. Canvas draw is 0.0 ms. Numbers in `PROMPT.md` §8.1. Lever
  left: fewer bytes (half-res proxy while dragging). Re-measure after any frame-path change
  (`node apps/desktop/scripts/screenshot.ts --engine real --flow latency`); never read back
  full-res for preview (249 ms).
- Sample raw for tests: `~/Downloads/DSC00120.ARW` (Sony A6400, 24 MP). Models:
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

Visual work: launch app (`bun run dev` spawns `latentd` + Electron), drive via
Playwright-electron or CDP, capture PNG, show it. Engine-only: dump frame to PNG, show it.
Preview beats description.

## Git

`git status --short` before edits. Dirty files = user-owned; don't stash/reset/commit them.
Commit only when asked. Imperative subject, body only if diff doesn't explain. Identity: global
config (`moritz.utcke@gmx.de`). Never force-push. Never merge unverified into `main`.

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
