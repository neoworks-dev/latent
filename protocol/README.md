# Wire protocol: engine ↔ UI

One WebSocket per UI session, `ws://127.0.0.1:<port>/`. The engine prints the port on
stdout as `listening on ws://127.0.0.1:<port>` and the Electron main process passes it to
the renderer.

- **Text frames** carry JSON-RPC 2.0. Requests from the UI, responses from the engine, and
  engine → UI notifications (no `id`). Method names and params are defined in
  `messages.schema.json`; every request has a `<method>Params` and `<method>Result` def.
- **Binary frames** carry pixels, never JSON. Layout in `frames.md`.

`messages.schema.json` is the single source of truth. `packages/protocol` generates TS types
from it (`bun run generate` there); the engine's tests validate its handlers against it.
Never hand-edit the generated file.

Versioning: `engine.hello` returns `protocolVersion`. Bump it on any breaking change to a
def; additive optional fields do not bump it.
