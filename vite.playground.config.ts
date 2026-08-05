import { defineConfig } from "vite";

// Dev-only playground. Not part of the library build (tsup) or the npm
// package (`files` in package.json) — run it with `npm run playground`.
export default defineConfig({
  root: "playground",
  server: { open: true },
});
