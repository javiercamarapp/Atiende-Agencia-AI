// Motor puro del RESUMEN DIARIO AUTOMÁTICO -- SIN I/O, 100% testeable. MISMO
// principio rector que `../salud/motor.ts` (reutilizado aquí, nunca
// duplicado): `null` (la lectura de esa sección falló) es SIEMPRE distinto de
// "cero"/"vacío" (sí se leyó, no hay nada) -- una sección entera es `null`
// cuando su lectura de fuente falló, NUNCA un objeto con campos en cero.
//
// Este módulo NO decide si algo es una alerta de salud operativa -- reutiliza
// `calcularAlertas`/`juzgarLatido` de `../salud/motor.ts` tal cual (nunca
// reimplementa ese criterio aquí). Tampoco redacta ningún texto -- eso vive
// en `./redaccion.ts`, que consume `DiarioAgregados` (la salida de este
// archivo) para producir la plantilla determinista y, opcionalmente, el
// prompt del LLM.
import { calcularAlertas, juzgarLatido, type Alerta, type CronConEstado, type CronHeartbeatRow, type LicitacionesFuenteRunRow, type LlmPlatformBudgetSalud, type OutboxQueueHealthRow } from "../salud/motor.ts";
import { cadenciaMinutosPorRuta, rutasDeCronDeclaradas } from "../salud/cadencia.ts";

/** America/Mexico_City NO observa horario de verano desde el decreto de 2022
 *  -- UTC-6 fijo, todo el año, sin excepción. Si esto cambiara algún día
 *  (poco probable, pero no imposible), esta constante es el ÚNICO lugar que
 *  tocar -- todo el resto del módulo la usa, nunca recalcula el offset. */
export const ZONA_HORARIA_MEXICO = "America/Mexico_City";
const OFFSET_HORAS_MEXICO = 6;

/** Prospectos sin ningún movimiento (`updated_at`) en más de este número de
 *  días entran a la alerta de "sin movimiento" -- 2 semanas, mismo orden de
 *  magnitud que un ciclo de seguimiento comercial razonable; ajustable aquí
 *  si el dueño pide otro umbral, nunca hardcodeado en la función SQL (ver
 *  `packages/db/migrations/0015_superadmin_resumen_diario.sql`). */
export const PROSPECTOS_SIN_MOVIMIENTO_DIAS = 14;

/** Cuántas organizaciones entran al "top gasto de LLM" del resumen. */
export const TOP_ORGANIZACIONES_GASTO_LLM = 5;

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface VentanaDia {
  readonly desde: string; // ISO 8601 UTC
  readonly hasta: string; // ISO 8601 UTC
}

/** `fecha` (YYYY-MM-DD) -> rango `[desde, hasta)` en UTC de ESE día calendario
 *  en America/Mexico_City. Pura -- nunca lee el reloj del sistema. El único
 *  lugar de todo este feature que hace aritmética de zona horaria (ver el
 *  comentario de cabecera de `0015_superadmin_resumen_diario.sql`: las
 *  funciones SQL reciben este rango ya resuelto, nunca lo calculan ellas
 *  mismas). */
export function ventanaDiaMexico(fecha: string): VentanaDia {
  if (!FECHA_RE.test(fecha)) throw new Error(`ventanaDiaMexico: fecha inválida "${fecha}", se esperaba YYYY-MM-DD`);
  const desde = new Date(`${fecha}T00:00:00.000Z`);
  desde.setUTCHours(desde.getUTCHours() + OFFSET_HORAS_MEXICO);
  if (Number.isNaN(desde.getTime())) throw new Error(`ventanaDiaMexico: fecha inválida "${fecha}"`);
  const hasta = new Date(desde.getTime());
  hasta.setUTCDate(hasta.getUTCDate() + 1);
  return { desde: desde.toISOString(), hasta: hasta.toISOString() };
}

/** El día calendario ANTERIOR (America/Mexico_City) al instante `ahora` --
 *  el cron corre temprano en la mañana (09:00 local, ver `vercel.json`) y
 *  resume el día YA completo, nunca un "hoy" todavía en curso a media
 *  mañana. */
export function fechaAyerMexico(ahora: Date): string {
  const local = new Date(ahora.getTime() - OFFSET_HORAS_MEXICO * 60 * 60 * 1000);
  local.setUTCDate(local.getUTCDate() - 1);
  return local.toISOString().slice(0, 10);
}

/** `ahora - N días`, en ISO -- usado para el umbral de "prospectos sin
 *  movimiento". Pura (recibe `ahora`, nunca lo lee ella misma). */
export function umbralSinMovimiento(ahora: Date, dias: number = PROSPECTOS_SIN_MOVIMIENTO_DIAS): string {
  return new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000).toISOString();
}

// ── Formas de entrada (raw, ya leídas por el agregador de I/O) ─────────────

export interface ColaDiaria {
  readonly queueName: string;
  readonly pendingCount: number;
  readonly processingCount: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly deadCount: number;
  readonly oldestPendingSeconds: number | null;
  readonly lastSentAt: string | null;
  readonly sentHoy: number | null;
  readonly fallidosHoy: number;
  readonly muertosHoy: number;
}

export interface TopOrganizacionGastoLlm {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly vertical: string;
  readonly costoMicroUsd: number;
  readonly llamadas: number;
}

export interface FuentesDiarias {
  readonly fecha: string;
  /** Igual criterio que `CalcularAlertasInput` de `../salud/motor.ts` --
   *  cada sección es `T | null`, nunca ceros disfrazados. */
  readonly crons: readonly CronHeartbeatRow[] | null;
  readonly colas: readonly ColaDiaria[] | null;
  readonly licitacionesFuentes: readonly LicitacionesFuenteRunRow[] | null;
  readonly llmPlatformBudget: LlmPlatformBudgetSalud | null;
  readonly gastoLlmHoy: { readonly costoMicroUsd: number; readonly tokensIn: number; readonly tokensOut: number; readonly llamadas: number } | null;
  readonly topOrganizacionesGastoLlm: readonly TopOrganizacionGastoLlm[] | null;
  readonly organizacionesStaffNuevos: { readonly organizacionesNuevas: number; readonly nombresOrganizacionesNuevas: readonly string[]; readonly staffNuevos: number } | null;
  readonly prospectos: { readonly altas: number; readonly cambiosEstado: number; readonly sinMovimiento: number } | null;
  readonly facturacion: {
    readonly altas: number;
    readonly bajas: number;
    readonly morososNuevos: number;
    readonly activasTotal: number;
    readonly pagoPendienteTotal: number;
    readonly canceladaTotal: number;
    readonly sinSuscripcionTotal: number;
  } | null;
  readonly breakGlassAbiertos: number | null;
}

// ── Forma de salida (lo que se persiste en `core.daily_ops_summary.agregados`
//    y lo que consume la pantalla/el correo) ────────────────────────────────

export interface SeccionSaludAgregada {
  readonly crons: { readonly total: number; readonly ok: number; readonly vencido: number; readonly sinLatido: number; readonly error: number } | null;
  readonly colas: { readonly total: number; readonly muertos: number; readonly pendientes: number } | null;
  readonly licitacionesFuentesConAlerta: number | null;
  /** Siempre presente -- `calcularAlertas` ya convierte cada sección `null`
   *  en su propia alerta "no se pudo leer" (nunca en silencio). */
  readonly alertas: readonly Alerta[];
}

export interface SeccionGastoLlmAgregada {
  readonly costoHoyMicroUsd: number | null;
  readonly tokensInHoy: number | null;
  readonly tokensOutHoy: number | null;
  readonly llamadasHoy: number | null;
  /** `null` cuando no se pudo leer el tope, o cuando el tope configurado es
   *  `<= 0` (no debería pasar -- `core.llm_platform_budget` exige `> 0` --
   *  pero nunca se divide entre cero). */
  readonly pctTopePlataforma: number | null;
  readonly topOrganizaciones: readonly TopOrganizacionGastoLlm[] | null;
}

export interface DiarioAgregados {
  readonly fecha: string;
  readonly zonaHoraria: typeof ZONA_HORARIA_MEXICO;
  readonly salud: SeccionSaludAgregada;
  readonly gastoLlm: SeccionGastoLlmAgregada;
  readonly facturacion: FuentesDiarias["facturacion"];
  readonly prospectos: (FuentesDiarias["prospectos"] & { readonly umbralSinMovimientoDias: number }) | null;
  readonly organizacionesStaff: FuentesDiarias["organizacionesStaffNuevos"];
  readonly mensajeria: readonly ColaDiaria[] | null;
  readonly breakGlassAbiertos: number | null;
  /** Comparación contra el resumen del día calendario anterior YA persistido
   *  (`core.daily_ops_summary`), cuando existe -- `null` cuando no hay
   *  resumen previo que comparar (primer día del feature, o un hueco de
   *  días sin cron). Cada delta individual también puede ser `null` cuando
   *  cualquiera de los dos lados (hoy/ayer) no se pudo leer -- nunca se
   *  calcula una diferencia contra un `0` inventado. */
  readonly deltas: DiarioDeltas | null;
}

export interface DiarioDeltas {
  readonly costoLlmMicroUsd: number | null;
  readonly organizacionesNuevas: number | null;
  readonly staffNuevos: number | null;
  readonly prospectosAltas: number | null;
  readonly facturacionAltas: number | null;
  readonly facturacionBajas: number | null;
  readonly alertasSalud: number | null;
}

function seccionSalud(fuentes: FuentesDiarias): SeccionSaludAgregada {
  const ahora = new Date();
  const cadencias = cadenciaMinutosPorRuta();
  const cronsConEstado: readonly CronConEstado[] | null =
    fuentes.crons === null
      ? null
      : (() => {
          const porNombre = new Map(fuentes.crons.map((h) => [h.cronName, h]));
          const nombres = new Set<string>([...rutasDeCronDeclaradas(), ...porNombre.keys()]);
          return [...nombres]
            .sort((a, b) => a.localeCompare(b))
            .map((cronName) => {
              const heartbeat = porNombre.get(cronName) ?? null;
              const cadenciaMin = cadencias[cronName] ?? 0;
              return { cronName, estado: juzgarLatido(heartbeat, cadenciaMin, ahora), heartbeat };
            });
        })();

  const colasSalud: readonly OutboxQueueHealthRow[] | null = fuentes.colas === null ? null : fuentes.colas.map((c) => ({ queueName: c.queueName, pendingCount: c.pendingCount, processingCount: c.processingCount, sentCount: c.sentCount, failedCount: c.failedCount, deadCount: c.deadCount, oldestPendingSeconds: c.oldestPendingSeconds, lastSentAt: c.lastSentAt }));

  const alertas = calcularAlertas({ crons: cronsConEstado, colas: colasSalud, licitacionesFuentes: fuentes.licitacionesFuentes, llmPlatformBudget: fuentes.llmPlatformBudget });

  return {
    crons: cronsConEstado === null ? null : { total: cronsConEstado.length, ok: cronsConEstado.filter((c) => c.estado === "ok").length, vencido: cronsConEstado.filter((c) => c.estado === "vencido").length, sinLatido: cronsConEstado.filter((c) => c.estado === "sin_latido").length, error: cronsConEstado.filter((c) => c.estado === "error").length },
    colas: colasSalud === null ? null : { total: colasSalud.length, muertos: colasSalud.reduce((s, c) => s + c.deadCount, 0), pendientes: colasSalud.reduce((s, c) => s + c.pendingCount, 0) },
    licitacionesFuentesConAlerta: fuentes.licitacionesFuentes === null ? null : fuentes.licitacionesFuentes.filter((f) => f.state !== "ok" && f.state !== "not_configured").length,
    alertas,
  };
}

function seccionGastoLlm(fuentes: FuentesDiarias): SeccionGastoLlmAgregada {
  const pct = fuentes.llmPlatformBudget === null || fuentes.llmPlatformBudget.monthlyCapMicroUsd <= 0 ? null : (fuentes.llmPlatformBudget.spendThisMonthMicroUsd / fuentes.llmPlatformBudget.monthlyCapMicroUsd) * 100;
  return {
    costoHoyMicroUsd: fuentes.gastoLlmHoy?.costoMicroUsd ?? null,
    tokensInHoy: fuentes.gastoLlmHoy?.tokensIn ?? null,
    tokensOutHoy: fuentes.gastoLlmHoy?.tokensOut ?? null,
    llamadasHoy: fuentes.gastoLlmHoy?.llamadas ?? null,
    pctTopePlataforma: pct,
    topOrganizaciones: fuentes.topOrganizacionesGastoLlm,
  };
}

function delta(hoy: number | null | undefined, ayer: number | null | undefined): number | null {
  if (hoy === null || hoy === undefined || ayer === null || ayer === undefined) return null;
  return hoy - ayer;
}

/** Combina las fuentes YA leídas (o `null` si la lectura falló) del día en
 *  curso, más -- opcionalmente -- el `DiarioAgregados` YA persistido del día
 *  calendario anterior (para las deltas), en el `DiarioAgregados` final. Pura
 *  -- ninguna llamada a `Date.now()`/reloj propio salvo dentro de
 *  `seccionSalud` (`juzgarLatido` ya exige `ahora` como parámetro en
 *  `../salud/motor.ts`, pero la clasificación de "vencido" de un cron SÍ es
 *  relativa al instante en que el agregador corrió, no algo que tenga
 *  sentido congelar en un fixture de fecha fija -- ver el comentario de ese
 *  módulo). */
export function combinarDiarioAgregados(fuentes: FuentesDiarias, agregadosAyer: DiarioAgregados | null): DiarioAgregados {
  const salud = seccionSalud(fuentes);
  const gastoLlm = seccionGastoLlm(fuentes);

  const deltas: DiarioDeltas | null =
    agregadosAyer === null
      ? null
      : {
          costoLlmMicroUsd: delta(gastoLlm.costoHoyMicroUsd, agregadosAyer.gastoLlm.costoHoyMicroUsd),
          organizacionesNuevas: delta(fuentes.organizacionesStaffNuevos?.organizacionesNuevas, agregadosAyer.organizacionesStaff?.organizacionesNuevas),
          staffNuevos: delta(fuentes.organizacionesStaffNuevos?.staffNuevos, agregadosAyer.organizacionesStaff?.staffNuevos),
          prospectosAltas: delta(fuentes.prospectos?.altas, agregadosAyer.prospectos?.altas),
          facturacionAltas: delta(fuentes.facturacion?.altas, agregadosAyer.facturacion?.altas),
          facturacionBajas: delta(fuentes.facturacion?.bajas, agregadosAyer.facturacion?.bajas),
          alertasSalud: delta(salud.alertas.length, agregadosAyer.salud.alertas.length),
        };

  return {
    fecha: fuentes.fecha,
    zonaHoraria: ZONA_HORARIA_MEXICO,
    salud,
    gastoLlm,
    facturacion: fuentes.facturacion,
    prospectos: fuentes.prospectos === null ? null : { ...fuentes.prospectos, umbralSinMovimientoDias: PROSPECTOS_SIN_MOVIMIENTO_DIAS },
    organizacionesStaff: fuentes.organizacionesStaffNuevos,
    mensajeria: fuentes.colas,
    breakGlassAbiertos: fuentes.breakGlassAbiertos,
    deltas,
  };
}
