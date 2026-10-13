import { defineConfig, globalIgnores } from "eslint/config";
import tsParser from "@typescript-eslint/parser";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  // Keep the starter on the flat config export that actually runs under the pinned ESLint/Next toolchain.
  ...nextCoreWebVitals,
  { files: ["**/*.mts", "**/*.cts"], languageOptions: { parser: tsParser } },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
