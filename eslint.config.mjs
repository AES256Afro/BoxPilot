import js from "@eslint/js";
import globals from "globals";

/** Server and scripts are plain ESM JavaScript; the UI is type-checked by tsc in `npm run build`. */
export default [
  { ignores: ["dist/**", "node_modules/**", "docs/**", "catalog/**"] },
  js.configs.recommended,
  {
    files: ["server/**/*.mjs", "scripts/**/*.mjs", "eslint.config.mjs", "vite.config.*"],
    languageOptions: { ecmaVersion: 2025, sourceType: "module", globals: { ...globals.node } },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
      // Redaction and sanitizers match control characters on purpose.
      "no-control-regex": "off",
      // Stylistic in ESLint 10; not worth churn across the tree right now.
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },
];
