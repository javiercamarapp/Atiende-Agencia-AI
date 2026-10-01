// Catalogo CERRADO de "Chatea con tus datos" para LICITACIONES publicas en Mexico (ComprasMX, LAASSP:
// Ley de Adquisiciones, Arrendamientos y Servicios del Sector Publico). Siete herramientas de solo lectura
// con parametros tipados (periodo, horizonte en dias, limite) y alcance fijado por el servidor: la
// ORGANIZACION completa del usuario (licitaciones no tiene sucursales). Para agregar otra vertical: ver
// docs/DATA-CHAT.md.
//
// Lo que NO se ofrece porque el modelo no lo tiene o seria inventarlo:
//  - Montos de propuestas por estado y montos en moneda distinta de MXN (no se convierte ni se inventa
//    tipo de cambio).
//  - Respuestas, actas y referencias de envio de la junta de aclaraciones: solo el texto de las preguntas
//    pendientes y las fechas de la junta.
import {
  DEFAULT_DATA_CHAT_TIMEZONE,
  PERIOD_PARAMS,
  formatMxn,
  resolvePeriod,
  roundMoney,
  type DataChatCatalog,
  type DataChatTool,
  type DataChatToolContext,
  type DataChatToolResult,
  type ParamsSpec,
  type ParsedArgs,
} from "@atiende/agent-core/data-chat";
import { DataChatUnavailableError, type LicitacionesDataChatReader, type LicitacionesDataChatWindow } from "./reader.ts";

const UNAVAILABLE_MESSAGE = "Esa información todavía no está disponible para tu cuenta (falta activar una actualización). Tus tableros siguen funcionando.";

/** Umbrales del semaforo de plazos (dias naturales locales al cierre de la convocatoria). Deben coincidir con SQL_PLAZOS_SEMAFORO (lo fija un test). */
export const SEMAFORO_ROJO_DIAS = 3;
export const SEMAFORO_AMARILLO_DIAS = 7;

export function semaforoPorDias(dias: number | null): string {
  if (dias === null) return "Sin fecha límite";
  if (dias < 0) return "Vencida";
  if (dias <= SEMAFORO_ROJO_DIAS) return "Rojo";
  if (dias <= SEMAFORO_AMARILLO_DIAS) return "Amarillo";
  return "Verde";
}

const STATUS_CONVOCATORIA: Readonly<Record<string, string>> = {
  discovered: "Detectada",
  in_review: "En revisión",
  go: "Go (se decidió participar)",
  no_go: "No-go",
  in_progress: "Propuesta en elaboración",
  submitted: "Presentada",
  won: "Ganada",
  lost: "Perdida",
  cancelled: "Cancelada",
};
const STATUS_CONTRATO: Readonly<Record<string, string>> = {
  adjudicado: "Adjudicado",
  contrato_firmado_declarado: "Contrato firmado",
  en_ejecucion: "En ejecución",
  entregado: "Entregado",
  facturado: "Facturado",
  pagado: "Pagado",
  cerrado: "Cerrado",
  modificado: "Modificado",
  penalizado: "Penalizado",
  rescindido: "Rescindido",
  en_inconformidad: "En inconformidad",
};
const STATUS_PREGUNTA: Readonly<Record<string, string>> = { borrador: "Borrador", aprobada: "Aprobada (sin enviar)", enviada: "Enviada (sin respuesta)" };
const TEMA_PREGUNTA: Readonly<Record<string, string>> = { administrativo: "Administrativo", legal: "Legal", tecnico: "Técnico", economico: "Económico", otro: "Otro" };
const PRIORIDAD_PREGUNTA: Readonly<Record<string, string>> = { alta: "Alta", media: "Media", baja: "Baja" };
const ELEGIBILIDAD: Readonly<Record<string, string>> = { cumple: "Cumple", no_cumple: "No cumple", no_evaluable: "No evaluable" };

const SCOPE_LABEL = "toda tu organización";

/** Una zona IANA invalida llegaria a `at time zone $2` y daria un error de Postgres (22023): se valida antes. */
function validTimezone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

function failure(status: DataChatToolResult["status"], message: string, source: string): DataChatToolResult {
  return { status, message, source, scopeLabel: "", columns: [], rows: [] };
}

async function windowFor(reader: LicitacionesDataChatReader, ctx: DataChatToolContext, args: ParsedArgs | null, source: string): Promise<{ w: LicitacionesDataChatWindow; periodLabel?: string } | DataChatToolResult> {
  // La zona sale de la configuracion de la organizacion (o la del alcance si no hay); nunca del modelo.
  const configured = await reader.organizationTimezone(ctx.scope.organizationId);
  const timezone = validTimezone(configured) ?? validTimezone(ctx.scope.timezone) ?? DEFAULT_DATA_CHAT_TIMEZONE;
  let desde = ctx.now;
  let hasta = ctx.now;
  let periodLabel: string | undefined;
  if (args) {
    const p = resolvePeriod(args, ctx.now, timezone);
    if (!p.ok) return failure(p.kind === "needs_clarification" ? "needs_clarification" : "error", p.message, source);
    desde = p.period.start;
    hasta = p.period.end;
    periodLabel = p.period.label;
  }
  return { w: { organizationId: ctx.scope.organizationId, timezone, ahora: ctx.now, desde, hasta, limit: ctx.maxRows + 1 }, periodLabel };
}

function isResult(v: { w: LicitacionesDataChatWindow } | DataChatToolResult): v is DataChatToolResult {
  return (v as DataChatToolResult).status !== undefined;
}

function tool(
  reader: LicitacionesDataChatReader,
  def: { name: string; label: string; description: string; source: string; params: ParamsSpec; withPeriod: boolean },
  run: (w: LicitacionesDataChatWindow, args: ParsedArgs, periodLabel: string | undefined, ctx: DataChatToolContext) => Promise<Omit<DataChatToolResult, "source" | "scopeLabel" | "periodLabel"> & { source?: string; periodLabel?: string }>,
): DataChatTool {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    params: def.params,
    async run(ctx, args) {
      try {
        const prepared = await windowFor(reader, ctx, def.withPeriod ? args : null, def.source);
        if (isResult(prepared)) return prepared;
        const out = await run(prepared.w, args, prepared.periodLabel, ctx);
        return { ...out, source: out.source ?? def.source, scopeLabel: SCOPE_LABEL, periodLabel: out.periodLabel ?? prepared.periodLabel };
      } catch (err) {
        if (err instanceof DataChatUnavailableError) return failure("unavailable", UNAVAILABLE_MESSAGE, def.source);
        throw err;
      }
    },
  };
}

const SRC_TENDERS = "Convocatorias de la organización (captura manual o ingesta de fuentes como ComprasMX); abiertas = detectada, en revisión, go o en elaboración, con fecha límite vigente o sin fecha";

export function buildLicitacionesDataChatTools(reader: LicitacionesDataChatReader): readonly DataChatTool[] {
  const abiertas = tool(
    reader,
    {
      name: "convocatorias_abiertas",
      label: "Convocatorias abiertas",
      description:
        "Convocatorias de licitación (ComprasMX / LAASSP) que todavía se pueden presentar, ordenadas por fecha límite: dependencia, estatus, fecha límite, días restantes y monto estimado en MXN (solo si la convocatoria está en pesos). Con 'vencen_en_dias' muestra solo las que vencen dentro de ese número de días (por vencer).",
      source: SRC_TENDERS,
      withPeriod: false,
      params: {
        vencen_en_dias: { type: "integer", min: 1, max: 90, optional: true, description: "Solo convocatorias cuya fecha límite cae dentro de los próximos N días (1-90). Omítelo para ver todas las abiertas." },
        limite: { type: "integer", min: 1, max: 50, optional: true, description: "Cuántas convocatorias mostrar (1-50). Por defecto 20." },
      },
    },
    async (w, args) => {
      const dentro = (args["vencen_en_dias"] as number | undefined) ?? null;
      const limit = (args["limite"] as number | undefined) ?? 20;
      const rows = (await reader.convocatoriasAbiertas({ ...w, limit: limit + 1 }, dentro)).slice(0, limit + 1);
      const shown = rows.slice(0, limit);
      const conMonto = shown.filter((r) => r.montoMxn !== null);
      const total = roundMoney(conMonto.reduce((n, r) => n + (r.montoMxn ?? 0), 0));
      const alcance = dentro === null ? "abiertas" : `que vencen en los próximos ${dentro} días`;
      return {
        status: shown.length === 0 ? "empty" : "ok",
        source: dentro === null ? SRC_TENDERS : `${SRC_TENDERS}; solo las que vencen en los próximos ${dentro} días`,
        columns: [
          { key: "convocatoria", label: "Convocatoria", kind: "text" },
          { key: "dependencia", label: "Dependencia", kind: "text" },
          { key: "estatus", label: "Estatus", kind: "text" },
          { key: "fecha_limite", label: "Fecha límite", kind: "text" },
          { key: "dias", label: "Días restantes", kind: "integer" },
          { key: "semaforo", label: "Semáforo", kind: "text" },
          { key: "monto", label: "Monto estimado", kind: "mxn" },
        ],
        rows: shown.map((r) => ({
          convocatoria: r.titulo,
          dependencia: r.dependencia ?? "—",
          estatus: STATUS_CONVOCATORIA[r.status] ?? r.status,
          fecha_limite: r.fechaLimite ?? "Sin fecha registrada",
          dias: r.diasRestantes,
          semaforo: semaforoPorDias(r.diasRestantes),
          monto: r.montoMxn === null ? null : roundMoney(r.montoMxn),
        })),
        summary:
          shown.length > 0
            ? `${rows.length > limit ? `Se muestran ${limit} de más de ${limit}` : `${shown.length}`} convocatorias ${alcance}${conMonto.length > 0 ? `; suman ${formatMxn(total)} en las ${conMonto.length} con monto estimado en MXN` : ""}.`
            : `No hay convocatorias ${alcance}.`,
      };
    },
  );

  const SRC_SEMAFORO = `${SRC_TENDERS}. Semáforo por días naturales hasta la fecha límite: rojo ${SEMAFORO_ROJO_DIAS} o menos, amarillo ${SEMAFORO_ROJO_DIAS + 1} a ${SEMAFORO_AMARILLO_DIAS}, verde más de ${SEMAFORO_AMARILLO_DIAS}`;
  const semaforo = tool(
    reader,
    {
      name: "plazos_semaforo",
      label: "Plazos y semáforo",
      description: `Cuántas convocatorias abiertas hay por semáforo de plazo: vencida sin presentar, rojo (${SEMAFORO_ROJO_DIAS} días o menos), amarillo (hasta ${SEMAFORO_AMARILLO_DIAS}), verde y sin fecha límite registrada.`,
      source: SRC_SEMAFORO,
      withPeriod: false,
      params: {},
    },
    async (w) => {
      const rows = await reader.plazosSemaforo(w);
      const total = rows.reduce((n, r) => n + r.convocatorias, 0);
      const urgentes = rows.filter((r) => r.semaforo.startsWith("Rojo") || r.semaforo.startsWith("Vencida")).reduce((n, r) => n + r.convocatorias, 0);
      return {
        status: rows.length === 0 ? "empty" : "ok",
        columns: [
          { key: "semaforo", label: "Semáforo", kind: "text" },
          { key: "convocatorias", label: "Convocatorias", kind: "integer" },
        ],
        rows: rows.map((r) => ({ semaforo: r.semaforo, convocatorias: r.convocatorias })),
        chart: { kind: "bar", x: "semaforo", y: "convocatorias" },
        summary: rows.length > 0 ? `${total} convocatorias abiertas, ${urgentes} en rojo o ya vencidas sin presentar.` : "No hay convocatorias abiertas.",
      };
    },
  );

  const SRC_GONOGO = "Decisiones go/no-go registradas por la organización (con el puntaje de compatibilidad sellado al decidir)";
  const goNoGo = tool(
    reader,
    {
      name: "go_no_go",
      label: "Decisiones go / no-go",
      description: "Decisiones de participar (go) o no participar (no-go) en convocatorias tomadas en un periodo, con puntaje de compatibilidad, elegibilidad y el primer motivo registrado.",
      source: SRC_GONOGO,
      withPeriod: true,
      params: PERIOD_PARAMS,
    },
    async (w, _args, periodLabel) => {
      const shown = await reader.goNoGo(w);
      const truncated = shown.length > w.limit - 1;
      const go = shown.filter((r) => r.decision === "go").length;
      return {
        status: shown.length === 0 ? "empty" : "ok",
        columns: [
          { key: "convocatoria", label: "Convocatoria", kind: "text" },
          { key: "decision", label: "Decisión", kind: "text" },
          { key: "elegibilidad", label: "Elegibilidad", kind: "text" },
          { key: "puntaje", label: "Puntaje", kind: "decimal" },
          { key: "fecha", label: "Fecha", kind: "text" },
          { key: "motivo", label: "Motivo", kind: "text" },
        ],
        rows: shown.map((r) => ({ convocatoria: r.titulo, decision: r.decision === "go" ? "Go" : "No-go", elegibilidad: ELEGIBILIDAD[r.elegibilidad] ?? r.elegibilidad, puntaje: r.puntaje, fecha: r.fecha, motivo: r.motivo ?? "—" })),
        summary: shown.length === 0 ? undefined : truncated ? `Hay más de ${w.limit - 1} decisiones en ${periodLabel}; se muestran las más recientes. Acota el periodo para verlas todas.` : `Decisiones en ${periodLabel}: ${shown.length}, ${go} go y ${shown.length - go} no-go.`,
      };
    },
  );

  const SRC_PROPUESTAS = "Propuestas de la organización agrupadas por el estatus de su convocatoria; presentada = ya tiene declaración de presentación";
  const propuestas = tool(
    reader,
    {
      name: "propuestas_por_estado",
      label: "Propuestas por estado",
      description: "Cuántas propuestas tiene la organización por estatus de su convocatoria (en elaboración, presentada, ganada, perdida...) y cuántas ya fueron presentadas. No incluye montos.",
      source: SRC_PROPUESTAS,
      withPeriod: false,
      params: {},
    },
    async (w) => {
      const rows = await reader.propuestasPorEstado(w);
      const total = rows.reduce((n, r) => n + r.propuestas, 0);
      const presentadas = rows.reduce((n, r) => n + r.presentadas, 0);
      return {
        status: rows.length === 0 ? "empty" : "ok",
        columns: [
          { key: "estado", label: "Estatus de la convocatoria", kind: "text" },
          { key: "propuestas", label: "Propuestas", kind: "integer" },
          { key: "presentadas", label: "Presentadas", kind: "integer" },
        ],
        rows: rows.map((r) => ({ estado: STATUS_CONVOCATORIA[r.status] ?? r.status, propuestas: r.propuestas, presentadas: r.presentadas })),
        chart: { kind: "bar", x: "estado", y: "propuestas" },
        summary: rows.length > 0 ? `${total} propuestas, ${presentadas} con declaración de presentación.` : "Todavía no hay propuestas registradas.",
      };
    },
  );

  const SRC_FALLOS = "Fallos registrados por la organización (ganada o perdida) al resolver una convocatoria; monto = presupuesto estimado de la convocatoria, solo si está en MXN";
  const fallos = tool(
    reader,
    {
      name: "fallos",
      label: "Fallos",
      description: "Fallos de licitación registrados en un periodo (ganada o perdida), con dependencia y el monto estimado de la convocatoria en MXN cuando existe. El monto es el presupuesto de la convocatoria, no el importe adjudicado.",
      source: SRC_FALLOS,
      withPeriod: true,
      params: PERIOD_PARAMS,
    },
    async (w, _args, periodLabel) => {
      const shown = await reader.fallos(w);
      const truncated = shown.length > w.limit - 1;
      const ganadas = shown.filter((r) => r.resultado === "won").length;
      return {
        status: shown.length === 0 ? "empty" : "ok",
        columns: [
          { key: "convocatoria", label: "Convocatoria", kind: "text" },
          { key: "dependencia", label: "Dependencia", kind: "text" },
          { key: "resultado", label: "Resultado", kind: "text" },
          { key: "fecha", label: "Fecha del fallo", kind: "text" },
          { key: "monto", label: "Monto estimado", kind: "mxn" },
        ],
        rows: shown.map((r) => ({ convocatoria: r.titulo, dependencia: r.dependencia ?? "—", resultado: r.resultado === "won" ? "Ganada" : "Perdida", fecha: r.fecha, monto: r.montoMxn === null ? null : roundMoney(r.montoMxn) })),
        summary: shown.length === 0 ? undefined : truncated ? `Hay más de ${w.limit - 1} fallos en ${periodLabel}; se muestran los más recientes. Acota el periodo para verlos todos.` : `Fallos en ${periodLabel}: ${shown.length}, ${ganadas} ganadas y ${shown.length - ganadas} perdidas.`,
      };
    },
  );

  const SRC_RENOV = "Contratos de la organización con fecha de fin de vigencia declarada, no cerrados ni rescindidos; alerta = radar de renovaciones pendiente";
  const renovaciones = tool(
    reader,
    {
      name: "renovaciones",
      label: "Renovaciones de contratos",
      description: "Contratos cuya vigencia termina en los próximos N días (por defecto 90), con días restantes, si tienen opción de renovación y si el radar de renovaciones tiene una alerta pendiente. Solo contratos con fecha de fin declarada.",
      source: SRC_RENOV,
      withPeriod: false,
      params: { dentro_de_dias: { type: "integer", min: 1, max: 365, optional: true, description: "Horizonte en días (1-365). Por defecto 90." } },
    },
    async (w, args) => {
      const horizonte = (args["dentro_de_dias"] as number | undefined) ?? 90;
      const shown = await reader.renovaciones(w, horizonte);
      const truncated = shown.length > w.limit - 1;
      const conOpcion = shown.filter((r) => r.opcionRenovacion).length;
      return {
        status: shown.length === 0 ? "empty" : "ok",
        source: `${SRC_RENOV}; vigencia que termina en los próximos ${horizonte} días`,
        columns: [
          { key: "contrato", label: "Contrato", kind: "text" },
          { key: "convocatoria", label: "Convocatoria", kind: "text" },
          { key: "dependencia", label: "Dependencia", kind: "text" },
          { key: "fin", label: "Fin de vigencia", kind: "text" },
          { key: "dias", label: "Días restantes", kind: "integer" },
          { key: "estatus", label: "Estatus", kind: "text" },
          { key: "opcion", label: "Opción de renovación", kind: "text" },
          { key: "alerta", label: "Alerta del radar", kind: "text" },
        ],
        rows: shown.map((r) => ({
          contrato: r.contrato ?? "Sin número",
          convocatoria: r.titulo,
          dependencia: r.dependencia ?? "—",
          fin: r.finVigencia,
          dias: r.diasRestantes,
          estatus: STATUS_CONTRATO[r.status] ?? r.status,
          opcion: r.opcionRenovacion ? "Sí" : "No",
          alerta: r.alertaPendiente ? "Pendiente" : "—",
        })),
        summary: shown.length > 0 ? (truncated ? `Hay más de ${w.limit - 1} contratos que terminan su vigencia en los próximos ${horizonte} días; se muestran los más próximos.` : `${shown.length} contratos terminan su vigencia en los próximos ${horizonte} días; ${conOpcion} con opción de renovación.`) : `Ningún contrato con fecha de fin declarada termina en los próximos ${horizonte} días.`,
      };
    },
  );

  const SRC_JUNTA = "Preguntas de la junta de aclaraciones sin cerrar (borrador, aprobada o enviada, aún sin respuesta) y las fechas de la junta de su convocatoria";
  const junta = tool(
    reader,
    {
      name: "preguntas_junta_pendientes",
      label: "Preguntas de junta de aclaraciones pendientes",
      description:
        "Preguntas para la junta de aclaraciones de una convocatoria que siguen pendientes (borrador, aprobada sin enviar o enviada sin respuesta), con tema, prioridad, fecha límite para enviar preguntas, días restantes y fecha de la junta. No incluye respuestas ni actas.",
      source: SRC_JUNTA,
      withPeriod: false,
      params: {},
    },
    async (w) => {
      const shown = await reader.preguntasJunta(w);
      const truncated = shown.length > w.limit - 1;
      const porEstado = (s: string) => shown.filter((r) => r.status === s).length;
      return {
        status: shown.length === 0 ? "empty" : "ok",
        columns: [
          { key: "convocatoria", label: "Convocatoria", kind: "text" },
          { key: "pregunta", label: "Pregunta", kind: "text" },
          { key: "tema", label: "Tema", kind: "text" },
          { key: "prioridad", label: "Prioridad", kind: "text" },
          { key: "estatus", label: "Estatus", kind: "text" },
          { key: "limite", label: "Límite para preguntas", kind: "text" },
          { key: "dias", label: "Días al límite", kind: "integer" },
          { key: "junta", label: "Junta", kind: "text" },
        ],
        rows: shown.map((r) => ({
          convocatoria: r.titulo,
          pregunta: r.pregunta,
          tema: TEMA_PREGUNTA[r.tema] ?? r.tema,
          prioridad: PRIORIDAD_PREGUNTA[r.prioridad] ?? r.prioridad,
          estatus: STATUS_PREGUNTA[r.status] ?? r.status,
          limite: r.limitePreguntas ?? "Sin fecha registrada",
          dias: r.diasLimite,
          junta: r.junta ?? "Sin fecha registrada",
        })),
        summary:
          shown.length === 0
            ? "No hay preguntas de junta de aclaraciones pendientes."
            : truncated
              ? `Hay más de ${w.limit - 1} preguntas de junta pendientes; se muestran las más urgentes.`
              : `${shown.length} preguntas de junta pendientes: ${porEstado("borrador")} en borrador, ${porEstado("aprobada")} aprobadas sin enviar y ${porEstado("enviada")} enviadas sin respuesta.`,
      };
    },
  );

  return [abiertas, semaforo, goNoGo, propuestas, fallos, renovaciones, junta];
}

export function buildLicitacionesDataChatCatalog(reader: LicitacionesDataChatReader): DataChatCatalog {
  return {
    vertical: "licitaciones",
    domain:
      "una empresa que participa en licitaciones públicas en México (convocatorias de ComprasMX conforme a la LAASSP: plazos, decisiones go/no-go, propuestas, fallos, preguntas de la junta de aclaraciones y renovaciones de contratos)",
    tools: buildLicitacionesDataChatTools(reader),
  };
}
