import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const pkg = JSON.parse(read("package.json")) as Record<string, unknown>;

describe("CHANGELOG", () => {
  it("has the package version as its top entry", () => {
    const top = /^## (\S+)/m.exec(read("CHANGELOG.md"));
    expect(top?.[1]).toBe(pkg.version);
  });
});

describe("license", () => {
  it("is Apache-2.0 in the manifest, with the text and the notice shipped", () => {
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.name).toBe("@caldrix-ai/models");
    expect(pkg.files).toEqual(expect.arrayContaining(["LICENSE", "NOTICE"]));
    expect(read("LICENSE")).toContain("Apache License\n                           Version 2.0, January 2004");
    expect(read("NOTICE")).toMatch(/^models\.js \(the npm package @caldrix-ai\/models\)\nCopyright 2026 /);
  });
});

describe("the package's public text", () => {
  it("the_readme_names_nothing_internal", () => {
    // The README speaks in the user's terms: no internal crate, implementation language or toolchain.
    const text = [read("README.md"), String(pkg.description)].join("\n").toLowerCase();
    for (const word of ["rust", "wasm", "webassembly", "cargo", "crate", "caldrix-models", "inferno"]) {
      expect(new RegExp(`\\b${word}\\b`).test(text), word).toBe(false);
    }
    expect(read("README.md")).toContain("Hugging Face");
  });

  it("has no runtime dependency", () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });
});
