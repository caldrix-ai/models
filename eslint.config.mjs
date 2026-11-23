import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "dist-test/**", "test-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["scripts/**/*.mjs", "tests/e2e/*.mjs"], languageOptions: { globals: { console: "readonly", process: "readonly" } } },
  { files: ["tests/e2e/pages/*.js"], languageOptions: { globals: { window: "readonly", Worker: "readonly" } } },
);
