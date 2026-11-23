import { defineConfig } from "tsup";

// models.js is open source: readable output with sourcemaps. One entry, types for it, nothing
// external (the package has no runtime dependency).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  clean: true,
  sourcemap: true,
  minify: false,
  dts: { entry: "src/index.ts" },
  // Bazel builds in a tree of links to the sources. Without this esbuild names each source by the
  // link's target, a path of the build machine's, in the module comments and the source map.
  esbuildOptions(options) {
    options.preserveSymlinks = true;
  },
});
