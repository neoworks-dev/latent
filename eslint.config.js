import svelte from "eslint-plugin-svelte";
import svelteParser from "svelte-eslint-parser";
import tseslint from "typescript-eslint";
import local from "./tools/eslint-local-plugin.js";

/**
 * ESLint is scoped to Svelte files only — the markup is the one thing oxlint and Biome
 * cannot see, because they parse `<script>` blocks and ignore the template. Everything
 * else is oxlint's.
 *
 * No `projectService` anywhere here: type-aware linting through the Svelte parser costs
 * roughly 0.8s per component, and oxlint already covers those rules via tsgolint.
 */
export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.svelte-kit/**",
      "**/build/**",
      "**/dist/**",
      "**/out/**",
      // C++ daemon and its probe scripts; the engine side owns its own tooling.
      "engine/**",
    ],
  },
  ...svelte.configs.recommended,
  {
    // `.svelte.ts` rune modules are matched by the plugin's base config, so they need the
    // TypeScript sub-parser too — without it the Svelte parser trips on the first `interface`.
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parser: svelteParser,
      parserOptions: { parser: tseslint.parser },
    },
    plugins: { local },
    rules: {
      "svelte/prefer-style-directive": "error",
      "svelte/prefer-class-directive": "error",
      "local/no-class-ternary": "error",
    },
  },
  ...svelte.configs.prettier,
];
