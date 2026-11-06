import js from "@eslint/js";
import globals from "globals";
import useTheInjectedClock from "./eslint-rules/use-the-injected-clock.mjs";

/**
 * Server, scripts and packages are plain ESM JavaScript; the UI is type-checked by tsc in `npm run build`.
 *
 * `boxpilot/use-the-injected-clock` is the invariant M52.1 and M53.1 were both written against
 * (see `eslint-rules/use-the-injected-clock.mjs`): a function given a `now` must use it for dates.
 */
export default [
  { ignores: ["dist/**", "node_modules/**", "docs/**", "catalog/**"] },
  js.configs.recommended,
  {
    files: ["server/**/*.mjs", "scripts/**/*.mjs", "packages/**/*.mjs", "eslint.config.mjs", "vite.config.*"],
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
      "boxpilot/use-the-injected-clock": "error",
    },
    plugins: { boxpilot: { rules: { "use-the-injected-clock": useTheInjectedClock } } },
  },
];
