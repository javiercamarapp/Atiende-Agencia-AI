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
  // import-orig-11: regresiones del historial con reloj fijo (miercoles 12:00 America/Merida).
  "packages/domain-restaurantes/tests/regresiones-original/historial-completitud.spec.ts",
  // QA R1 automatizacion-03: el "Hoy" del tablero de ventas sigue la zona del negocio, no la del proceso.
  "packages/domain-restaurantes/tests/qa-r1-automatizacion-kpis-hoy-zona.spec.ts",
  "packages/domain-restaurantes/tests/kpis-zona-horaria.spec.ts",
  "packages/domain-restaurantes/tests/pm-c4-herramientas.spec.ts",
  "packages/domain-restaurantes/tests/pm-c5-escenarios-t7.spec.ts",
  "packages/domain-restaurantes/tests/pm-c5-pedido-reciente.spec.ts",
  // PM Ronda 12 (seguimiento de #593): reloj fijo (martes 14:00 / miercoles 02:30 Merida) para el acuse con excepciones por fecha y la ventana de aviso de falla_sistema.
  "packages/domain-restaurantes/tests/pm-r12-seguimiento-silencio.spec.ts",
  // Ronda 2 del loop de PM: hora de recogida y programado validados contra el reloj del servidor; reloj local de consultar_sucursal.
  "packages/domain-restaurantes/tests/pm-r2-flujo-pedido-y-hora.spec.ts",
  // Ronda 5 del loop de PM: reloj fijo (miercoles 12:00 / martes 13:00 Merida) para hora de recogida, kilos, relleno del modelo y entradas hostiles.
  "packages/domain-restaurantes/tests/pm-r5-contrato-relleno-del-modelo.spec.ts",
  "packages/domain-restaurantes/tests/pm-r5-entradas-hostiles.spec.ts",
  "packages/domain-restaurantes/tests/pm-r5-hora-recoger-unificada.spec.ts",
  "packages/domain-restaurantes/tests/pm-r5-kilos.spec.ts",
  "packages/domain-restaurantes/tests/pm-r2-prompt-y-reloj.spec.ts",
  "packages/domain-restaurantes/tests/recoger-estados-y-columnas.spec.ts",
  // Hora de recogida (+30 min aceptado, -5/-11 min, +6/+8 dias): reloj fijo, sin depender de la hora UTC en que corra el CI.
  "packages/domain-restaurantes/tests/qa-r2-caos.spec.ts",
  "packages/domain-restaurantes/tests/cliente-llego-recoger.spec.ts",
  // Ronda 6 del loop de PM: pedido igual entre llamadas (ventana de 10 min con reloj fijo), saludo de las 19:00 vs 20:00 en zona explicita y turnos con falla del sistema.
  "packages/domain-restaurantes/tests/pm-r6-pedido-igual-entre-llamadas.spec.ts",
  "packages/domain-citas/tests/pm-r6-saludo-franja.spec.ts",
  "apps/web/tests/saludo-misma-franja-r5.spec.ts",
  "apps/api/tests/pm-r6-voz-quote-reenvia-plazo.spec.ts",
  "packages/domain-restaurantes/tests/evals-agente-pm-k.spec.ts",
  // Prueba ciega de voz: reloj fijo (miercoles 12:00 Merida); V27 calcula la hora de recogida con el reloj del servidor.
  "packages/domain-restaurantes/tests/voz-simulador-prueba-ciega.spec.ts",
  "apps/api/tests/pm-r2-voz-programado.spec.ts",
  // R12: cobertura por turnos con reloj fijo (mediodia Merida); el turno 00:00-23:59 deja un hueco a las 23:59 del negocio.
  "apps/api/tests/restaurantes-conversaciones.spec.ts",
  // Cotizacion a domicilio valida horario de la sucursal: reloj fijo (miercoles 12:00 Merida), no la hora UTC del CI.
  "packages/domain-restaurantes/tests/sucursal-mas-cercana-8km.spec.ts",
  "apps/api/tests/rentas-pricing-servidor-hoy.spec.ts",
  "apps/api/tests/rentas-cotizacion-servidor-hoy.spec.ts",
  "apps/api/tests/hoteles-night-audit-servidor-hoy.spec.ts",
  "apps/api/tests/hoteles-recepcion.spec.ts",
  "apps/api/tests/hoteles-fechas-lista-espera-reloj.spec.ts",
  // Barrido de recomendaciones de tarifa: reloj fijo (miercoles 12:00 Merida); el horizonte de 45 dias chocaba con las tarifas 2026-12-01..03 de la fixture desde el 2026-10-17.
  "apps/api/tests/hoteles-revenue-recommendations-cron.spec.ts",
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
  "apps/api/tests/e2e-ciclo/programado-pos-ciclo.spec.ts",
  // R-16: alertas operativas (entrega tardia / programado por vencer) del tick de programados: reloj fijo en Merida/Cancun/CDMX.
  "apps/api/tests/restaurantes-avisos-operativos-tick.spec.ts",
  // Autopiloto 2: alertas al dueno (dedupe por dia de Merida con reloj fijo en Merida/Cancun/CDMX) y borradores de campana del tick.
  "packages/domain-restaurantes/tests/alertas-duenio-proveedor.spec.ts",
  "packages/domain-restaurantes/tests/alertas-duenio-silencio.spec.ts",
  "packages/domain-restaurantes/tests/alertas-duenio-token-meta.spec.ts",
  "packages/domain-restaurantes/tests/alertas-duenio-timeouts-agente.spec.ts",
  "apps/api/tests/restaurantes-marketing-tick.spec.ts",
  "apps/api/tests/restaurantes-silencio-tick.spec.ts",
  "apps/api/tests/restaurantes-presupuesto-ia-duenio.spec.ts",
  // CFO-09: copiloto CFO (periodos relativos a "hoy" en la zona del negocio) y alertas de hallazgos (dia de negocio = ayer en la zona de la organizacion).
  "packages/domain-restaurantes/tests/data-chat-cfo-tools.spec.ts",
  "packages/domain-restaurantes/tests/data-chat-cfo-evals.spec.ts",
  "packages/domain-restaurantes/tests/data-chat-cfo-roles-y-guardia.spec.ts",
  "packages/domain-restaurantes/tests/cfo-alertas.spec.ts",
  "apps/api/tests/restaurantes-cierres-alertas-cfo.spec.ts",
  // R11 romper: horarios limite (cierre 01:00, medianoche, cambio de dia de negocio) y programado_para con reloj fijo (martes 13:00 Merida).
  "packages/domain-restaurantes/tests/pm-r11-romper/5-negocio-y-privacidad.spec.ts",
  // R12 romper (ronda 2): reloj fijo (martes 13:00 Merida) para hora pasada, feriado, programados, cambio de horario de verano (America/Tijuana), medianoche y reloj que retrocede.
  "packages/domain-restaurantes/tests/pm-r11-romper/7-ronda-2-imposibles.spec.ts",
  "packages/domain-restaurantes/tests/pm-r11-romper/8-ronda-2-cambios-en-la-conversacion.spec.ts",
  "packages/domain-restaurantes/tests/pm-r11-romper/10-ronda-2-abuso-de-negocio.spec.ts",
  "packages/domain-restaurantes/tests/pm-r11-romper/11-ronda-2-fallas-de-infraestructura.spec.ts",
  "packages/domain-restaurantes/tests/pm-r11-romper/12-ronda-2-formatos-y-tipos.spec.ts",
] as const;

// `coverage` (y su umbral) se queda como en la config base: solo se evalua con `--coverage`, que este guard no usa.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [...SPECS_SENSIBLES_AL_RELOJ],
  },
});
