import { defineConfig } from "vitest/config";

export default defineConfig({
  // Under Bazel a test's files are links into the output tree. Following them (the default) lands a
  // test's own path outside its sandbox, where a file it never declared can still be read; kept as
  // given, every path stays among the declared inputs. pnpm's run does not depend on it.
  resolve: { preserveSymlinks: true },
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
