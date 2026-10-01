// Catalogo CERRADO de "Chatea con tus datos" para RENTAS VACACIONALES. Siete herramientas de solo lectura, todas
// con parametros tipados (periodo, propiedad por nombre, tipo de tarea) y alcance fijado por el servidor. Fechas de
// calendario en la zona de la propiedad (`rentas.property_config.zona_horaria`), montos en MXN (la base guarda
// centavos; solo se suma MXN y el resto se avisa). Para agregar otra herramienta o vertical: docs/DATA-CHAT.md.
import {
  MIXED_PERIOD_PARAMS,
  PERIOD_PARAMS,
  formatMxn,
  propertyParam,
  resolveMixedPeriod,
  resolvePeriod,
  resolvePropertySelection,
  roundMoney,
  type DataChatCatalog,
  type DataChatTool,
  type DataChatToolContext,
  type DataChatToolResult,
  type ParamsSpec,
  type ParsedArgs,
  type ResolvePeriodResult,
  type ResolvedPeriod,
} from "@atiende/agent-core/data-chat";
import { DataChatUnavailableError, type RentasDataChatReader, type RentasDataChatWindow, type TaskKind } from "./reader.ts";

const NOUNS = { singular: "propiedad", plural: "propiedades", feminine: true } as const;
const PROPERTY_PARAM: ParamsSpec = propertyParam("propiedad", NOUNS);
const MIXED_PARAMS: ParamsSpec = { ...MIXED_PERIOD_PARAMS, ...PROPERTY_PARAM };
const BACKWARD_PARAMS: ParamsSpec = { ...PERIOD_PARAMS, ...PROPERTY_PARAM };

const UNAVAILABLE_MESSAGE = "Esa información todavía no está disponible para tu cuenta (falta activar una actualización). Tus tableros siguen funcionando.";

const KIND_LABELS: Readonly<Record<string, string>> = { capa_cruzada: "Reserva cruzada con un bloqueo", overbooking_confirmado: "Sobreventa confirmada" };
const TASK_KIND_LABELS: Readonly<Record<string, string>> = { limpieza: "Limpieza", mantenimiento: "Mantenimiento", inspeccion: "Inspección" };
const TASK_STATUS_LABELS: Readonly<Record<string, string>> = { pendiente: "Pendiente", asignada: "Asignada", en_progreso: "En progreso", bloqueada: "Bloqueada" };
const PRIORITY_LABELS: Readonly<Record<string, string>> = { baja: "Baja", media: "Media", alta: "Alta", urgente: "Urgente" };

function failure(status: DataChatToolResult["status"], message: string, source: string): DataChatToolResult {
  return { status, message, source, scopeLabel: "", columns: [], rows: [] };
}

const mxnFromCents = (cents: number): number => roundMoney(cents / 100);
const pct = (part: number, total: number): number | null => (total > 0 ? Math.round((part / total) * 1000) / 10 : null);
const sum = (xs: readonly number[]): number => xs.reduce((n, x) => n + x, 0);

type ScopeResolution =
  | { readonly ok: true; readonly propertyIds: readonly string[] | null; readonly label: string }
  | { readonly ok: false; readonly result: DataChatToolResult };

async function resolveScope(reader: RentasDataChatReader, ctx: DataChatToolContext, args: ParsedArgs, source: string): Promise<ScopeResolution> {
  const visible = await reader.listVisibleProperties(ctx.scope.organizationId, ctx.scope.allowedPropertyIds);
  const b = resolvePropertySelection(visible, ctx.scope.allowedPropertyIds, args["propiedad"] as string | undefined, NOUNS);
  if (!b.ok) return { ok: false, result: failure("needs_clarification", b.message, source) };
  return { ok: true, propertyIds: b.propertyIds, label: b.label };
}

interface Prepared {
  readonly window: RentasDataChatWindow;
  readonly period: ResolvedPeriod;
  readonly scopeLabel: string;
}

async function prepare(
  reader: RentasDataChatReader,
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

function windowTool(
  reader: RentasDataChatReader,
  def: { name: string; label: string; description: string; source: string; mixed?: boolean },
  run: (p: Prepared, args: ParsedArgs, ctx: DataChatToolContext) => Promise<DataChatToolResult>,
): DataChatTool {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    params: def.mixed ? MIXED_PARAMS : BACKWARD_PARAMS,
    async run(ctx, args) {
      try {
        const prepared = await prepare(reader, ctx, args, def.source, def.mixed ? resolveMixedPeriod : resolvePeriod);
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

function currencyNote(otherCurrency: number): string {
  return otherCurrency > 0 ? ` ${otherCurrency} reserva(s) en otra moneda no se suman a los montos.` : "";
}

export function buildRentasDataChatTools(reader: RentasDataChatReader): readonly DataChatTool[] {
  const SOURCE_OCC = "Calendario de unidades: noches con reserva confirmada (no cuentan provisionales, canceladas ni en conflicto); disponibles = noches del periodo menos bloqueos de propietario o mantenimiento";
  const ocupacion = windowTool(
    reader,
    {
      name: "ocupacion_por_unidad",
      label: "Ocupación y noches por unidad",
      description: "Noches reservadas, noches bloqueadas (propietario/mantenimiento), noches disponibles y ocupación (%) por unidad en un periodo, que puede ser pasado o futuro (lo ya reservado).",
      source: SOURCE_OCC,
      mixed: true,
    },
    async (p) => {
      const rows = await reader.occupancyByUnit(p.window);
      if (rows.length === 0) return { status: "empty", ...base(p, SOURCE_OCC), columns: [], rows: [], message: "No encontré unidades activas en el alcance de tu cuenta." };
      const first = rows[0]!;
      const available = first.totalPeriod - first.totalBlocked;
      const occupancy = pct(first.totalBooked, available);
      return {
        status: "ok",
        ...base(p, SOURCE_OCC),
        columns: [
          { key: "unidad", label: "Unidad", kind: "text" },
          { key: "noches_reservadas", label: "Noches reservadas", kind: "integer" },
          { key: "noches_bloqueadas", label: "Noches bloqueadas", kind: "integer" },
          { key: "noches_disponibles", label: "Noches disponibles", kind: "integer" },
          { key: "ocupacion", label: "Ocupación", kind: "percent" },
        ],
        rows: rows.map((r) => {
          const avail = r.periodNights - r.blockedNights;
          return { unidad: r.unitName, noches_reservadas: r.bookedNights, noches_bloqueadas: r.blockedNights, noches_disponibles: avail, ocupacion: pct(r.bookedNights, avail) };
        }),
        chart: { kind: "bar", x: "unidad", y: "ocupacion" },
        summary: `Ocupación de ${p.period.label}: ${occupancy === null ? "sin noches disponibles (todo está bloqueado)" : `${occupancy}%`} (${first.totalBooked} noches reservadas de ${available} disponibles; ${first.totalBlocked} bloqueadas) en ${first.totalUnits} unidades (${p.scopeLabel}).`,
      };
    },
  );

  const SOURCE_CHANNEL = "Reservas confirmadas con llegada en el periodo y su desglose financiero (MXN); neto = lo que queda al propietario tras comisiones, gastos e impuestos";
  const porCanal = windowTool(
    reader,
    {
      name: "ingresos_por_canal",
      label: "Ingresos por canal",
      description: "Ingresos brutos (MXN), comisión del canal y neto de las reservas con llegada en el periodo, por canal (Airbnb, Vrbo, Booking, directa).",
      source: SOURCE_CHANNEL,
      mixed: true,
    },
    async (p) => {
      const rows = await reader.incomeByChannel(p.window);
      const gross = sum(rows.map((r) => r.grossCents));
      const other = sum(rows.map((r) => r.otherCurrency));
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SOURCE_CHANNEL),
        columns: [
          { key: "canal", label: "Canal", kind: "text" },
          { key: "reservas", label: "Reservas", kind: "integer" },
          { key: "noches", label: "Noches", kind: "integer" },
          { key: "ingresos", label: "Ingresos brutos", kind: "mxn" },
          { key: "comision_canal", label: "Comisión del canal", kind: "mxn" },
          { key: "neto", label: "Neto al propietario", kind: "mxn" },
        ],
        rows: rows.map((r) => ({ canal: r.channel, reservas: r.bookings, noches: r.nights, ingresos: mxnFromCents(r.grossCents), comision_canal: mxnFromCents(r.channelFeeCents), neto: mxnFromCents(r.netCents) })),
        chart: { kind: "bar", x: "canal", y: "ingresos" },
        summary: `Ingresos brutos de ${p.period.label}: ${formatMxn(gross / 100)} en ${sum(rows.map((r) => r.bookings))} reservas (${p.scopeLabel}).${currencyNote(other)}`,
      };
    },
  );

  const SOURCE_OWNER = "Reservas confirmadas con llegada en el periodo y su desglose financiero (MXN), agrupadas por propietario de la unidad";
  const porPropietario = windowTool(
    reader,
    {
      name: "ingresos_por_propietario",
      label: "Ingresos por propietario",
      description: "Ingresos brutos (MXN), comisiones (canal + gestión) y neto de las reservas con llegada en el periodo, por propietario de la unidad.",
      source: SOURCE_OWNER,
      mixed: true,
    },
    async (p) => {
      const rows = await reader.incomeByOwner(p.window);
      const gross = sum(rows.map((r) => r.grossCents));
      const other = sum(rows.map((r) => r.otherCurrency));
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SOURCE_OWNER),
        columns: [
          { key: "propietario", label: "Propietario", kind: "text" },
          { key: "reservas", label: "Reservas", kind: "integer" },
          { key: "noches", label: "Noches", kind: "integer" },
          { key: "ingresos", label: "Ingresos brutos", kind: "mxn" },
          { key: "comisiones", label: "Comisiones", kind: "mxn" },
          { key: "neto", label: "Neto al propietario", kind: "mxn" },
        ],
        rows: rows.map((r) => ({ propietario: r.ownerName, reservas: r.bookings, noches: r.nights, ingresos: mxnFromCents(r.grossCents), comisiones: mxnFromCents(r.feesCents), neto: mxnFromCents(r.netCents) })),
        chart: { kind: "bar", x: "propietario", y: "ingresos" },
        summary: `Ingresos brutos de ${p.period.label}: ${formatMxn(gross / 100)} entre ${rows.length} propietarios (${p.scopeLabel}).${currencyNote(other)}`,
      };
    },
  );

  const SOURCE_CONFLICTS = "Conflictos de calendario sin resolver (reservas cruzadas con bloqueos y sobreventas confirmadas); sin datos del huésped";
  const conflictos: DataChatTool = {
    name: "conflictos_calendario_abiertos",
    label: "Conflictos de calendario abiertos",
    description: "Conflictos de calendario que siguen sin resolver por unidad, con su tipo y los días que llevan abiertos. No depende de un periodo.",
    params: PROPERTY_PARAM,
    async run(ctx, args) {
      try {
        const scope = await resolveScope(reader, ctx, args, SOURCE_CONFLICTS);
        if (!scope.ok) return scope.result;
        const rows = await reader.openConflicts(ctx.scope.organizationId, scope.propertyIds, ctx.now, ctx.maxRows + 1);
        const total = rows[0]?.total ?? 0;
        return {
          status: rows.length === 0 ? "empty" : "ok",
          source: SOURCE_CONFLICTS,
          scopeLabel: scope.label,
          columns: [
            { key: "unidad", label: "Unidad", kind: "text" },
            { key: "tipo", label: "Tipo", kind: "text" },
            { key: "dias_abierto", label: "Días abierto", kind: "integer" },
          ],
          rows: rows.map((r) => ({ unidad: r.unitName, tipo: KIND_LABELS[r.kind] ?? r.kind, dias_abierto: r.daysOpen })),
          summary: `Conflictos de calendario abiertos: ${total} (${scope.label}).`,
        };
      } catch (err) {
        if (err instanceof DataChatUnavailableError) return failure("unavailable", UNAVAILABLE_MESSAGE, SOURCE_CONFLICTS);
        throw err;
      }
    },
  };

  const SOURCE_TASKS = "Tareas operativas sin completar (pendientes, asignadas, en progreso o bloqueadas) por fecha programada";
  const tareas: DataChatTool = {
    name: "tareas_pendientes",
    label: "Tareas de limpieza y mantenimiento pendientes",
    description:
      "Tareas pendientes de limpieza, mantenimiento o inspección por unidad, con su estado, prioridad y si el SLA ya venció. Sin periodo: todo lo programado hasta hoy (incluye el rezago). Con periodo: lo programado en esas fechas (puede ser futuro).",
    params: {
      ...MIXED_PARAMS,
      tipo: { type: "enum", values: ["limpieza", "mantenimiento", "inspeccion", "todas"], optional: true, description: "Tipo de tarea. Por defecto 'limpieza'." },
    },
    async run(ctx, args) {
      try {
        const scope = await resolveScope(reader, ctx, args, SOURCE_TASKS);
        if (!scope.ok) return scope.result;
        const hasPeriod = args["periodo"] !== undefined || args["desde"] !== undefined || args["hasta"] !== undefined;
        const resolved = hasPeriod ? resolveMixedPeriod(args, ctx.now, ctx.scope.timezone) : resolveMixedPeriod({ periodo: "hoy" }, ctx.now, ctx.scope.timezone);
        if (!resolved.ok) return failure(resolved.kind === "needs_clarification" ? "needs_clarification" : "error", resolved.message, SOURCE_TASKS);
        const period = resolved.period;
        const tipoArg = (args["tipo"] as string | undefined) ?? "limpieza";
        const kind = tipoArg === "todas" ? null : (tipoArg as TaskKind);
        const rows = await reader.pendingTasks(ctx.scope.organizationId, scope.propertyIds, { fromDate: hasPeriod ? period.fromDate : null, toDate: period.toDate }, ctx.now, kind, ctx.maxRows + 1);
        const total = rows[0]?.total ?? 0;
        const overdue = rows.filter((r) => r.slaOverdue).length;
        const periodLabel = hasPeriod ? period.label : `hasta hoy, ${period.toDate} (incluye el rezago)`;
        return {
          status: rows.length === 0 ? "empty" : "ok",
          source: SOURCE_TASKS,
          periodLabel,
          scopeLabel: scope.label,
          columns: [
            { key: "unidad", label: "Unidad", kind: "text" },
            { key: "tipo", label: "Tipo", kind: "text" },
            { key: "estado", label: "Estado", kind: "text" },
            { key: "prioridad", label: "Prioridad", kind: "text" },
            { key: "programada", label: "Programada", kind: "text" },
            { key: "sla_vencido", label: "SLA vencido", kind: "text" },
          ],
          rows: rows.map((r) => ({
            unidad: r.unitName,
            tipo: TASK_KIND_LABELS[r.kind] ?? r.kind,
            estado: TASK_STATUS_LABELS[r.status] ?? r.status,
            prioridad: PRIORITY_LABELS[r.priority] ?? r.priority,
            programada: r.scheduled,
            sla_vencido: r.slaOverdue ? "Sí" : "No",
          })),
          summary: `Tareas pendientes (${tipoArg === "todas" ? "todas" : tipoArg}) ${periodLabel}: ${total}${total > rows.length ? ` (se muestran ${rows.length})` : `, ${overdue} con el SLA vencido`} (${scope.label}).`,
        };
      } catch (err) {
        if (err instanceof DataChatUnavailableError) return failure("unavailable", UNAVAILABLE_MESSAGE, SOURCE_TASKS);
        throw err;
      }
    },
  };

  const SOURCE_STATEMENTS = "Liquidaciones a propietarios cuyo periodo se traslapa con el rango; solo la última versión de cada una (MXN)";
  const liquidaciones = windowTool(
    reader,
    {
      name: "liquidaciones_propietarios",
      label: "Liquidaciones a propietarios",
      description: "Liquidaciones (estados de cuenta) generadas a propietarios cuyo periodo se traslapa con el rango: ingresos brutos y neto (MXN). Solo la última versión de cada una.",
      source: SOURCE_STATEMENTS,
    },
    async (p) => {
      const all = await reader.ownerStatements(p.window);
      const rows = all.filter((r) => r.currency === "MXN");
      const skipped = all.length - rows.length;
      const net = sum(rows.map((r) => r.netCents));
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SOURCE_STATEMENTS),
        columns: [
          { key: "propietario", label: "Propietario", kind: "text" },
          { key: "periodo", label: "Periodo", kind: "text" },
          { key: "version", label: "Versión", kind: "integer" },
          { key: "ingresos", label: "Ingresos brutos", kind: "mxn" },
          { key: "neto", label: "Neto", kind: "mxn" },
          { key: "generada", label: "Generada", kind: "text" },
        ],
        rows: rows.map((r) => ({ propietario: r.ownerName, periodo: `${r.periodStart} a ${r.periodEnd}`, version: r.version, ingresos: mxnFromCents(r.grossCents), neto: mxnFromCents(r.netCents), generada: r.generatedOn })),
        summary: `Liquidaciones de ${p.period.label}: ${rows.length}, neto total ${formatMxn(net / 100)} (${p.scopeLabel}).${skipped > 0 ? ` ${skipped} liquidación(es) en otra moneda no se muestran.` : ""}`,
      };
    },
  );

  const SOURCE_PAYOUTS = "Pagos recibidos de los canales por fecha de pago (MXN), con las líneas por conciliar";
  const pagos = windowTool(
    reader,
    {
      name: "pagos_de_canal",
      label: "Pagos de canal",
      description: "Pagos recibidos de cada canal (Airbnb, Vrbo, Booking) en el periodo: cuántos, monto total (MXN) y cuántas líneas siguen pendientes de conciliar o con discrepancia.",
      source: SOURCE_PAYOUTS,
    },
    async (p) => {
      const rows = await reader.channelPayouts(p.window);
      const total = sum(rows.map((r) => r.totalCents));
      const other = sum(rows.map((r) => r.otherCurrency));
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SOURCE_PAYOUTS),
        columns: [
          { key: "canal", label: "Canal", kind: "text" },
          { key: "pagos", label: "Pagos", kind: "integer" },
          { key: "monto", label: "Monto", kind: "mxn" },
          { key: "lineas_pendientes", label: "Líneas por conciliar", kind: "integer" },
          { key: "lineas_discrepancia", label: "Con discrepancia", kind: "integer" },
        ],
        rows: rows.map((r) => ({ canal: r.channel, pagos: r.payouts, monto: mxnFromCents(r.totalCents), lineas_pendientes: r.pendingLines, lineas_discrepancia: r.mismatchedLines })),
        chart: { kind: "bar", x: "canal", y: "monto" },
        summary: `Pagos de canal de ${p.period.label}: ${formatMxn(total / 100)} en ${sum(rows.map((r) => r.payouts))} pagos (${p.scopeLabel}).${other > 0 ? ` ${other} pago(s) en otra moneda no se suman.` : ""}`,
      };
    },
  );

  return [ocupacion, porCanal, porPropietario, conflictos, tareas, liquidaciones, pagos];
}

export function buildRentasDataChatCatalog(reader: RentasDataChatReader): DataChatCatalog {
  return {
    vertical: "rentas",
    domain: "una gestora de rentas vacacionales con propiedades, unidades, reservas por canal (Airbnb, Vrbo, Booking), propietarios, limpieza y liquidaciones",
    tools: buildRentasDataChatTools(reader),
    async describeScope(scope) {
      const visible = await reader.listVisibleProperties(scope.organizationId, scope.allowedPropertyIds);
      if (visible.length === 0) return "No tiene propiedades activas asignadas.";
      return `Propiedades que puede consultar (${visible.length}): ${visible.map((b) => b.name).join(", ")}. Si pide una propiedad, usa su nombre en el parámetro "propiedad".`;
    },
  };
}
