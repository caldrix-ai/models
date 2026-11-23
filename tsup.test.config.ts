import { defineConfig } from "tsup";

// The e2e pages (tests/e2e/pages/) into dist-test/, which the loopback server serves at /: the worker
// bundled with the built models.js (dist/index.js, so the e2e runs the shipped code), and store.html
// and its script copied beside it. Never in the tarball.
export default defineConfig({
  entry: ["tests/e2e/pages/store-worker.ts"],
  outDir: "dist-test",
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  clean: true,
  sourcemap: true,
  dts: false,
  esbuildOptions(o) {
    o.alias = { "@caldrix-ai/models": "./dist/index.js" };
  },
  onSuccess: "cp tests/e2e/pages/store.html tests/e2e/pages/store-page.js dist-test/",
});
