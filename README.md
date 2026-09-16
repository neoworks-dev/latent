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
bun run lint                # oxlint (TS) + eslint (Svelte markup)
bun run format              # prettier --check + clang-format; format:fix to apply
bun run check:svelte && bun run typecheck && bun test
```

The UI never holds edit state: a slider writes an op and redraws from the frame it gets back.
