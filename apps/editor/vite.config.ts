import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  // Loaded from file:// inside Electron in production, so assets must be relative.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "chrome130" },
  server: { fs: { allow: [".", "../..", "../../../neoworks"] } },
});
