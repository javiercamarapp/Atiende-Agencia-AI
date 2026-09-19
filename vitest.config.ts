import { coverageConfigDefaults, defineConfig } from "vitest/config";

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
    // Cobertura -- solo se instrumenta cuando algo pasa `--coverage`
    // (`npm run test:coverage`); `npm run test:unit`/`npm test` NO la activan,
    // así que siguen corriendo sin el overhead de instrumentación de v8.
    //
    // IMPORTANTE (léase junto con docs/COBERTURA.md): esta suite corre contra
    // repositorios EN MEMORIA (ver packages/*/src/in-memory-*.ts), no contra
    // Postgres real. Un % de cobertura alto aquí NO certifica que el SQL/RLS
    // esté probado -- eso lo cubre el gate `scripts/verify-*/` contra Postgres
    // real (ver .github/workflows/postgres-real-gate.yml), que ya destapó bugs
    // invisibles para estos tests unitarios.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: [
        "apps/*/src/**",
        "packages/*/src/**",
        "packages/mcp-servers/*/src/**",
      ],
      exclude: [
        ...coverageConfigDefaults.exclude,
        "**/*.d.ts",
        "**/tests/**",
        "**/test-setup/**",
        "**/*.spec.ts",
        "**/*.spec.tsx",
        // Barriles de solo re-export (`export * from "./x"` / `export { a, b }
        // from "./x"`, incluso en listas multilínea) -- cero lógica propia,
        // solo enrutan lo ya cubierto (o no) en los módulos que reexportan.
        // Verificado archivo por archivo (no por nombre "index.ts" a ciegas):
        // apps/api/src/index.ts SÍ tiene lógica real (valida env, define
        // main()) y por eso NO está en esta lista.
        "apps/worker/src/index.ts",
        "packages/agent-core/src/index.ts",
        "packages/agent-core/src/gateway/index.ts",
        "packages/agent-core/src/gateway/providers/index.ts",
        "packages/billing/src/index.ts",
        "packages/core-auth/src/index.ts",
        "packages/core-authz/src/index.ts",
        "packages/core-authz/src/impersonation/index.ts",
        "packages/core-conversation/src/index.ts",
        "packages/core-email/src/index.ts",
        "packages/core-ratelimit/src/index.ts",
        "packages/core-tenancy/src/index.ts",
        "packages/db/src/index.ts",
        "packages/domain-citas/src/index.ts",
        "packages/domain-despachos/src/index.ts",
        "packages/domain-despachos/src/contabilidad-electronica/index.ts",
        "packages/domain-despachos/src/nomina/index.ts",
        "packages/domain-hoteles/src/index.ts",
        "packages/domain-licitaciones/src/index.ts",
        "packages/domain-rentas/src/index.ts",
        "packages/domain-rentas/src/agentes/index.ts",
        "packages/domain-rentas/src/break-glass/index.ts",
        "packages/domain-rentas/src/limpieza/index.ts",
        "packages/domain-rentas/src/mensajeria/index.ts",
        "packages/domain-restaurantes/src/index.ts",
        "packages/mcp-servers/cfdi/src/index.ts",
        "packages/ui/src/index.ts",
        "packages/voice-gateway/src/index.ts",
        "packages/voice-gateway/src/providers/index.ts",
        "packages/whatsapp-gateway/src/index.ts",
        // Tipos puros (solo `interface`/`type`, sin lógica en tiempo de
        // ejecución) -- distintos de packages/core-tenancy/src/types.ts y
        // packages/domain-licitaciones/src/types.ts, que SÍ tienen funciones
        // reales (type guards, parseo de fechas) y por eso no están aquí.
        "packages/whatsapp-gateway/src/types.ts",
        "packages/domain-despachos/src/types.ts",
        "packages/core-auth/src/types.ts",
        "packages/voice-gateway/src/types.ts",
        "packages/domain-citas/src/types.ts",
        "packages/domain-hoteles/src/types.ts",
        "packages/billing/src/types.ts",
        "packages/domain-restaurantes/src/types.ts",
        "packages/domain-rentas/src/types.ts",
        // Dobles de prueba deterministas para servicios externos (nunca tocan
        // la red) -- simuladores, no lógica de negocio.
        "packages/whatsapp-gateway/src/providers/fake-graph-client.ts",
        "packages/agent-core/src/gateway/providers/fake-provider.ts",
        "packages/mcp-servers/cfdi/src/adapters/fake-pac-adapter.ts",
      ],
      // Trinquete anti-regresión, no meta aspiracional -- ~2 puntos por debajo
      // de lo medido el 2026-09-19 (57.82% líneas/sentencias, 82.08% ramas,
      // 76.67% funciones -- ver docs/COBERTURA.md para el detalle y cómo
      // subir el umbral cuando la cobertura real suba de forma sostenida).
      thresholds: {
        lines: 55,
        branches: 80,
        functions: 74,
        statements: 55,
      },
    },
  },
});
