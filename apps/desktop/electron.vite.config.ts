import { defineConfig } from "electron-vite";

// The renderer is apps/editor (plain Vite); this config builds main + preload only.
// electron-vite 5 externalizes dependencies by default.
export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: "src/main/index.ts" } } },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        // Sandboxed preload scripts only run CommonJS.
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
});
