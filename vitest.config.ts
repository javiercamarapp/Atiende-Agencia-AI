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
        "packages/whatsapp-gateway/src/index.ts",
        // Tipos puros (solo `interface`/`type`, sin lógica en tiempo de
        // ejecución) -- distintos de packages/core-tenancy/src/types.ts y
        // packages/domain-licitaciones/src/types.ts, que SÍ tienen funciones
        // reales (type guards, parseo de fechas) y por eso no están aquí.
        "packages/whatsapp-gateway/src/types.ts",
        "packages/domain-despachos/src/types.ts",
        "packages/core-auth/src/types.ts",
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
      // Trinquete anti-regresión, no meta aspiracional -- ver docs/COBERTURA.md
      // para el detalle y cómo subir el umbral cuando la cobertura real suba de
      // forma sostenida.
      //
      // Medido el 2026-09-19 (rama test/web-componentes-verticales, tras sumar
      // tests reales de componentes React de apps/web -- shells/nav móvil de las
      // 6 verticales + Reservas/Folio de hoteles, Pedidos de restaurantes, Agenda
      // de citas, portal de propietario de rentas, Cierre mensual/Cobranza de
      // despachos, decisión go/no-go de licitaciones, MÁS la ronda de corrección
      // de una revisión independiente del PR #154: check-out/asignar-habitación
      // en Reservas, caso de sesión ausente en el portal de propietario):
      // 60.93% líneas/sentencias, 81.8% ramas, 75.41% funciones
      // (`TZ=UTC npm run test:coverage`, 459 archivos / 4920 tests, todos en
      // verde).
      //
      // lines/statements sube de 55 a 58 (~2 puntos por debajo de lo medido,
      // redondeando hacia abajo -- mismo criterio que el umbral original del
      // 2026-09-19 de PR #144). branches/functions se DEJAN igual (80/74) en vez
      // de subirlos: lo medido hoy (81.8%/75.41%) es ligeramente MÁS BAJO que lo
      // medido el 19-sep para PR #144 (82.08%/76.67%) -- no por una regresión de
      // esta rama (no toca SQL ni backend, solo agrega tests), sino porque `main`
      // avanzó con más branches/functions de OTROS PRs en paralelo que esta rama
      // no cubre; aplicar la resta de ~2 puntos aquí bajaría el piso real por
      // debajo de 80/74, que es lo contrario de un trinquete anti-regresión.
      thresholds: {
        lines: 58,
        branches: 80,
        functions: 74,
        statements: 58,
      },
    },
  },
});
