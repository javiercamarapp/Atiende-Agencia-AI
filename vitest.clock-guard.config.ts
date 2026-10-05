// PL-12 guard anti-bombas de tiempo: una seleccion RAPIDA (solo specs, todas con relojes simulados o con
// `servidor-hoy`/zona horaria en el nombre) de la suite, para correr bajo varias zonas horarias del proceso
// (`TZ=...`) sin pagar la suite completa. Lo usa `npm run test:clock-guard` y el job `clock-guard` de
// .github/workflows/clock-guard.yml. Anadir aqui cualquier spec nueva sensible al reloj o a la zona.
//
// Regla: un spec entra si fija el reloj (vi.setSystemTime / vi.useFakeTimers) o prueba "hoy"/vencimientos/
// fin de mes en la zona del negocio. Los specs de la lista deben pasar IGUAL con cualquier TZ del proceso:
// si uno solo pasa con TZ=UTC, ese es justo el bug que este guard existe para cazar.
import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

export const SPECS_SENSIBLES_AL_RELOJ = [
  "packages/core-tenancy/tests/fecha-negocio.spec.ts",
  "packages/core-tenancy/tests/reloj-simulado-fronteras.spec.ts",
  "packages/domain-hoteles/tests/postgres-repository-fecha-negocio-param.spec.ts",
  "packages/domain-hoteles/tests/reservas-agente/escenarios-adversariales.spec.ts",
  "packages/domain-licitaciones/tests/postgres-repository-fecha-negocio-param.spec.ts",
  "packages/domain-rentas/tests/postgres-repository-fecha-negocio-param.spec.ts",
  "packages/domain-citas/tests/whatsapp-llm-turn-handler-zona-horaria.spec.ts",
  "packages/domain-citas/tests/reminders-ventana-cron.spec.ts",
  "packages/domain-restaurantes/tests/zona-horaria-branch-savepoint.spec.ts",
  // QA R1 automatizacion-03: el "Hoy" del tablero de ventas sigue la zona del negocio, no la del proceso.
  "packages/domain-restaurantes/tests/qa-r1-automatizacion-kpis-hoy-zona.spec.ts",
  "packages/domain-restaurantes/tests/kpis-zona-horaria.spec.ts",
  "packages/domain-restaurantes/tests/pm-c4-herramientas.spec.ts",
  "packages/domain-restaurantes/tests/pm-c5-escenarios-t7.spec.ts",
  "packages/domain-restaurantes/tests/pm-c5-pedido-reciente.spec.ts",
  "apps/api/tests/rentas-pricing-servidor-hoy.spec.ts",
  "apps/api/tests/rentas-cotizacion-servidor-hoy.spec.ts",
  "apps/api/tests/hoteles-night-audit-servidor-hoy.spec.ts",
  "apps/api/tests/hoteles-recepcion.spec.ts",
  "apps/api/tests/hoteles-fechas-lista-espera-reloj.spec.ts",
  "apps/api/tests/hoteles-huespedes.spec.ts",
  "apps/api/tests/despachos-bookkeeping-servidor-hoy.spec.ts",
  "apps/api/tests/despachos-cierre-mensual-servidor-hoy.spec.ts",
  "apps/api/tests/despachos-cobranza-servidor-hoy.spec.ts",
  "apps/api/tests/despachos-vencimientos-servidor-hoy.spec.ts",
  "apps/api/tests/despachos-zona-horaria-vencimientos.spec.ts",
  "apps/api/tests/licitaciones-organization-timezone-servidor-hoy.spec.ts",
  "apps/api/tests/licitaciones-rate-servidor-hoy.spec.ts",
  "apps/api/tests/citas-availability-overrides-servidor-hoy.spec.ts",
  "apps/worker/tests/despachos-cobranza-reminders-servidor-hoy.spec.ts",
  // R-23: banco e2e del ciclo de restaurantes (reloj simulado: martes 13:00 de Merida, lunes, cierre, programados).
  "apps/api/tests/e2e-ciclo/whatsapp-cliente-nuevo.spec.ts",
  "apps/api/tests/e2e-ciclo/whatsapp-casos.spec.ts",
  "apps/api/tests/e2e-ciclo/voz-ciclo.spec.ts",
  "apps/api/tests/e2e-ciclo/storefront-ciclo.spec.ts",
  "apps/api/tests/e2e-ciclo/programado-pos-ciclo.spec.ts",
  // R-16: alertas operativas (entrega tardia / programado por vencer) del tick de programados: reloj fijo en Merida/Cancun/CDMX.
  "apps/api/tests/restaurantes-avisos-operativos-tick.spec.ts",
  // Autopiloto 2: alertas al dueno (dedupe por dia de Merida con reloj fijo en Merida/Cancun/CDMX) y borradores de campana del tick.
  "packages/domain-restaurantes/tests/alertas-duenio-proveedor.spec.ts",
  "packages/domain-restaurantes/tests/alertas-duenio-silencio.spec.ts",
  "apps/api/tests/restaurantes-marketing-tick.spec.ts",
  "apps/api/tests/restaurantes-silencio-tick.spec.ts",
  "apps/api/tests/restaurantes-presupuesto-ia-duenio.spec.ts",
] as const;

// `coverage` (y su umbral) se queda como en la config base: solo se evalua con `--coverage`, que este guard no usa.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [...SPECS_SENSIBLES_AL_RELOJ],
  },
});
