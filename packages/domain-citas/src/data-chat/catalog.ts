// Catalogo CERRADO de "Chatea con tus datos" para CITAS. Ocho herramientas de solo lectura, todas con parametros
// tipados (periodo, sucursal por nombre, agrupacion) y alcance fijado por el servidor. Periodos y dias en la zona de
// la sucursal activa (`citas.property_config.timezone`, si no hay la de la organizacion), montos en MXN (el precio del
// servicio vive en centavos). Para agregar otra herramienta o vertical: docs/DATA-CHAT.md.
import {
  FORWARD_PERIOD_PARAMS,
  MIXED_PERIOD_PARAMS,
  PERIOD_PARAMS,
  formatMxn,
  propertyParam,
  resolveForwardPeriod,
  resolveMixedPeriod,
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
import { DataChatUnavailableError, type CitasDataChatReader, type CitasDataChatWindow, type Granularity, type ReminderDeliveryRow } from "./reader.ts";

const NOUNS = { singular: "sucursal", plural: "sucursales", feminine: true } as const;
const BRANCH_PARAM: ParamsSpec = propertyParam("sucursal", NOUNS);
const BACKWARD_PARAMS: ParamsSpec = { ...PERIOD_PARAMS, ...BRANCH_PARAM };
const MIXED_PARAMS: ParamsSpec = { ...MIXED_PERIOD_PARAMS, ...BRANCH_PARAM };
const FORWARD_PARAMS: ParamsSpec = { ...FORWARD_PERIOD_PARAMS, ...BRANCH_PARAM };

const UNAVAILABLE_MESSAGE = "Esa información todavía no está disponible para tu cuenta (falta activar una actualización). Tus tableros siguen funcionando.";

type PeriodKind = "backward" | "mixed" | "forward";
const PARAMS_BY_KIND: Readonly<Record<PeriodKind, ParamsSpec>> = { backward: BACKWARD_PARAMS, mixed: MIXED_PARAMS, forward: FORWARD_PARAMS };
const RESOLVER_BY_KIND: Readonly<Record<PeriodKind, (a: ParsedArgs, now: Date, tz: string) => ResolvePeriodResult>> = {
  backward: resolvePeriod,
  mixed: resolveMixedPeriod,
  forward: resolveForwardPeriod,
};

const CHANNEL_LABELS: Readonly<Record<string, string>> = { whatsapp: "WhatsApp", email: "Correo" };

function failure(status: DataChatToolResult["status"], message: string, source: string): DataChatToolResult {
  return { status, message, source, scopeLabel: "", columns: [], rows: [] };
}

const sum = (xs: readonly number[]): number => xs.reduce((n, x) => n + x, 0);
const mxnFromCents = (cents: number): number => roundMoney(cents / 100);
const hours = (minutes: number): number => Math.round((minutes / 60) * 10) / 10;
/** Porcentaje con un decimal; null si no hay base (no se inventa un 0%). */
const pct = (part: number, total: number): number | null => (total > 0 ? Math.round((part / total) * 1000) / 10 : null);
const pctText = (v: number | null): string => (v === null ? "sin base para calcularlo" : `${v}%`);

function pickGranularity(period: ResolvedPeriod): Granularity {
  const days = Math.round((period.end.getTime() - period.start.getTime()) / 86_400_000);
  return days <= 50 ? "day" : days <= 300 ? "week" : "month";
}

const PERIOD_COLUMN = {
  day: { key: "periodo", label: "Día", kind: "text" },
  week: { key: "periodo", label: "Semana (inicia lunes)", kind: "text" },
  month: { key: "periodo", label: "Mes (inicio)", kind: "text" },
} as const satisfies Record<Granularity, DataChatColumn>;

interface Prepared {
  readonly window: CitasDataChatWindow;
  readonly period: ResolvedPeriod;
  readonly scopeLabel: string;
}

async function prepare(reader: CitasDataChatReader, ctx: DataChatToolContext, args: ParsedArgs, source: string, kind: PeriodKind): Promise<Prepared | DataChatToolResult> {
  const p = RESOLVER_BY_KIND[kind](args, ctx.now, ctx.scope.timezone);
  if (!p.ok) return failure(p.kind === "needs_clarification" ? "needs_clarification" : "error", p.message, source);
  // La sucursal se resuelve SOLO entre las que el usuario puede ver (alcance del servidor).
  const visible = await reader.listVisibleBranches(ctx.scope.organizationId, ctx.scope.allowedPropertyIds);
  const b = resolvePropertySelection(visible, ctx.scope.allowedPropertyIds, args["sucursal"] as string | undefined, NOUNS);
  if (!b.ok) return failure("needs_clarification", b.message, source);
  return {
    period: p.period,
    scopeLabel: b.label,
    window: {
      organizationId: ctx.scope.organizationId,
      propertyIds: b.propertyIds,
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
  reader: CitasDataChatReader,
  def: { name: string; label: string; description: string; source: string; kind: PeriodKind; extraParams?: ParamsSpec },
  run: (p: Prepared, args: ParsedArgs, ctx: DataChatToolContext) => Promise<DataChatToolResult>,
): DataChatTool {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    params: { ...PARAMS_BY_KIND[def.kind], ...def.extraParams },
    async run(ctx, args) {
      try {
        const prepared = await prepare(reader, ctx, args, def.source, def.kind);
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

export function buildCitasDataChatTools(reader: CitasDataChatReader): readonly DataChatTool[] {
  const SOURCE_APPTS = "Citas con inicio en el periodo, todos los estados (por atender = pendientes y confirmadas); cada cita cuenta una vez, en el día local de la sucursal";
  const citasPorDia = windowTool(
    reader,
    {
      name: "citas_por_dia",
      label: "Citas por día o semana",
      description: "Número de citas por día en un periodo (por semana o mes si el periodo es largo), separando por atender, completadas, canceladas y no asistió. El periodo puede ser pasado o futuro (lo ya agendado).",
      source: SOURCE_APPTS,
      kind: "mixed",
    },
    async (p) => {
      const unit = pickGranularity(p.period);
      const rows = await reader.appointmentsByPeriod(p.window, unit);
      const total = sum(rows.map((r) => r.total));
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SOURCE_APPTS),
        columns: [
          PERIOD_COLUMN[unit],
          { key: "citas", label: "Citas", kind: "integer" },
          { key: "por_atender", label: "Por atender", kind: "integer" },
          { key: "completadas", label: "Completadas", kind: "integer" },
          { key: "canceladas", label: "Canceladas", kind: "integer" },
          { key: "no_asistio", label: "No asistió", kind: "integer" },
        ],
        rows: rows.map((r) => ({ periodo: r.bucket, citas: r.total, por_atender: r.scheduled, completadas: r.completed, canceladas: r.cancelled, no_asistio: r.noShow })),
        chart: { kind: unit === "day" ? "line" : "bar", x: "periodo", y: "citas" },
        summary: `Citas de ${p.period.label}: ${total} (${sum(rows.map((r) => r.completed))} completadas, ${sum(rows.map((r) => r.scheduled))} por atender, ${sum(rows.map((r) => r.cancelled))} canceladas, ${sum(rows.map((r) => r.noShow))} no asistieron) (${p.scopeLabel}).`,
      };
    },
  );

  const SOURCE_OCC = "Horario de atención configurado de cada profesional activo (reglas semanales y excepciones del día) frente a las citas pendientes, confirmadas o completadas dentro de ese horario; una cita fuera de horario no cuenta";
  const ocupacion = windowTool(
    reader,
    {
      name: "ocupacion",
      label: "Ocupación por profesional o sucursal",
      description: "Horas de atención disponibles, horas ocupadas por citas y ocupación (%) por profesional o por sucursal en un periodo, pasado o futuro (lo ya agendado).",
      source: SOURCE_OCC,
      kind: "mixed",
      extraParams: { agrupar_por: { type: "enum", values: ["profesional", "sucursal"], optional: true, description: "Agrupa por profesional (por defecto) o por sucursal." } },
    },
    async (p, args) => {
      const byBranch = args["agrupar_por"] === "sucursal";
      const common = { ...base(p, SOURCE_OCC) };
      if (byBranch) {
        const rows = await reader.occupancyByBranch(p.window);
        if (rows.length === 0) return { status: "empty", ...common, columns: [], rows: [], message: "No encontré profesionales activos en el alcance de tu cuenta." };
        const first = rows[0]!;
        if (first.totalAvailable <= 0) return { status: "empty", ...common, columns: [], rows: [], message: `Los profesionales de ${p.scopeLabel} no tienen horario de atención configurado en ${p.period.label}, así que no se puede calcular la ocupación.` };
        return {
          status: "ok",
          ...common,
          columns: [
            { key: "sucursal", label: "Sucursal", kind: "text" },
            { key: "profesionales", label: "Profesionales", kind: "integer" },
            { key: "horas_disponibles", label: "Horas disponibles", kind: "decimal" },
            { key: "horas_ocupadas", label: "Horas ocupadas", kind: "decimal" },
            { key: "ocupacion", label: "Ocupación", kind: "percent" },
          ],
          rows: rows.map((r) => ({ sucursal: r.branch, profesionales: r.providers, horas_disponibles: hours(r.availableMinutes), horas_ocupadas: hours(r.bookedMinutes), ocupacion: pct(r.bookedMinutes, r.availableMinutes) })),
          chart: { kind: "bar", x: "sucursal", y: "ocupacion" },
          summary: `Ocupación de ${p.period.label}: ${pctText(pct(first.totalBooked, first.totalAvailable))} (${hours(first.totalBooked)} h ocupadas de ${hours(first.totalAvailable)} h disponibles) con ${first.totalProviders} profesionales (${p.scopeLabel}).`,
        };
      }
      const rows = await reader.occupancyByProvider(p.window);
      if (rows.length === 0) return { status: "empty", ...common, columns: [], rows: [], message: "No encontré profesionales activos en el alcance de tu cuenta." };
      const first = rows[0]!;
      if (first.totalAvailable <= 0) return { status: "empty", ...common, columns: [], rows: [], message: `Los profesionales de ${p.scopeLabel} no tienen horario de atención configurado en ${p.period.label}, así que no se puede calcular la ocupación.` };
      return {
        status: "ok",
        ...common,
        columns: [
          { key: "profesional", label: "Profesional", kind: "text" },
          { key: "sucursal", label: "Sucursal", kind: "text" },
          { key: "horas_disponibles", label: "Horas disponibles", kind: "decimal" },
          { key: "horas_ocupadas", label: "Horas ocupadas", kind: "decimal" },
          { key: "ocupacion", label: "Ocupación", kind: "percent" },
        ],
        rows: rows.map((r) => ({ profesional: r.provider, sucursal: r.branch, horas_disponibles: hours(r.availableMinutes), horas_ocupadas: hours(r.bookedMinutes), ocupacion: pct(r.bookedMinutes, r.availableMinutes) })),
        chart: { kind: "bar", x: "profesional", y: "ocupacion" },
        summary: `Ocupación de ${p.period.label}: ${pctText(pct(first.totalBooked, first.totalAvailable))} (${hours(first.totalBooked)} h ocupadas de ${hours(first.totalAvailable)} h disponibles) con ${first.totalProviders} profesionales (${p.scopeLabel}).`,
      };
    },
  );

  const SOURCE_ATT = "Citas con inicio en el periodo, todos los estados; tasa = canceladas (o no asistió) entre todas las citas del profesional";
  const asistencia = windowTool(
    reader,
    {
      name: "no_shows_y_cancelaciones",
      label: "No-shows y cancelaciones",
      description: "Citas canceladas y citas a las que el cliente no asistió (no-show), con su tasa, por profesional en un periodo.",
      source: SOURCE_ATT,
      kind: "backward",
    },
    async (p) => {
      const rows = await reader.attendanceByProvider(p.window);
      const first = rows[0];
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SOURCE_ATT),
        columns: [
          { key: "profesional", label: "Profesional", kind: "text" },
          { key: "citas", label: "Citas", kind: "integer" },
          { key: "completadas", label: "Completadas", kind: "integer" },
          { key: "canceladas", label: "Canceladas", kind: "integer" },
          { key: "no_asistio", label: "No asistió", kind: "integer" },
          { key: "tasa_cancelacion", label: "Tasa de cancelación", kind: "percent" },
          { key: "tasa_no_asistencia", label: "Tasa de no asistencia", kind: "percent" },
        ],
        rows: rows.map((r) => ({ profesional: r.provider, citas: r.total, completadas: r.completed, canceladas: r.cancelled, no_asistio: r.noShow, tasa_cancelacion: pct(r.cancelled, r.total), tasa_no_asistencia: pct(r.noShow, r.total) })),
        chart: { kind: "bar", x: "profesional", y: "tasa_cancelacion" },
        summary: first
          ? `En ${p.period.label}: ${first.grandCancelled} citas canceladas (${pctText(pct(first.grandCancelled, first.grandTotal))}) y ${first.grandNoShow} no asistieron (${pctText(pct(first.grandNoShow, first.grandTotal))}) de ${first.grandTotal} citas (${p.scopeLabel}).`
          : undefined,
      };
    },
  );

  const SOURCE_REV = "Citas COMPLETADAS con inicio en el periodo, valuadas al precio de lista actual de su servicio (MXN); la base no registra cobros, descuentos ni propinas, así que no es dinero cobrado";
  const withoutPriceNote = (n: number): string => (n > 0 ? ` ${n} cita(s) completada(s) de servicios sin precio no suman.` : "");
  const ingresosPeriodo = windowTool(
    reader,
    {
      name: "ingresos_por_periodo",
      label: "Ingresos por día, semana o mes",
      description: "Ingresos estimados (MXN) de las citas completadas por día en un periodo (por semana o mes si el periodo es largo). Úsala también para 'cuánto facturé' en un periodo.",
      source: SOURCE_REV,
      kind: "backward",
    },
    async (p) => {
      const unit = pickGranularity(p.period);
      const rows = await reader.revenueByPeriod(p.window, unit);
      const total = mxnFromCents(sum(rows.map((r) => r.revenueCents)));
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SOURCE_REV),
        columns: [PERIOD_COLUMN[unit], { key: "citas_completadas", label: "Citas completadas", kind: "integer" }, { key: "ingresos", label: "Ingresos", kind: "mxn" }],
        rows: rows.map((r) => ({ periodo: r.bucket, citas_completadas: r.appointments, ingresos: mxnFromCents(r.revenueCents) })),
        chart: { kind: unit === "day" ? "line" : "bar", x: "periodo", y: "ingresos" },
        summary: `Ingresos estimados de ${p.period.label}: ${formatMxn(total)} en ${sum(rows.map((r) => r.appointments))} citas completadas (${p.scopeLabel}).${withoutPriceNote(sum(rows.map((r) => r.withoutPrice)))}`,
      };
    },
  );

  const ingresosServicio = windowTool(
    reader,
    {
      name: "ingresos_por_servicio",
      label: "Ingresos por servicio",
      description: "Ingresos estimados (MXN) y número de citas completadas por servicio en un periodo (cuál servicio deja más dinero).",
      source: SOURCE_REV,
      kind: "backward",
    },
    async (p) => {
      const rows = await reader.revenueByService(p.window);
      const first = rows[0];
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SOURCE_REV),
        columns: [
          { key: "servicio", label: "Servicio", kind: "text" },
          { key: "citas_completadas", label: "Citas completadas", kind: "integer" },
          { key: "ingresos", label: "Ingresos", kind: "mxn" },
          { key: "participacion", label: "Participación", kind: "percent" },
        ],
        rows: rows.map((r) => ({ servicio: r.service, citas_completadas: r.appointments, ingresos: mxnFromCents(r.revenueCents), participacion: pct(r.revenueCents, r.totalRevenueCents) })),
        chart: { kind: "bar", x: "servicio", y: "ingresos" },
        summary: first
          ? `Ingresos estimados de ${p.period.label}: ${formatMxn(mxnFromCents(first.totalRevenueCents))}; el servicio que más deja es ${first.service} (${p.scopeLabel}).${withoutPriceNote(sum(rows.map((r) => r.withoutPrice)))}`
          : undefined,
      };
    },
  );

  const SOURCE_CUST = "Clientes con al menos una cita pendiente, confirmada o completada con inicio en el periodo; nuevo = su primera cita dentro de tu alcance cae en el periodo, recurrente = ya tenía una antes. Solo conteos, nunca datos del cliente";
  const clientes = windowTool(
    reader,
    {
      name: "clientes_nuevos_vs_recurrentes",
      label: "Clientes nuevos y recurrentes",
      description: "Cuántos clientes atendidos en un periodo son nuevos y cuántos recurrentes (solo conteos, sin nombres).",
      source: SOURCE_CUST,
      kind: "backward",
    },
    async (p) => {
      const c = await reader.customers(p.window);
      return {
        status: c.customers === 0 ? "empty" : "ok",
        ...base(p, SOURCE_CUST),
        columns: [
          { key: "clientes", label: "Clientes", kind: "integer" },
          { key: "nuevos", label: "Nuevos", kind: "integer" },
          { key: "recurrentes", label: "Recurrentes", kind: "integer" },
          { key: "pct_recurrentes", label: "% recurrentes", kind: "percent" },
        ],
        rows: [{ clientes: c.customers, nuevos: c.newCustomers, recurrentes: c.recurring, pct_recurrentes: pct(c.recurring, c.customers) }],
        summary: c.customers > 0 ? `Clientes de ${p.period.label}: ${c.customers} (${c.newCustomers} nuevos y ${c.recurring} recurrentes) (${p.scopeLabel}).` : `Sin clientes con citas vivas en ${p.period.label}.`,
      };
    },
  );

  const SOURCE_FREE = "Horario de atención configurado de cada profesional activo, de este momento en adelante, menos sus citas pendientes, confirmadas o completadas; no considera la duración de cada servicio, así que un hueco corto puede no alcanzar para una cita";
  const huecos = windowTool(
    reader,
    {
      name: "huecos_libres",
      label: "Huecos libres en la agenda",
      description: "Horas libres de agenda por profesional y día en un periodo futuro (hoy, mañana, próximos días): horario de atención menos citas ya agendadas.",
      source: SOURCE_FREE,
      kind: "forward",
    },
    async (p, _args, ctx) => {
      const rows = await reader.freeSlots(p.window, ctx.now);
      if (rows.length === 0) {
        return { status: "empty", ...base(p, SOURCE_FREE), columns: [], rows: [], message: `No encontré horas libres en ${p.period.label}: no hay horario de atención configurado o la agenda ya está llena.` };
      }
      return {
        status: "ok",
        ...base(p, SOURCE_FREE),
        columns: [
          { key: "dia", label: "Día", kind: "text" },
          { key: "profesional", label: "Profesional", kind: "text" },
          { key: "sucursal", label: "Sucursal", kind: "text" },
          { key: "horas_libres", label: "Horas libres", kind: "decimal" },
        ],
        rows: rows.map((r) => ({ dia: r.day, profesional: r.provider, sucursal: r.branch, horas_libres: hours(r.freeMinutes) })),
        summary: `Horas libres de ${p.period.label}: ${hours(rows[0]!.totalFree)} h en total (${p.scopeLabel}).`,
      };
    },
  );

  const SOURCE_REM = "Citas por atender (pendientes y confirmadas) de este momento en adelante dentro del periodo sin recordatorio marcado como enviado, y estado de envío de los recordatorios de las citas del periodo (solo conteos)";
  const recordatorios = windowTool(
    reader,
    {
      name: "recordatorios",
      label: "Recordatorios pendientes y fallidos",
      description: "Cuántas citas próximas aún no tienen recordatorio enviado y cuántos recordatorios (WhatsApp y correo) se enviaron, siguen en cola o fallaron, para las citas de un periodo.",
      source: SOURCE_REM,
      kind: "mixed",
    },
    async (p, _args, ctx) => {
      const pending = await reader.pendingReminders(p.window, ctx.now);
      let delivery: readonly ReminderDeliveryRow[] | null = null;
      try {
        delivery = await reader.reminderDelivery(p.window);
      } catch (err) {
        // Solo el detalle de envio depende de la migracion 027: lo demas se responde igual.
        if (!(err instanceof DataChatUnavailableError)) throw err;
      }
      const tableRows: { concepto: string; total: number }[] = [
        { concepto: "Citas por atender sin recordatorio enviado", total: pending.pending },
        { concepto: "…de ellas, las que empiezan en menos de 24 horas", total: pending.next24h },
      ];
      const failedByChannel: string[] = [];
      for (const channel of [...new Set((delivery ?? []).map((d) => d.channel))].sort()) {
        const of = (statuses: readonly string[]): number => sum((delivery ?? []).filter((d) => d.channel === channel && statuses.includes(d.status)).map((d) => d.total));
        const label = CHANNEL_LABELS[channel] ?? channel;
        const failed = of(["failed", "dead"]);
        tableRows.push({ concepto: `${label}: enviados`, total: of(["sent"]) }, { concepto: `${label}: en cola`, total: of(["pending", "processing"]) }, { concepto: `${label}: fallidos`, total: failed });
        if (failed > 0) failedByChannel.push(`${failed} por ${label}`);
      }
      const nothing = pending.pending === 0 && (delivery === null || delivery.length === 0);
      const deliveryNote = delivery === null ? " El detalle de envíos (enviados y fallidos) todavía no está disponible para tu cuenta (falta activar una actualización)." : delivery.length === 0 ? " No hay recordatorios registrados para las citas de ese periodo." : "";
      const failedText = failedByChannel.length > 0 ? ` Fallidos: ${failedByChannel.join(" y ")}.` : "";
      return {
        status: nothing && delivery !== null ? "empty" : "ok",
        ...base(p, SOURCE_REM),
        columns: [{ key: "concepto", label: "Concepto", kind: "text" }, { key: "total", label: "Total", kind: "integer" }],
        rows: tableRows,
        message: nothing && delivery !== null ? `No hay recordatorios pendientes ni envíos registrados para ${p.period.label}.` : undefined,
        summary: `Recordatorios de ${p.period.label}: ${pending.pending} citas por atender aún sin recordatorio enviado (${pending.next24h} empiezan en menos de 24 h) (${p.scopeLabel}).${failedText}${deliveryNote}`,
      };
    },
  );

  return [citasPorDia, ocupacion, asistencia, ingresosPeriodo, ingresosServicio, clientes, huecos, recordatorios];
}

export function buildCitasDataChatCatalog(reader: CitasDataChatReader): DataChatCatalog {
  return {
    vertical: "citas",
    domain: "un negocio de citas (consultorio, clínica, salón, barbería, spa, etc.) con sucursales, profesionales con horario de atención, servicios con precio, clientes y recordatorios por WhatsApp y correo",
    tools: buildCitasDataChatTools(reader),
    async describeScope(scope) {
      const visible = await reader.listVisibleBranches(scope.organizationId, scope.allowedPropertyIds);
      if (visible.length === 0) return "No tiene sucursales activas asignadas.";
      return `Sucursales que puede consultar (${visible.length}): ${visible.map((b) => b.name).join(", ")}. Si pide una sucursal, usa su nombre en el parámetro "sucursal".`;
    },
  };
}
