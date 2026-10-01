import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    // Vercel CLI build output (gitignored) — minified bundles, not source:
    ".vercel/**",
    "next-env.d.ts",
    // Harvest package build artifacts:
    "packages/**",
    // Generated app metadata/content maps:
    "src/lib/generated/**",
    // pdf.js worker copied in by scripts/cah-stream/prepare-worker.mjs
    // (gitignored, minified vendor code — six no-this-alias errors, none ours):
    "public/pdfjs/**",
    // Local research/virtualenv artifacts:
    "**/.venv/**",
    // Agent / scratch artifacts (gitignored):
    ".tmp/**",
    ".claude/**",
    // Nested git worktrees. A worktree checked out INSIDE the repo is a second
    // full copy of the tree, so linting it double-reports every file and lets
    // another session's in-progress work fail this session's release gate
    // (2026-09-13: 93 files, 351 errors, none of them on main).
    ".worktrees/**",
    "output/**",
    "audit/image-production/**",
    "coverage/**",
    // Exclude archived/scratch scripts from main lint gate:
    "scripts/archive/**",
    "scripts/ecg-database/.venv/**",
    "scripts/_*.ts",
    "scripts/_*.tsx",
    "scripts/_*.js",
    "scripts/_*.mjs",
    "scripts/_*.cjs",
    // Subdirectory scratch (e.g. scripts/anki-import/_pilot.ts) — same intent
    // as the top-level _*.ts ignores above, but nested:
    "scripts/**/_*.ts",
    "scripts/**/_*.tsx",
    "scripts/**/_*.js",
    // Workflow-tool prompt scripts: prompt-heavy templates, not lintable app source:
    "scripts/**/*.workflow.js",
  ]),
  // Relax strict typing rules in test files (mock typing needs `any`):
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@next/next/no-assign-module-variable": "off",
    },
  },
  // One-off ops/audit/content scripts: relax `any` and `prefer-const`.
  // These are throwaway maintenance scripts, not shipped runtime code —
  // strict typing isn't worth the maintenance burden. Runtime in src/
  // and packages/ stays strict.
  {
    files: [
      "scripts/**/*.{ts,tsx,mjs,js,cjs}",
      "kit/**/*.{ts,tsx,mjs,js,cjs}",
      // Content-review validators kept beside the review records they
      // validate (docs/content-work/<date>/); same one-off status as scripts/.
      "docs/content-work/**/*.{ts,mts}",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "prefer-const": "off",
    },
  },
]);

export default eslintConfig;
