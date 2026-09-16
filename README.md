# Latent

GPU-accelerated, agent-steerable raw photo editor for Linux: Lightroom's workflow, an
op-stack instead of a slider panel, a C++ daemon (`latentd`) that owns every pixel and
every edit, a thin Electron + Svelte client, and MCP as the native scripting API.

Why and how: [PROMPT.md](PROMPT.md). Working rules for agents: [CLAUDE.md](CLAUDE.md).

## Prerequisites

- bun 1.3+ (the only JS runtime and package manager); cmake + ninja + clang for C++20
- vcpkg in manifest mode, checkout at `~/.local/share/vcpkg`
- CUDA 13 + cuDNN 9 for the AI ops (SAM 2, Florence-2) — not needed for Phase 0
- `@neoworks/extension-system` and `@neoworks-dev/ui` come in via `bun link`, not npm

## Commands

```sh
bun install
bun run engine:configure && bun run engine:build && bun run engine:test  # C++ daemon
bun run dev                 # latentd + Electron + Vite (LATENT_ENGINE=<path> to pick a binary)
bun run mock-engine         # protocol-level fake engine; prints ws://127.0.0.1:<port>
LATENT_ENGINE_URL=ws://127.0.0.1:<port> bun run dev   # attach instead of spawning
bun run screenshot          # drives the app under Playwright, writes /tmp/latent-ui.png
bun run screenshot --flow catalog   # import → filmstrip → rating → console, /tmp/latent-catalog.png
bun run lint                # oxlint (TS) + eslint (Svelte markup)
bun run format              # prettier --check + clang-format; format:fix to apply
bun run check:svelte && bun run typecheck && bun test
```

The UI never holds edit state: a slider writes an op and redraws from the frame it gets back.

## The window

| Region | Pane                   | What it is                                                                         |
| ------ | ---------------------- | ---------------------------------------------------------------------------------- |
| left   | Library                | Search box, folder tree (counts rolled up), collections, quick filters, Import     |
| center | Viewer                 | The engine's preview frames for the open photo                                     |
| right  | Stack, Light, Color, … | Panels generated from `ops.describe`                                               |
| bottom | Filmstrip              | The current list: thumbnails with rating stars and flag, click opens in the viewer |
| bottom | Python                 | Console: code to the engine's interpreter, stdout/stderr/value back                |
| bottom | Status line            | Photo count, `job.progress` for imports, and a Cancel button while a job runs      |

Panes register themselves with a region; the shell only lays regions out, and the left
column appears when a plugin puts something in it.

### Keyboard

| Key                       | Does                                             |
| ------------------------- | ------------------------------------------------ |
| `←` `→` `↑` `↓`           | Move the filmstrip selection; the viewer follows |
| `0`–`5`                   | Rate every selected photo                        |
| `P` / `X` / `U`           | Flag pick / reject / none                        |
| `Delete`                  | Remove the selection from the catalog            |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo, in the engine's history             |
| ``Ctrl+` ``               | Show or hide the Python console                  |
| `Ctrl+Enter`              | Run the console's code against the open photo    |

Library keys never fire while a text field has focus. `Delete` removes catalog rows only —
the raw files and their sidecars stay on disk, and re-importing the folder brings them back.

### Catalog

The filmstrip asks for a whole page of thumbnails with one `catalog.thumbnails` call and
draws each `LTHM` frame as it lands, so a page change is one request, not 120. The search
box narrows the engine's list (`catalog.list { query }`, substring over filename and
camera); nothing is filtered client-side. An import reports through `job.progress` and can
be stopped with the status line's Cancel — `job.cancel`; the photos already registered stay.

### Python console

The console sends `python.run { code, photoId }` and prints `stdout`, `stderr` (red) and
the value of the last expression. The API is the one the agents use (PROMPT.md §3.4):

```python
latent.photo.develop.exposure = 0.7
latent.photo.stack.add("clarity", amount=20)
latent.undo()
latent.render.preview()
```

A script's stack change comes back as `stack.changed` with `source: "python"`, so the
panels and the viewer update the same way they do for any other writer. The mock engine
only understands `develop.exposure = <number>`; the real interpreter lives in the engine.

Output a long script produces while it is still running arrives as `python.output` and is
shown live; when the call returns, the result's complete `stdout`/`stderr` replace it, so
nothing is printed twice. A run gets `timeoutMs` (30 s by default), after which the engine
interrupts it with `KeyboardInterrupt` and answers with the traceback.
