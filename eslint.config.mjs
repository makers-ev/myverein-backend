import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist/**", "node_modules/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Server code logs via src/lib/logger.ts; console usage is a smell
      // outside CLI scripts (seed-admin.ts is exempt below).
      "no-console": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // CLI/boot scripts, not server runtime -- console output here is
    // intentional (see src/scripts/seed-admin.ts, src/db/migrate.ts).
    files: ["src/scripts/**", "src/db/migrate.ts"],
    rules: {
      "no-console": "off",
    },
  },
]);
