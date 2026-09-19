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
  readonly agregados: DiarioAgregados;
  readonly narrativa: string;
  readonly generadoPor: "llm" | "determinista";
}

/** Genera Y PERSISTE el resumen de `fecha` -- idempotente (el UPSERT de
 *  `core.upsert_daily_ops_summary` actualiza en vez de duplicar). Punto de
 *  entrada único para el cron y para `POST /superadmin/resumen/generar`. */
export async function generarYPersistirResumenDiario(deps: AppDeps, fecha: string, ahora: Date = new Date()): Promise<ResultadoGeneracion> {
  const [fuentes, agregadosAyer] = await Promise.all([leerFuentesDiarias(deps, fecha, ahora), leerAgregadosAyer(deps, fecha)]);
  const agregados = combinarDiarioAgregados(fuentes, agregadosAyer);
  const { narrativa, generadoPor, costoLlmMicroUsd, modeloLlm, proveedorLlm } = await redactarResumenDiario(deps.resumenDiarioLlmGateway, agregados);

  await deps.resumenDiarioRepo.upsertDailyOpsSummary({ fecha, agregados, narrativa, generadoPor, costoLlmMicroUsd, modeloLlm, proveedorLlm });

  return { agregados, narrativa, generadoPor };
}
