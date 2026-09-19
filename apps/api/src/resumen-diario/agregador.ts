// Agregador de I/O del resumen diario -- el ÚNICO lugar que lee las 10
// fuentes de sistema (`deps.resumenDiarioRepo`), combina el resultado con el
// motor puro (`./motor.ts::combinarDiarioAgregados`), redacta (`./
// redaccion.ts::redactarResumenDiario`) y persiste
// (`deps.resumenDiarioRepo.upsertDailyOpsSummary`). UN SOLO camino de código
// para las 2 formas de disparar la generación (ver `../routes/internal/
// resumen-diario.ts` para el cron y `../routes/superadmin-resumen.ts` para
// "generar ahora") -- "generar ahora" ya verificó en la capa HTTP que el
// caller es superadmin ANTES de llamar aquí; de ahí en adelante corre en
// sesión de SISTEMA exactamente igual que el cron (es, en esencia, el MISMO
// cálculo de plataforma, sin importar quién lo disparó).
//
// Cada lectura de fuente está envuelta en su propio try/catch INDEPENDIENTE
// (`leer` abajo) -- un fallo en, p. ej., `getFacturacionAgregadoForSystem`
// nunca debe tumbar la lectura de crons o de prospectos -- se convierte en
// `null` para esa sección, que `combinarDiarioAgregados` (puro) transforma en
// "no se pudo leer" (nunca en "todo en cero").
import { isUndefinedFunctionError } from "@atiende/db";
import type { AppDeps } from "../deps.ts";
import { combinarDiarioAgregados, fechaAyerMexico, PROSPECTOS_SIN_MOVIMIENTO_DIAS, TOP_ORGANIZACIONES_GASTO_LLM, umbralSinMovimiento, ventanaDiaMexico, type DiarioAgregados, type FuentesDiarias } from "./motor.ts";
import { redactarResumenDiario } from "./redaccion.ts";

async function leer<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Lee las 10 fuentes de la fecha dada, cada una independiente (ver el
 *  comentario de cabecera). Pura respecto al reloj: `ahora` se recibe como
 *  parámetro (el umbral de "prospectos sin movimiento" es relativo a
 *  `ahora`, no a `fecha` -- un prospecto puede llevar meses sin movimiento
 *  sin importar qué día se esté resumiendo). */
export async function leerFuentesDiarias(deps: AppDeps, fecha: string, ahora: Date): Promise<FuentesDiarias> {
  const ventana = ventanaDiaMexico(fecha);
  const repo = deps.resumenDiarioRepo;

  const [crons, colas, licitacionesFuentes, llmPlatformBudget, gastoLlmHoy, topOrganizacionesGastoLlm, organizacionesStaffNuevos, prospectos, facturacion, breakGlassAbiertos] = await Promise.all([
    leer(() => repo.listCronHeartbeatsForSystem()),
    leer(() => repo.getOutboxHealthForSystem(ventana)),
    leer(() => repo.listLicitacionesFuenteRunsForSystem()),
    leer(() => repo.getLlmPlatformBudgetForSystem()),
    leer(async () => {
      const t = await repo.getLlmUsageTotalForSystem(fecha);
      return { costoMicroUsd: t.costMicroUsd, tokensIn: t.tokensIn, tokensOut: t.tokensOut, llamadas: t.callCount };
    }),
    leer(async () => (await repo.listLlmUsageTopOrganizacionesForSystem(fecha, TOP_ORGANIZACIONES_GASTO_LLM)).map((o) => ({ organizationId: o.organizationId, organizationName: o.organizationName, vertical: o.vertical, costoMicroUsd: o.costMicroUsd, llamadas: o.callCount }))),
    leer(() => repo.getOrganizacionesStaffNuevosForSystem(ventana)),
    leer(() => repo.getProspectosAgregadoForSystem(ventana, umbralSinMovimiento(ahora, PROSPECTOS_SIN_MOVIMIENTO_DIAS))),
    leer(() => repo.getFacturacionAgregadoForSystem(ventana)),
    leer(() => repo.countBreakGlassAbiertosForSystem(ventana)),
  ]);

  return { fecha, crons, colas, licitacionesFuentes, llmPlatformBudget, gastoLlmHoy, topOrganizacionesGastoLlm, organizacionesStaffNuevos, prospectos, facturacion, breakGlassAbiertos };
}

/** Trae el `DiarioAgregados` YA persistido del día calendario anterior a
 *  `fecha` -- para las deltas del motor puro. `null` cuando no existe
 *  (primer día del feature, o un hueco de días sin cron) o cuando la lectura
 *  falla -- ambos casos se tratan igual: sin deltas para hoy, nunca un
 *  error que tumbe la generación del resumen de HOY. */
async function leerAgregadosAyer(deps: AppDeps, fecha: string): Promise<DiarioAgregados | null> {
  const ayer = fechaAyerMexico(new Date(`${fecha}T12:00:00.000Z`));
  const resumenAyer = await leer(() => deps.resumenDiarioRepo.getDailyOpsSummaryForSystem(ayer));
  if (!resumenAyer) return null;
  // `agregados` se guardó como jsonb -- confiamos en la forma que este mismo
  // agregador escribió (nunca dato externo/no controlado), sin validación de
  // schema adicional, mismo criterio que el resto del back office de
  // plataforma con columnas jsonb propias.
  return resumenAyer.agregados as DiarioAgregados;
}

export interface ResultadoGeneracion {
  readonly ok: true;
  readonly agregados: DiarioAgregados;
  readonly narrativa: string;
  readonly generadoPor: "llm" | "determinista";
}

/** El UPSERT final (`core.upsert_daily_ops_summary`, igual que las 10 lecturas
 *  de `leerFuentesDiarias` y `getDailyOpsSummaryForSystem`) es una función
 *  SQL nueva de `packages/db/migrations/0015_superadmin_resumen_diario.sql`
 *  -- sin aplicar en la base real (ver REGLA DURA de compatibilidad del
 *  repo), este cron respondía 500 todos los días DESPUÉS de gastar una
 *  llamada real de LLM en `redactarResumenDiario` (las 10 lecturas ya se
 *  tragaban su propio 42883 en `leer()` como "no se pudo leer", pero el
 *  UPSERT corre fuera de ese wrapper, sin try/catch). */
export interface ResultadoMigracionPendiente {
  readonly ok: false;
  readonly motivo: "migracion_pendiente";
}

export type ResultadoGenerarResumenDiario = ResultadoGeneracion | ResultadoMigracionPendiente;

/** Sondeo barato ANTES de redactar con el LLM -- `listCronHeartbeatsForSystem`
 *  es una simple lectura de una sola tabla (`core.cron_heartbeat`, sin
 *  agregación) y, como TODAS las funciones `_for_system`/de escritura que
 *  usa este agregador, viene del MISMO bloque `CREATE OR REPLACE FUNCTION`
 *  de `0015_superadmin_resumen_diario.sql` -- si esta no existe, ninguna de
 *  las otras 11 (10 lecturas + el UPSERT final) existe tampoco, así que basta
 *  con este único sondeo para saber por adelantado que el UPSERT fallaría, y
 *  cortar la generación ANTES de la llamada de LLM (no después, como pasaba
 *  antes de este fix con `leerFuentesDiarias`, que se traga el 42883 de sus
 *  10 lecturas dentro de `leer()` y sigue adelante como si nada). */
async function migracionResumenDiarioAplicada(deps: AppDeps): Promise<boolean> {
  try {
    await deps.resumenDiarioRepo.listCronHeartbeatsForSystem();
    return true;
  } catch (err) {
    if (isUndefinedFunctionError(err)) return false;
    // Error real (conexión, permisos, etc.) -- NO es señal de "migración
    // pendiente"; se deja que el flujo normal continúe exactamente como
    // antes de este fix (esas 10 lecturas ya lo tragaban como `null` vía
    // `leer()` -- este sondeo nunca debe volverse más estricto que eso para
    // errores que no sean 42883).
    return true;
  }
}

/** Genera Y PERSISTE el resumen de `fecha` -- idempotente (el UPSERT de
 *  `core.upsert_daily_ops_summary` actualiza en vez de duplicar). Punto de
 *  entrada único para el cron y para `POST /superadmin/resumen/generar`.
 *  Cada llamada a `deps.resumenDiarioRepo.*` abre su PROPIA transacción
 *  (`ProductionResumenDiarioRepository::sistema` llama `engine.
 *  withAppSession` una vez por método) -- el sondeo de abajo, las 10+1
 *  lecturas y el UPSERT final nunca comparten transacción entre sí, así que
 *  un catch simple basta aquí: no hace falta SAVEPOINT (a diferencia de un
 *  fallback que siguiera consultando DENTRO de la misma transacción ya
 *  abortada por el error). */
export async function generarYPersistirResumenDiario(deps: AppDeps, fecha: string, ahora: Date = new Date()): Promise<ResultadoGenerarResumenDiario> {
  if (!(await migracionResumenDiarioAplicada(deps))) {
    return { ok: false, motivo: "migracion_pendiente" };
  }

  const [fuentes, agregadosAyer] = await Promise.all([leerFuentesDiarias(deps, fecha, ahora), leerAgregadosAyer(deps, fecha)]);
  const agregados = combinarDiarioAgregados(fuentes, agregadosAyer);
  const { narrativa, generadoPor, costoLlmMicroUsd, modeloLlm, proveedorLlm } = await redactarResumenDiario(deps.resumenDiarioLlmGateway, agregados);

  try {
    await deps.resumenDiarioRepo.upsertDailyOpsSummary({ fecha, agregados, narrativa, generadoPor, costoLlmMicroUsd, modeloLlm, proveedorLlm });
  } catch (err) {
    // Defensa en profundidad: el sondeo de arriba pasó, pero el UPSERT falló
    // igual (p. ej. la migración se aplicó a la mitad entre el sondeo y
    // aquí, o el sondeo pasó por otra razón) -- mismo criterio honesto,
    // nunca un 500. Cualquier otro código de error se repropaga tal cual.
    if (!isUndefinedFunctionError(err)) throw err;
    return { ok: false, motivo: "migracion_pendiente" };
  }

  return { ok: true, agregados, narrativa, generadoPor };
}
