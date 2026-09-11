// Configuración mínima de ESLint (flat config) para el monorepo. Se amplía conforme
// se porten verticales — por ahora solo aplica las reglas recomendadas de
// TypeScript-ESLint sobre el código fuente real (packages/*/src).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);
