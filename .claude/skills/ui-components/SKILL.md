---
name: ui-components
description: Use when building, editing, or styling any UI that consumes @neoworks-dev/ui (Svelte components, pages, forms, layouts) — before writing markup or CSS, so you reuse the shared design system instead of hand-rolling. Lists every available component and its props.
---

# @neoworks-dev/ui component system

This package is the shared Neoworks design system: design tokens plus Svelte UI
primitives. Any project that depends on it should reuse these components before
writing new markup, custom CSS, or a new component.

## Before writing any UI

1. **Read the component reference.** It lists every exported component with its
   props (type, default, required), an import line, a usage skeleton, and a live
   Storybook example path. Find it at:
   - `.claude/skills/ui-components/COMPONENTS.md` — vendored copy in this repo (may lag).
   - `node_modules/@neoworks-dev/ui/COMPONENTS.md` — the linked package, always current.
   - `/home/moritz/Documents/neoworks/neoworks.dev/packages/ui/COMPONENTS.md` — source repo.

   Reach for an existing component before building your own.
2. **Import from the package**, never by relative path into its `src`:
   ```ts
   import { Button, Card, Select } from "@neoworks-dev/ui";
   ```
3. **Use design tokens, not raw values.** Components and Tailwind classes use
   semantic tokens: colors like `bg-elevated`, `bg-raised`, `border-line`,
   `text-default`, `text-muted`, `text-faint`, tone colors (`text-green`,
   `bg-red-soft`), and radii/shadows (`rounded-lg`, `shadow-lg`). Import the
   package styles once (`@neoworks-dev/ui/styles`) and match the tokens the
   existing components use rather than introducing hex values or ad-hoc classes.
4. **Need a real usage example?** Open the `src/stories/<Name>.stories.svelte`
   file named in the reference — it shows the component wired up with props.

## When you add or change a component in this package

Do all of these in the same change:

1. Create the component in `src/lib/` following the `$props()` + JSDoc style of the
   neighbours (the JSDoc feeds the generated reference).
2. Export it from `src/index.ts`.
3. Add a `src/stories/<Name>.stories.svelte` story.
4. Regenerate the reference so consumers see the new API:
   ```sh
   bun run manifest
   ```

`COMPONENTS.md` is generated — never hand-edit it. It is produced from the
component sources by `scripts/generate-manifest.ts`.
