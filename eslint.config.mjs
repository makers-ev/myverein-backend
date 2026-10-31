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
    // The audit trail is written through writeAudit (src/lib/audit.ts) only: per-event payload whitelist, club and actor.
    files: ["src/**/*.ts"],
    ignores: ["src/lib/audit.ts", "src/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='insert'][arguments.0.name='auditLog']",
          message: "Write audit entries with writeAudit() from src/lib/audit.ts, not with a direct insert into audit_log.",
        },
      ],
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
