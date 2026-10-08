// Catalogo CERRADO de "Chatea con tus datos" para RESTAURANTES. Ocho herramientas de solo lectura (mas las nueve `cfo_*` de CFO-09, en cfo-tools.ts),
// todas con parametros tipados (periodo, sucursal por nombre, limite, orden) y alcance fijado por
// el servidor. Para agregar otra vertical: ver docs/DATA-CHAT.md.
import {
  PERIOD_PARAMS,
  formatMxn,
  resolvePeriod,
  roundMoney,
  type DataChatCatalog,
  type DataChatColumn,
  type DataChatTool,
  type DataChatToolContext,
  type DataChatToolResult,
  type ParamsSpec,
  type ParsedArgs,
  type ResolvedPeriod,
} from "@atiende/agent-core/data-chat";
import { buildCfoDataChatTools } from "./cfo-tools.ts";
import { DataChatUnavailableError, type DataChatWindow, type RestaurantesDataChatReader, type SalesGranularity, type VisibleBranch } from "./reader.ts";

const SOURCE_ORDERS = "Pedidos de restaurantes (sin cancelados, no recogidos ni programados)";
const UNAVAILABLE_MESSAGE = "Esa información todavía no está disponible para tu cuenta (falta activar una actualización). Tus tableros siguen funcionando.";

const BRANCH_PARAM: ParamsSpec = {
  sucursal: {
    type: "string",
    maxLength: 60,
    optional: true,
    description: "Nombre de UNA sucursal (opcional). Omítelo para consultar todas las sucursales a las que tiene acceso el usuario. No inventes nombres.",
  },
};
const WINDOW_PARAMS: ParamsSpec = { ...PERIOD_PARAMS, ...BRANCH_PARAM };

const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

type BranchResolution =
  | { readonly ok: true; readonly propertyIds: readonly string[] | null; readonly label: string }
  | { readonly ok: false; readonly message: string };

/** Resuelve `sucursal` SOLO entre las sucursales que el usuario puede ver. Un nombre fuera de ese
 * conjunto responde igual que uno inexistente: nunca confirma que exista una sucursal ajena. */
export function resolveBranchSelection(visible: readonly VisibleBranch[], allowed: readonly string[] | null, requested: string | undefined): BranchResolution {
  if (requested === undefined || requested === "") {
    if (allowed === null) return { ok: true, propertyIds: null, label: "todas tus sucursales" };
    const n = visible.length;
    return { ok: true, propertyIds: allowed, label: n === 1 ? `sucursal ${visible[0]!.name}` : `tus ${n} sucursales asignadas` };
  }
  const needle = fold(requested);
  const exact = visible.filter((b) => fold(b.name) === needle || fold(b.slug) === needle);
  const matches = exact.length > 0 ? exact : visible.filter((b) => fold(b.name).includes(needle) || fold(b.slug).includes(needle));
  if (matches.length === 1) return { ok: true, propertyIds: [matches[0]!.propertyId], label: `sucursal ${matches[0]!.name}` };
  const names = visible.map((b) => b.name).join(", ");
  if (matches.length > 1) return { ok: false, message: `Hay varias sucursales que coinciden con "${requested}": ${matches.map((b) => b.name).join(", ")}. ¿Cuál quieres?` };
  return { ok: false, message: `No encontré esa sucursal entre las que puedes consultar${names ? `: ${names}` : ""}.` };
}

function failure(status: DataChatToolResult["status"], message: string, source: string): DataChatToolResult {
  return { status, message, source, scopeLabel: "", columns: [], rows: [] };
}

interface Prepared {
  readonly window: DataChatWindow;
  readonly period: ResolvedPeriod;
  readonly scopeLabel: string;
}

async function prepare(reader: RestaurantesDataChatReader, ctx: DataChatToolContext, args: ParsedArgs): Promise<Prepared | DataChatToolResult> {
  const p = resolvePeriod(args, ctx.now, ctx.scope.timezone);
  if (!p.ok) return failure(p.kind === "needs_clarification" ? "needs_clarification" : "error", p.message, SOURCE_ORDERS);
  const visible = await reader.listVisibleBranches(ctx.scope.organizationId, ctx.scope.allowedPropertyIds);
  const b = resolveBranchSelection(visible, ctx.scope.allowedPropertyIds, args["sucursal"] as string | undefined);
  if (!b.ok) return failure("needs_clarification", b.message, SOURCE_ORDERS);
  return {
    period: p.period,
    scopeLabel: b.label,
    window: {
      organizationId: ctx.scope.organizationId,
      propertyIds: b.propertyIds,
      start: p.period.start,
      end: p.period.end,
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
  reader: RestaurantesDataChatReader,
  def: { name: string; label: string; description: string; extraParams?: ParamsSpec },
  run: (w: Prepared, args: ParsedArgs, ctx: DataChatToolContext) => Promise<DataChatToolResult>,
): DataChatTool {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    params: { ...WINDOW_PARAMS, ...def.extraParams },
    async run(ctx, args) {
      try {
        const prepared = await prepare(reader, ctx, args);
        if (isResult(prepared)) return prepared;
        return await run(prepared, args, ctx);
      } catch (err) {
        if (err instanceof DataChatUnavailableError) return failure("unavailable", UNAVAILABLE_MESSAGE, SOURCE_ORDERS);
        throw err;
      }
    },
  };
}

function base(p: Prepared, source: string): Pick<DataChatToolResult, "source" | "periodLabel" | "scopeLabel"> {
  return { source, periodLabel: p.period.label, scopeLabel: p.scopeLabel };
}

/** `bogo` (2x1) guarda value = 1: se muestra "2x1", nunca "$1.00 MXN". */
function formatPromotionValue(type: string, value: number): string {
  if (type === "bogo") return "2x1";
  return type === "percentage" ? `${value}%` : formatMxn(value);
}

const pct = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

function pickGranularity(period: ResolvedPeriod): SalesGranularity {
  const days = Math.round((period.end.getTime() - period.start.getTime()) / 86_400_000);
  return days <= 50 ? "day" : days <= 300 ? "week" : "month";
}

const CHANNEL_LABELS: Readonly<Record<string, string>> = { web: "Web", voice: "Llamada (voz)", whatsapp: "WhatsApp", admin: "Captura en panel" };

const COLS = {
  day: { key: "periodo", label: "Día", kind: "text" },
  week: { key: "periodo", label: "Semana (inicia lunes)", kind: "text" },
  month: { key: "periodo", label: "Mes (inicio)", kind: "text" },
} as const satisfies Record<SalesGranularity, DataChatColumn>;

export function buildRestaurantesDataChatTools(reader: RestaurantesDataChatReader): readonly DataChatTool[] {
  const ventasPorDia = windowTool(
    reader,
    {
      name: "ventas_por_dia",
      label: "Ventas por día",
      description: "Ventas totales (MXN) y número de pedidos por día en un periodo; agrupa por semana o mes automáticamente si el periodo es largo. Úsala también para 'cuánto vendí' en un periodo.",
    },
    async (p) => {
      const unit = pickGranularity(p.period);
      const rows = await reader.salesByPeriod(p.window, unit);
      const totalRevenue = roundMoney(rows.reduce((n, r) => n + r.revenue, 0));
      const totalOrders = rows.reduce((n, r) => n + r.orders, 0);
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SOURCE_ORDERS),
        columns: [COLS[unit], { key: "ventas", label: "Ventas", kind: "mxn" }, { key: "pedidos", label: "Pedidos", kind: "integer" }],
        rows: rows.map((r) => ({ periodo: r.bucket, ventas: roundMoney(r.revenue), pedidos: r.orders })),
        chart: { kind: unit === "day" ? "line" : "bar", x: "periodo", y: "ventas" },
        summary: `Ventas de ${p.period.label}: ${formatMxn(totalRevenue)} en ${totalOrders} pedidos (${p.scopeLabel}).`,
      };
    },
  );

  const ventasPorSucursal = windowTool(
    reader,
    { name: "ventas_por_sucursal", label: "Ventas por sucursal", description: "Ventas (MXN), pedidos y participación por sucursal en un periodo (solo sucursales a las que el usuario tiene acceso)." },
    async (p) => {
      const rows = await reader.salesByBranch(p.window);
      const total = rows.reduce((n, r) => n + r.revenue, 0);
      const best = rows[0];
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SOURCE_ORDERS),
        columns: [
          { key: "sucursal", label: "Sucursal", kind: "text" },
          { key: "ventas", label: "Ventas", kind: "mxn" },
          { key: "pedidos", label: "Pedidos", kind: "integer" },
          { key: "participacion", label: "Participación", kind: "percent" },
        ],
        rows: rows.map((r) => ({ sucursal: r.branch, ventas: roundMoney(r.revenue), pedidos: r.orders, participacion: pct(r.revenue, total) })),
        chart: { kind: "bar", x: "sucursal", y: "ventas" },
        summary: best ? `Sucursal con más ventas en ${p.period.label}: ${best.branch} con ${formatMxn(best.revenue)}.` : undefined,
      };
    },
  );

  const productos = windowTool(
    reader,
    {
      name: "productos_mas_vendidos",
      label: "Productos más vendidos",
      description: "Ranking de productos por cantidad vendida o por ventas (MXN) en un periodo.",
      extraParams: {
        ordenar_por: { type: "enum", values: ["cantidad", "ventas"], optional: true, description: "Criterio del ranking. Por defecto 'cantidad'." },
        limite: { type: "integer", min: 1, max: 20, optional: true, description: "Cuántos productos mostrar (1-20). Por defecto 10." },
      },
    },
    async (p, args) => {
      const by = (args["ordenar_por"] as "cantidad" | "ventas" | undefined) ?? "cantidad";
      const limit = (args["limite"] as number | undefined) ?? 10;
      const rows = (await reader.topProducts({ ...p.window, limit }, by)).slice(0, limit);
      const top = rows[0];
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, `${SOURCE_ORDERS}, desglosados por producto`),
        columns: [
          { key: "producto", label: "Producto", kind: "text" },
          { key: "cantidad", label: "Cantidad", kind: "decimal" },
          { key: "ventas", label: "Ventas", kind: "mxn" },
        ],
        rows: rows.map((r) => ({ producto: r.product, cantidad: r.quantity, ventas: roundMoney(r.revenue) })),
        chart: { kind: "bar", x: "producto", y: by === "cantidad" ? "cantidad" : "ventas" },
        summary: top ? `Producto líder por ${by} en ${p.period.label}: ${top.product}.` : undefined,
      };
    },
  );

  const ticket = windowTool(
    reader,
    { name: "ticket_medio", label: "Ticket medio", description: "Ticket medio (venta promedio por pedido, MXN), total de pedidos, ventas y pedidos cancelados en un periodo." },
    async (p) => {
      const s = await reader.orderStats(p.window);
      const avg = s.orders > 0 ? roundMoney(s.revenue / s.orders) : 0;
      return {
        status: s.orders === 0 && s.cancelled === 0 ? "empty" : "ok",
        ...base(p, `${SOURCE_ORDERS}; cancelados contados aparte`),
        columns: [
          { key: "pedidos", label: "Pedidos", kind: "integer" },
          { key: "ventas", label: "Ventas", kind: "mxn" },
          { key: "ticket_medio", label: "Ticket medio", kind: "mxn" },
          { key: "cancelados", label: "Cancelados", kind: "integer" },
        ],
        rows: [{ pedidos: s.orders, ventas: roundMoney(s.revenue), ticket_medio: avg, cancelados: s.cancelled }],
        summary: s.orders > 0 ? `Ticket medio de ${p.period.label}: ${formatMxn(avg)} sobre ${s.orders} pedidos.` : `Sin pedidos no cancelados en ${p.period.label}.`,
      };
    },
  );

  const canal = windowTool(
    reader,
    { name: "pedidos_por_canal", label: "Pedidos por canal", description: "Pedidos y ventas (MXN) por canal de origen (web, llamada de voz, WhatsApp, captura en panel) en un periodo." },
    async (p) => {
      const rows = await reader.ordersByChannel(p.window);
      const totalOrders = rows.reduce((n, r) => n + r.orders, 0);
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SOURCE_ORDERS),
        columns: [
          { key: "canal", label: "Canal", kind: "text" },
          { key: "pedidos", label: "Pedidos", kind: "integer" },
          { key: "ventas", label: "Ventas", kind: "mxn" },
          { key: "participacion", label: "Participación", kind: "percent" },
        ],
        rows: rows.map((r) => ({ canal: CHANNEL_LABELS[r.channel] ?? r.channel, pedidos: r.orders, ventas: roundMoney(r.revenue), participacion: pct(r.orders, totalOrders) })),
        chart: { kind: "bar", x: "canal", y: "pedidos" },
        summary: rows[0] ? `Canal con más pedidos en ${p.period.label}: ${CHANNEL_LABELS[rows[0].channel] ?? rows[0].channel}.` : undefined,
      };
    },
  );

  const horas = windowTool(
    reader,
    {
      name: "horas_pico",
      label: "Horas pico",
      description: "Horas del día (zona horaria del negocio) con más pedidos en un periodo.",
      extraParams: { limite: { type: "integer", min: 1, max: 24, optional: true, description: "Cuántas horas mostrar (1-24). Por defecto 5." } },
    },
    async (p, args) => {
      const limit = (args["limite"] as number | undefined) ?? 5;
      const rows = (await reader.peakHours({ ...p.window, limit })).slice(0, limit);
      const top = rows[0];
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, `${SOURCE_ORDERS}, hora local del negocio`),
        columns: [
          { key: "hora", label: "Hora", kind: "text" },
          { key: "pedidos", label: "Pedidos", kind: "integer" },
          { key: "ventas", label: "Ventas", kind: "mxn" },
        ],
        rows: rows.map((r) => ({ hora: `${String(r.hour).padStart(2, "0")}:00`, pedidos: r.orders, ventas: roundMoney(r.revenue) })),
        chart: { kind: "bar", x: "hora", y: "pedidos" },
        summary: top ? `Hora pico de ${p.period.label}: ${String(top.hour).padStart(2, "0")}:00 con ${top.orders} pedidos.` : undefined,
      };
    },
  );

  const recurrentes = windowTool(
    reader,
    {
      name: "clientes_recurrentes",
      label: "Clientes recurrentes",
      description: "Cuántos clientes distintos pidieron en el periodo y cuántos son recurrentes (ya habían pedido antes o pidieron 2+ veces). Solo conteos, nunca datos personales.",
    },
    async (p) => {
      const r = await reader.recurringCustomers(p.window);
      return {
        status: r.customers === 0 ? "empty" : "ok",
        ...base(p, "Pedidos de restaurantes (sin cancelados, no recogidos ni programados); cliente = por identificador o teléfono, sin mostrar datos personales"),
        columns: [
          { key: "clientes", label: "Clientes", kind: "integer" },
          { key: "recurrentes", label: "Recurrentes", kind: "integer" },
          { key: "nuevos", label: "Nuevos", kind: "integer" },
          { key: "pct_recurrentes", label: "% recurrentes", kind: "percent" },
        ],
        rows: [{ clientes: r.customers, recurrentes: r.recurring, nuevos: r.newCustomers, pct_recurrentes: pct(r.recurring, r.customers) }],
        summary: `En ${p.period.label}: ${r.customers} clientes, ${r.recurring} recurrentes (${pct(r.recurring, r.customers)}%).`,
      };
    },
  );

  const promociones: DataChatTool = {
    name: "promociones",
    label: "Promociones",
    description: "Promociones y códigos de descuento configurados: tipo, valor, si están activas y cuántas veces se han usado (no depende de un periodo).",
    params: {},
    async run(ctx) {
      try {
        const rows = await reader.promotions(ctx.scope.organizationId, ctx.maxRows + 1);
        return {
          status: rows.length === 0 ? "empty" : "ok",
          source: "Promociones configuradas de la organización",
          scopeLabel: "toda la organización",
          columns: [
            { key: "codigo", label: "Código", kind: "text" },
            { key: "nombre", label: "Nombre", kind: "text" },
            { key: "valor", label: "Descuento", kind: "text" },
            { key: "activa", label: "Activa", kind: "text" },
            { key: "usos", label: "Usos", kind: "integer" },
          ],
          rows: rows.map((r) => ({ codigo: r.code, nombre: r.name, valor: formatPromotionValue(r.type, r.value), activa: r.isActive ? "Sí" : "No", usos: r.timesUsed })),
          summary: `Promociones configuradas: ${rows.filter((r) => r.isActive).length} activas de ${rows.length}.`,
        };
      } catch (err) {
        if (err instanceof DataChatUnavailableError) return failure("unavailable", UNAVAILABLE_MESSAGE, "Promociones configuradas de la organización");
        throw err;
      }
    },
  };

  return [ventasPorDia, ventasPorSucursal, productos, ticket, canal, horas, recurrentes, promociones, ...buildCfoDataChatTools(reader)];
}

export function buildRestaurantesDataChatCatalog(reader: RestaurantesDataChatReader): DataChatCatalog {
  return {
    vertical: "restaurantes",
    domain: "un restaurante con una o varias sucursales (pedidos por web, llamada de voz y WhatsApp)",
    tools: buildRestaurantesDataChatTools(reader),
    async describeScope(scope) {
      const visible = await reader.listVisibleBranches(scope.organizationId, scope.allowedPropertyIds);
      if (visible.length === 0) return "No tiene sucursales activas asignadas.";
      return `Sucursales que puede consultar (${visible.length}): ${visible.map((b) => b.name).join(", ")}. Si pide una sucursal, usa su nombre en el parámetro "sucursal".`;
    },
  };
}
