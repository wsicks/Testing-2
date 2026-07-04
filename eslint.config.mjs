import { defineConfig } from "eslint/config";
import nextPlugin from "eslint-config-next";

export default defineConfig([
  {
    ignores: [".next/**", "node_modules/**", ".data/**"],
  },
  ...nextPlugin,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // React Compiler diagnostics: valuable signals, but they flag common
      // intentional patterns (hydration flags, sync-from-server drafts,
      // Date.now() freshness reads). Keep them visible as warnings; fix
      // opportunistically rather than blocking CI.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
    },
  },
]);
