// Catalogo CERRADO de "Chatea con tus datos" para HOTELES. Seis herramientas de solo lectura, todas con
// parametros tipados (periodo, hotel por nombre) y alcance fijado por el servidor. Periodos en la zona del
// hotel (America/Merida por defecto, o `hoteles.property_config.timezone`), montos en MXN. Para agregar otra
// herramienta o vertical: ver docs/DATA-CHAT.md.
//
// Lo que NO esta aqui a proposito: "reservas por canal". `hoteles.reservation` no guarda el canal de origen
// (ver migraciones 001/005), asi que no se puede responder sin inventar; el motor responde "fuera de catalogo".
import {
  FORWARD_PERIOD_PARAMS,
  PERIOD_PARAMS,
  formatMxn,
  propertyParam,
  resolveForwardPeriod,
  resolvePeriod,
  resolvePropertySelection,
  roundMoney,
  type DataChatCatalog,
  type DataChatColumn,
  type DataChatTool,
  type DataChatToolContext,
  type DataChatToolResult,
  type ParamsSpec,
  type ParsedArgs,
  type ResolvePeriodResult,
  type ResolvedPeriod,
} from "@atiende/agent-core/data-chat";
import { DataChatUnavailableError, type Granularity, type HotelesDataChatReader, type HotelesDataChatWindow } from "./reader.ts";

const NOUNS = { singular: "hotel", plural: "hoteles" } as const;
const HOTEL_PARAM: ParamsSpec = propertyParam("hotel", NOUNS);
const BACKWARD_PARAMS: ParamsSpec = { ...PERIOD_PARAMS, ...HOTEL_PARAM };
const FORWARD_PARAMS: ParamsSpec = { ...FORWARD_PERIOD_PARAMS, ...HOTEL_PARAM };

const UNAVAILABLE_MESSAGE = "Esa información todavía no está disponible para tu cuenta (falta activar una actualización). Tus tableros siguen funcionando.";
const NIGHT_AUDIT_NOTE = "las noches se cargan con la auditoría nocturna, así que el día en curso puede aparecer incompleto";

const DEPARTMENT_LABELS: Readonly<Record<string, string>> = {
  owner: "Dirección",
  gm: "Gerencia",
  frontdesk: "Recepción",
  reservations: "Reservaciones",
  housekeeping: "Housekeeping",
  maintenance: "Mantenimiento",
  fnb: "Alimentos y bebidas",
  accountant: "Contabilidad",
};
const PRIORITY_LABELS: Readonly<Record<string, string>> = { alta: "Alta", media: "Media", baja: "Baja" };
const TASK_LABELS: Readonly<Record<string, string>> = { salida: "Limpieza de salida", estancia: "Limpieza de estancia", profunda: "Limpieza profunda", repaso: "Repaso" };

function failure(status: DataChatToolResult["status"], message: string, source: string): DataChatToolResult {
  return { status, message, source, scopeLabel: "", columns: [], rows: [] };
}

function granularity(period: ResolvedPeriod): Granularity {
  const days = Math.round((period.end.getTime() - period.start.getTime()) / 86_400_000);
  return days <= 50 ? "day" : days <= 300 ? "week" : "month";
}

const BUCKET_COLS = {
  day: { key: "periodo", label: "Día", kind: "text" },
  week: { key: "periodo", label: "Semana (inicia lunes)", kind: "text" },
  month: { key: "periodo", label: "Mes (inicio)", kind: "text" },
} as const satisfies Record<Granularity, DataChatColumn>;

const pct = (part: number, total: number): number | null => (total > 0 ? Math.round((part / total) * 1000) / 10 : null);
const ratio = (part: number, total: number): number | null => (total > 0 ? roundMoney(part / total) : null);

interface Prepared {
  readonly window: HotelesDataChatWindow;
  readonly period: ResolvedPeriod;
  readonly scopeLabel: string;
}

type ScopeResolution =
  | { readonly ok: true; readonly propertyIds: readonly string[] | null; readonly label: string }
  | { readonly ok: false; readonly result: DataChatToolResult };

async function resolveScope(reader: HotelesDataChatReader, ctx: DataChatToolContext, args: ParsedArgs, source: string): Promise<ScopeResolution> {
  const visible = await reader.listVisibleHotels(ctx.scope.organizationId, ctx.scope.allowedPropertyIds);
  const b = resolvePropertySelection(visible, ctx.scope.allowedPropertyIds, args["hotel"] as string | undefined, NOUNS);
  if (!b.ok) return { ok: false, result: failure("needs_clarification", b.message, source) };
  return { ok: true, propertyIds: b.propertyIds, label: b.label };
}

async function prepare(
  reader: HotelesDataChatReader,
  ctx: DataChatToolContext,
  args: ParsedArgs,
  source: string,
  resolver: (a: ParsedArgs, now: Date, tz: string) => ResolvePeriodResult,
): Promise<Prepared | DataChatToolResult> {
  const p = resolver(args, ctx.now, ctx.scope.timezone);
  if (!p.ok) return failure(p.kind === "needs_clarification" ? "needs_clarification" : "error", p.message, source);
  const scope = await resolveScope(reader, ctx, args, source);
  if (!scope.ok) return scope.result;
  return {
    period: p.period,
    scopeLabel: scope.label,
    window: {
      organizationId: ctx.scope.organizationId,
      propertyIds: scope.propertyIds,
      start: p.period.start,
      end: p.period.end,
      fromDate: p.period.fromDate,
      toDate: p.period.toDate,
      timezone: p.period.timezone,
      limit: ctx.maxRows + 1,
    },
  };
}

function isResult(v: Prepared | DataChatToolResult): v is DataChatToolResult {
  return (v as DataChatToolResult).status !== undefined;
}

/** Envoltorio comun: prepara ventana/alcance, ejecuta, y traduce "base sin migrar" a un aviso honesto. */
function windowTool(
  reader: HotelesDataChatReader,
  def: { name: string; label: string; description: string; source: string; forward?: boolean },
  run: (p: Prepared, args: ParsedArgs, ctx: DataChatToolContext) => Promise<DataChatToolResult>,
): DataChatTool {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    params: def.forward ? FORWARD_PARAMS : BACKWARD_PARAMS,
    async run(ctx, args) {
      try {
        const prepared = await prepare(reader, ctx, args, def.source, def.forward ? resolveForwardPeriod : resolvePeriod);
        if (isResult(prepared)) return prepared;
        return await run(prepared, args, ctx);
      } catch (err) {
        if (err instanceof DataChatUnavailableError) return failure("unavailable", UNAVAILABLE_MESSAGE, def.source);
        throw err;
      }
    },
  };
}

function base(p: Prepared, source: string): Pick<DataChatToolResult, "source" | "periodLabel" | "scopeLabel"> {
  return { source, periodLabel: p.period.label, scopeLabel: p.scopeLabel };
}

export function buildHotelesDataChatTools(reader: HotelesDataChatReader): readonly DataChatTool[] {
  const SOURCE_OCC = `Noches ocupadas = cargos de hospedaje vigentes del folio; noches disponibles = inventario de habitaciones cargado por día; ${NIGHT_AUDIT_NOTE}`;
  const ocupacion = windowTool(
    reader,
    {
      name: "ocupacion_adr_revpar",
      label: "Ocupación, ADR y RevPAR",
      description:
        "Ocupación (%), ADR (ingreso de hospedaje por noche ocupada, MXN) y RevPAR (ingreso de hospedaje por noche disponible, MXN) por día en un periodo; agrupa por semana o mes si el periodo es largo. Úsala para 'cómo va la ocupación', ADR o RevPAR.",
      source: SOURCE_OCC,
    },
    async (p) => {
      const unit = granularity(p.period);
      const rows = await reader.occupancy(p.window, unit);
      const available = rows.reduce((n, r) => n + r.availableNights, 0);
      const occupied = rows.reduce((n, r) => n + r.occupiedNights, 0);
      const revenue = roundMoney(rows.reduce((n, r) => n + r.roomRevenue, 0));
      if (rows.length === 0) return { status: "empty", ...base(p, SOURCE_OCC), columns: [], rows: [] };
      const out = {
        ...base(p, SOURCE_OCC),
        columns: [
          BUCKET_COLS[unit],
          { key: "noches_disponibles", label: "Noches disponibles", kind: "integer" },
          { key: "noches_ocupadas", label: "Noches ocupadas", kind: "integer" },
          { key: "ocupacion", label: "Ocupación", kind: "percent" },
          { key: "adr", label: "ADR", kind: "mxn" },
          { key: "revpar", label: "RevPAR", kind: "mxn" },
        ] satisfies DataChatColumn[],
        rows: rows.map((r) => ({
          periodo: r.bucket,
          noches_disponibles: r.availableNights,
          noches_ocupadas: r.occupiedNights,
          ocupacion: pct(r.occupiedNights, r.availableNights),
          adr: ratio(r.roomRevenue, r.occupiedNights),
          revpar: ratio(r.roomRevenue, r.availableNights),
        })),
        chart: { kind: unit === "day" ? ("line" as const) : ("bar" as const), x: "periodo", y: "ocupacion" },
      };
      if (available === 0) {
        return {
          status: "ok",
          ...out,
          summary: `No hay inventario de habitaciones cargado para ${p.period.label}: no puedo calcular ocupación ni RevPAR (${p.scopeLabel}). Noches ocupadas registradas: ${occupied}.`,
        };
      }
      return {
        status: "ok",
        ...out,
        summary: `Ocupación de ${p.period.label}: ${pct(occupied, available)}% (${occupied} de ${available} noches); ADR ${occupied > 0 ? formatMxn(revenue / occupied) : "sin noches ocupadas"}; RevPAR ${formatMxn(revenue / available)} (${p.scopeLabel}).`,
      };
    },
  );

  const SOURCE_REV = "Cargos de folios de hoteles (importes netos antes de IVA/ISH, sin propinas; descuentos y reversos ya aplicados), por día de la estancia";
  const ingresos = windowTool(
    reader,
    {
      name: "ingresos_por_periodo",
      label: "Ingresos por periodo",
      description: "Ingresos (MXN) por día, semana o mes, separados en habitaciones, alimentos y bebidas, y otros (extras). Úsala para 'cuánto facturó el hotel'.",
      source: SOURCE_REV,
    },
    async (p) => {
      const unit = granularity(p.period);
      const rows = await reader.revenue(p.window, unit);
      const total = roundMoney(rows.reduce((n, r) => n + r.rooms + r.foodBeverage + r.other, 0));
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SOURCE_REV),
        columns: [
          BUCKET_COLS[unit],
          { key: "habitaciones", label: "Habitaciones", kind: "mxn" },
          { key: "ab", label: "Alimentos y bebidas", kind: "mxn" },
          { key: "otros", label: "Otros", kind: "mxn" },
          { key: "total", label: "Total", kind: "mxn" },
        ],
        rows: rows.map((r) => ({
          periodo: r.bucket,
          habitaciones: roundMoney(r.rooms),
          ab: roundMoney(r.foodBeverage),
          otros: roundMoney(r.other),
          total: roundMoney(r.rooms + r.foodBeverage + r.other),
        })),
        chart: { kind: unit === "day" ? "line" : "bar", x: "periodo", y: "total" },
        summary: `Ingresos de ${p.period.label}: ${formatMxn(total)} (${p.scopeLabel}).`,
      };
    },
  );

  const SOURCE_RES = "Reservas vigentes (sin cotizadas, canceladas ni no-show), por fecha de entrada y de salida";
  const llegadas = windowTool(
    reader,
    {
      name: "llegadas_y_salidas",
      label: "Llegadas y salidas",
      description: "Llegadas (check-in) y salidas (check-out) de reservas por día, semana o mes. Acepta periodos futuros ('mañana', 'próximos 7 días').",
      source: SOURCE_RES,
      forward: true,
    },
    async (p) => {
      const unit = granularity(p.period);
      const rows = await reader.arrivalsDepartures(p.window, unit);
      const arrivals = rows.reduce((n, r) => n + r.arrivals, 0);
      const departures = rows.reduce((n, r) => n + r.departures, 0);
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SOURCE_RES),
        columns: [BUCKET_COLS[unit], { key: "llegadas", label: "Llegadas", kind: "integer" }, { key: "salidas", label: "Salidas", kind: "integer" }],
        rows: rows.map((r) => ({ periodo: r.bucket, llegadas: r.arrivals, salidas: r.departures })),
        chart: { kind: "bar", x: "periodo", y: "llegadas" },
        summary: `En ${p.period.label}: ${arrivals} llegadas y ${departures} salidas (${p.scopeLabel}).`,
      };
    },
  );

  const SOURCE_CANC = "Reservas canceladas, por día en que se canceló (valor = total reservado; penalización = cobrada por cancelación)";
  const cancelaciones = windowTool(
    reader,
    {
      name: "cancelaciones",
      label: "Cancelaciones",
      description: "Reservas canceladas en el periodo (por día de cancelación): cuántas, valor reservado que se canceló (MXN) y penalizaciones cobradas (MXN).",
      source: SOURCE_CANC,
    },
    async (p) => {
      const unit = granularity(p.period);
      const rows = await reader.cancellations(p.window, unit);
      const cancelled = rows.reduce((n, r) => n + r.cancelled, 0);
      const value = roundMoney(rows.reduce((n, r) => n + r.bookedValue, 0));
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SOURCE_CANC),
        columns: [
          BUCKET_COLS[unit],
          { key: "canceladas", label: "Canceladas", kind: "integer" },
          { key: "valor", label: "Valor reservado", kind: "mxn" },
          { key: "penalizaciones", label: "Penalizaciones", kind: "mxn" },
        ],
        rows: rows.map((r) => ({ periodo: r.bucket, canceladas: r.cancelled, valor: roundMoney(r.bookedValue), penalizaciones: roundMoney(r.penalties) })),
        chart: { kind: "bar", x: "periodo", y: "canceladas" },
        summary: `Cancelaciones de ${p.period.label}: ${cancelled} reservas por ${formatMxn(value)} (${p.scopeLabel}).`,
      };
    },
  );

  const SOURCE_TICKETS = "Tickets de huésped abiertos (abiertos, en progreso o escalados); sin el texto del huésped";
  const tickets: DataChatTool = {
    name: "tickets_abiertos_sla",
    label: "Tickets abiertos por SLA",
    description: "Tickets de huésped abiertos por departamento y prioridad, cuántos tienen el SLA vencido o por vencer en 2 horas, y cuántos están escalados. No depende de un periodo.",
    params: HOTEL_PARAM,
    async run(ctx, args) {
      try {
        const scope = await resolveScope(reader, ctx, args, SOURCE_TICKETS);
        if (!scope.ok) return scope.result;
        const rows = await reader.openTickets(ctx.scope.organizationId, scope.propertyIds, ctx.now, ctx.maxRows + 1);
        const open = rows.reduce((n, r) => n + r.openTickets, 0);
        const overdue = rows.reduce((n, r) => n + r.overdue, 0);
        return {
          status: rows.length === 0 ? "empty" : "ok",
          source: SOURCE_TICKETS,
          scopeLabel: scope.label,
          columns: [
            { key: "departamento", label: "Departamento", kind: "text" },
            { key: "prioridad", label: "Prioridad", kind: "text" },
            { key: "abiertos", label: "Abiertos", kind: "integer" },
            { key: "vencidos", label: "SLA vencido", kind: "integer" },
            { key: "por_vencer", label: "Vencen en 2 h", kind: "integer" },
            { key: "escalados", label: "Escalados", kind: "integer" },
          ],
          rows: rows.map((r) => ({
            departamento: DEPARTMENT_LABELS[r.department] ?? r.department,
            prioridad: PRIORITY_LABELS[r.priority] ?? r.priority,
            abiertos: r.openTickets,
            vencidos: r.overdue,
            por_vencer: r.dueSoon,
            escalados: r.escalated,
          })),
          chart: { kind: "bar", x: "departamento", y: "abiertos" },
          summary: `Tickets abiertos: ${open}, de los cuales ${overdue} con el SLA vencido (${scope.label}).`,
        };
      } catch (err) {
        if (err instanceof DataChatUnavailableError) return failure("unavailable", UNAVAILABLE_MESSAGE, SOURCE_TICKETS);
        throw err;
      }
    },
  };

  const SOURCE_HK = "Tareas de housekeeping pendientes o en progreso con día de trabajo hasta hoy (incluye el rezago de días anteriores)";
  const housekeeping: DataChatTool = {
    name: "housekeeping_pendiente",
    label: "Housekeeping pendiente",
    description: "Tareas de housekeeping pendientes y en progreso hasta hoy por tipo de tarea, cuántas son rezago de días anteriores y cuántas son de prioridad alta. No depende de un periodo.",
    params: HOTEL_PARAM,
    async run(ctx, args) {
      try {
        const scope = await resolveScope(reader, ctx, args, SOURCE_HK);
        if (!scope.ok) return scope.result;
        const today = resolvePeriod({ periodo: "hoy" }, ctx.now, ctx.scope.timezone);
        if (!today.ok) return failure("error", today.message, SOURCE_HK);
        const rows = await reader.housekeepingPending(ctx.scope.organizationId, scope.propertyIds, today.period.fromDate, ctx.maxRows + 1);
        const pending = rows.reduce((n, r) => n + r.pending, 0);
        const inProgress = rows.reduce((n, r) => n + r.inProgress, 0);
        const backlog = rows.reduce((n, r) => n + r.backlog, 0);
        return {
          status: rows.length === 0 ? "empty" : "ok",
          source: SOURCE_HK,
          periodLabel: today.period.label,
          scopeLabel: scope.label,
          columns: [
            { key: "tipo", label: "Tipo de tarea", kind: "text" },
            { key: "pendientes", label: "Pendientes", kind: "integer" },
            { key: "en_progreso", label: "En progreso", kind: "integer" },
            { key: "rezago", label: "De días anteriores", kind: "integer" },
            { key: "prioridad_alta", label: "Prioridad alta", kind: "integer" },
          ],
          rows: rows.map((r) => ({ tipo: TASK_LABELS[r.taskType] ?? r.taskType, pendientes: r.pending, en_progreso: r.inProgress, rezago: r.backlog, prioridad_alta: r.highPriority })),
          chart: { kind: "bar", x: "tipo", y: "pendientes" },
          summary: `Housekeeping: ${pending} tareas pendientes y ${inProgress} en progreso, ${backlog} de días anteriores (${scope.label}).`,
        };
      } catch (err) {
        if (err instanceof DataChatUnavailableError) return failure("unavailable", UNAVAILABLE_MESSAGE, SOURCE_HK);
        throw err;
      }
    },
  };

  return [ocupacion, ingresos, llegadas, cancelaciones, tickets, housekeeping];
}

export function buildHotelesDataChatCatalog(reader: HotelesDataChatReader): DataChatCatalog {
  return {
    vertical: "hoteles",
    domain: "un hotel (o cadena de hoteles) con habitaciones, reservas, folios, tickets de huésped y housekeeping",
    tools: buildHotelesDataChatTools(reader),
    async describeScope(scope) {
      const visible = await reader.listVisibleHotels(scope.organizationId, scope.allowedPropertyIds);
      if (visible.length === 0) return "No tiene hoteles activos asignados.";
      return `Hoteles que puede consultar (${visible.length}): ${visible.map((b) => b.name).join(", ")}. Si pide un hotel, usa su nombre en el parámetro "hotel".`;
    },
  };
}
