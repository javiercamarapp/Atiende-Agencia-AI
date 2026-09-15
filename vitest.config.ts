import { defineConfig } from "vitest/config";

export default defineConfig({
  // Hallazgo de auditoría (rubro 9, MEDIO -- "0 tests de componentes React en
  // todo el repo"): las suites *.spec.tsx (smoke tests de componentes de
  // apps/web) necesitan el runtime JSX automático para transformar sus .tsx --
  // sin esto, esbuild no sabe qué hacer con JSX fuera de src/**/*.tsx (que solo
  // se transforma vía apps/web/vite.config.ts, nunca a través de este
  // vitest.config.ts raíz). Deliberadamente NO se agrega
  // @testing-library/react (no estaba ya instalado en el repo): estas suites
  // usan react-dom/client + jsdom directo -- ver
  // apps/web/tests/test-utils/render.tsx.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ["default"],
    // Hallazgo de auditoría (rubro 2, "sin rate-limit en /auth/login, /auth/refresh,
    // accept-invite") — ver el comentario de cabecera del archivo para el porqué.
    setupFiles: ["./test-setup/reset-rate-limiter.ts"],
    include: [
      "packages/*/tests/**/*.spec.ts",
      "packages/mcp-servers/*/tests/**/*.spec.ts",
      "apps/*/tests/**/*.spec.ts",
      "apps/*/tests/**/*.spec.tsx",
    ],
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**"],
  },
});
