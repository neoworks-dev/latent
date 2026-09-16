---
name: extension-system
description: How to write plugins and services for @neoworks/extension-system — the plugin kernel with revertible effects and reactive dependency resolution. Use whenever writing, reviewing, or debugging code that imports Context, Service, or Fiber from @neoworks/extension-system. Covers ctx.effect, inject/provide, the fiber lifecycle, the five event dispatch modes, isolate/intercept, and the mistakes that silently break unloading.
---

`@neoworks/extension-system` is a plugin kernel. Two ideas carry everything:

1. **Revertible effects** — a plugin hands the runtime an *inverse* for everything it does, so
   removing it unwinds cleanly. No restart.
2. **Reactive dependencies** — a plugin declares what it needs. The runtime runs it only while
   those things exist, and reloads it if they're replaced.

Derived from [Cordis](https://github.com/cordiverse/cordis) (MIT). Zero runtime dependencies.

## The one rule

**Anything a plugin does to the outside world must be registered with its inverse.** If you
can't answer "what undoes this?", the plugin can't be unloaded, and the entire point is lost.

```ts
ctx.effect(() => {
  const proc = spawn('tsserver')
  return () => proc.kill()      // ← the inverse. Always return one.
}, 'tsserver')                  // ← label; shows up in ctx.fiber.getEffects()
```

Anything reached through `ctx` is already tracked — `ctx.on`, `ctx.provide`, `ctx.plugin`,
`ctx.accessor`, `ctx.mixin`, `ctx.logger.exporter` all register through `ctx.effect` internally.
You only need `ctx.effect` when touching a **raw** API: `setInterval`, a DOM listener, a child
process, a file watcher, a WebSocket, a third-party library's `subscribe()`.

Pure computation needs no effect. Don't wrap things that have no inverse.

## Writing a plugin

Three accepted shapes. All get `(ctx, config)`.

```ts
// function
const plugin = (ctx: Context, config: Config) => { /* ... */ }
plugin.inject = ['lsp']
plugin.name = 'my-plugin'

// object
export default {
  name: 'my-plugin',
  inject: ['lsp'],
  Config: z.object({ path: z.string() }),
  apply(ctx: Context, config) { /* ... */ },
}

// class
class MyPlugin {
  static inject = ['lsp']
  constructor(ctx: Context, config: Config) { /* ... */ }
}
```

Mount it:

```ts
const fiber = ctx.plugin(MyPlugin, { path: '/usr/bin/tsserver' })
await fiber            // resolves when ACTIVE, throws if the plugin threw
```

`ctx.plugin()` returns a thenable `Fiber`. **It does not run synchronously.** If `inject` isn't
satisfied the fiber sits in `PENDING` and the callback never fires — this is correct behaviour,
not an error.

### Config validation

`Config` is any [Standard Schema](https://standardschema.dev) — zod, valibot, arktype all work.
Validation failure throws `ValidationError` with per-issue paths.

**Async validation is not supported** and throws `'Async config validation is not supported'`.
Don't use `z.string().refine(async ...)`.

## Depending on things

```ts
plugin.inject = ['lsp', 'buffers']                    // array form
plugin.inject = { lsp: { timeout: 5000 } }            // object form: also intercepts config
```

Inside the plugin, `ctx.lsp` is guaranteed live. Then:

- Provider disappears → this plugin deactivates (effects revert) and returns to `PENDING`.
- Provider reappears → it reactivates, effect callback runs again from scratch.
- Provider is *replaced by a different provider* → reload. Resolution is by provider identity
  (fiber uid), so an unrelated context change does **not** cause a reload.

For a one-off block rather than a whole plugin:

```ts
ctx.inject(['lsp'], (ctx) => {
  ctx.effect(() => ctx.lsp.register(handler))
})
```

### Providing

```ts
ctx.provide('buffers', new BufferStore())        // returns a disposer, auto-tracked
```

Or as a service class, which registers itself in the constructor:

```ts
class Buffers extends Service {
  static inject = ['workspace']

  constructor(ctx: Context) {
    super(ctx, 'buffers')      // ← the key it claims: ctx.buffers
  }

  // optional: dependents stay PENDING until this resolves
  async [Service.init]() {
    await this.load()
  }
}

ctx.plugin(Buffers)
```

Declare the key on the Context interface so consumers get types:

```ts
declare module '@neoworks/extension-system' {
  interface Context {
    buffers: Buffers
  }
}
```

## Effect forms

`ctx.effect(fn)` accepts four return shapes:

```ts
ctx.effect(() => disposer)                       // sync
ctx.effect(async () => disposer)                 // promise
ctx.effect(function* () {                        // generator — stepwise rollback
  yield openA()
  yield openB()                                  // if this throws, A is rolled back
  yield openC()
})
ctx.effect(async function* () { /* ... */ })     // async generator; abortable mid-iteration
```

Use a **generator** for multi-step setup. If step 3 throws, steps 1–2 are unwound in LIFO order
and nothing is left installed. This is the main reason to prefer it over one big try/catch.

`ctx.effect` returns a disposer that is also thenable:

```ts
const dispose = ctx.effect(...)
dispose()                    // revert now; idempotent — calling twice does nothing
const d = await ctx.effect(...)   // wait for an async effect to settle, then get the disposer
```

## Lifecycle

```
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
                       ↘ FAILED
```

`FiberState` is a plain enum (not `const enum`), so it's safe under `isolatedModules`.

```ts
await fiber                  // wait for ACTIVE; rethrows the plugin's error
await fiber.dispose()        // unload; reverts every effect
fiber.update(config)         // re-validate config and restart; clears FAILED
await fiber.restart()
fiber.state                  // FiberState
ctx.fiber.getEffects()       // labelled tree of everything currently installed
```

A `FAILED` fiber does **not** retry on its own. Only `update()` clears the error.

## Events

Five dispatch modes. Pick deliberately — the mode is part of an event's contract.

| Mode | Awaited | Returns | Use for |
| --- | --- | --- | --- |
| `emit` | no | — | fire-and-forget notification |
| `parallel` | yes | — | async notification, all at once; aggregates errors |
| `serial` | yes | first non-nullish | async chain, first responder wins |
| `bail` | no | first non-nullish | sync chain, first responder wins |
| `waterfall` | no | transformed value | middleware that wraps/mutates a result |

```ts
const dispose = ctx.on('buffer/open', (buf) => { /* ... */ })   // auto-unbound on unload
ctx.on('x', fn, { prepend: true })    // only when it MUST run before ordinary listeners
```

**`waterfall` takes a final inner callback** — this trips people up:

```ts
// listeners have signature (value, next)
ctx.on('resolve/path', (value, next) => value + next())

ctx.waterfall('resolve/path', 1, () => 2)   // ← the () => 2 is the innermost handler
```

A listener that returns without calling `next()` short-circuits the chain.

Declare event types by augmentation:

```ts
declare module '@neoworks/extension-system' {
  interface Events {
    'buffer/open'(buf: Buffer): void
    'resolve/path'(value: number, next: () => number): number
  }
}
```

## isolate and intercept

```ts
const windowCtx = ctx.isolate('sidebar')       // subtree gets its own `sidebar` behind same key
const scoped = ctx.intercept('fs', { root: '/workspace' })   // per-consumer service config
```

`isolate` is how you give each window/workspace its own instance of a service without plugins
knowing windows exist. `intercept` is how you attenuate a service for one consumer without
touching the provider — the provider reads its merged config via `Service[Service.resolveConfig]`.

Neither triggers a reload of unrelated fibers.

## Mistakes that matter

**Using the outer `ctx` inside a plugin.** Effects are attributed to whichever fiber's context
you call them on. Capturing a module-level or parent `ctx` means your effects attach to the
*wrong* fiber and survive your plugin's unload.

```ts
// WRONG — effect belongs to root, leaks when this plugin unloads
const plugin = (ctx) => { root.effect(() => ...) }
// RIGHT
const plugin = (ctx) => { ctx.effect(() => ...) }
```

**Accessing a service you didn't inject.** Inside a plugin this *throws*:
`cannot get property "lsp" without inject`. Add it to `inject`. (On the root context it
returns undefined instead — so a bug can hide until the code moves into a plugin.)

**Assigning to `ctx.foo` without providing it** throws `cannot set property "foo" without provide`.

**Registering a raw side effect bare.** `setInterval(...)` outside `ctx.effect` is invisible to
the runtime and survives unload. Same for DOM listeners, watchers, sockets, and any
third-party `.on()` that isn't `ctx.on`.

**Calling `ctx.effect` after disposal** throws `CordisError: cannot create effect on inactive
context`. Usually means a stale closure or an async continuation that outlived its fiber. Check
`ctx.fiber.state` before doing deferred work.

**Holding references across a reload.** A fiber's `store` is rebuilt on reactivation. Don't
cache a resolved service in a module-level variable — read it off `ctx` each time.

**Double-providing.** A `Service` subclass registers itself in `super(ctx, name)`. Don't also
call `ctx.provide(name, ...)`; you'll get
`service "name" has been registered at <...>`.

**Expecting proxy semantics on every property.** Properties that are symbols, numeric strings,
`prototype`, `then`, or `_`-prefixed bypass the context proxy entirely — no inject check, no
service resolution, no tracing. Don't name a service key or a public service member that way.

**Assuming a flat key namespace is safe.** Linking is by key name only, with no structural or
version check. Two providers claiming the same key is an error at registration, but a *consumer*
compiled against an older interface will bind happily and fail at runtime. Pick a naming
convention before third-party plugins can `provide`.

## Testing a plugin

```ts
import { Context, FiberState } from '@neoworks/extension-system'

const root = new Context()
const fiber = root.plugin(MyPlugin)
await sleep()                                    // let the fiber settle
expect(fiber.state).to.equal(FiberState.PENDING) // no provider yet

await root.plugin(Provider)
expect(fiber.state).to.equal(FiberState.ACTIVE)

await fiber.dispose()
// assert every side effect reverted
```

The standard assertion for correct plugin authoring: **mount, unmount, and check that observable
state is exactly what it was before mounting.** If something is left behind, an effect is missing
its inverse.
