import { defineConfig } from "tsup";

export default defineConfig([
  // Browser runtime — OfflineTracker.
  {
    entry: {
      index: "src/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    splitting: true,
    treeshake: true,
    sourcemap: true,
    clean: true,
    target: "es2020",
    external: ["@dmytromykhailiuk/network-connection", "@dmytromykhailiuk/cache-request"],
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  // Node CLI — offline-postbuild. CJS so the `bin` entry works regardless of
  // the consumer's module system; `clean: false` keeps pass one's output.
  {
    entry: {
      cli: "src/cli.ts",
    },
    format: ["cjs"],
    platform: "node",
    target: "node18",
    dts: false,
    sourcemap: true,
    clean: false,
    external: ["esbuild"],
    banner: { js: "#!/usr/bin/env node" },
    outExtension() {
      return { js: ".cjs" };
    },
    onSuccess: "chmod +x dist/cli.cjs",
  },
]);
