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
  {
    // Script de navegador en JS plano servido tal cual desde public/ (tema sin destello): globals reales del navegador.
    files: ["apps/web/public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: globals.browser,
    },
  },
  {
    // AudioWorklet servido desde public/ (voz/captura-pcm-worklet.js): corre en AudioWorkletGlobalScope, no en window;
    // sus globals reales son AudioWorkletProcessor, registerProcessor, sampleRate, etc. (va despues del bloque de navegador para ganarle).
    files: ["apps/web/public/**/*-worklet.js"],
    languageOptions: {
      sourceType: "script",
      globals: globals.audioWorklet,
    },
  },
);
