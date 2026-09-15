// Configuración mínima de ESLint (flat config) para el monorepo. Se amplía conforme
// se porten verticales — por ahora solo aplica las reglas recomendadas de
// TypeScript-ESLint sobre el código fuente real (packages/*/src).
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Scripts de Node en JS plano (fuera de TS, donde no-undef ya se desactiva
    // vía typescript-eslint/eslint-recommended): declara sus globals reales
    // (process, console, etc.) en vez de dejar que no-undef truene en falso.
    files: ["scripts/**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
);
