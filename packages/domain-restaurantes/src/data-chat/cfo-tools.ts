// CFO-09 · herramientas CFO del Copiloto de restaurantes («Pregunta a tu CFO»). Nueve herramientas de SOLO LECTURA que delegan en el
// `ServicioCfo` de CFO-05 a traves del lector (`reader.cfo`): no hay SQL ni formulas propias aqui, solo el mapeo de cada vista del servicio a
// `columns/rows/chart/summary/source`.
//
// Reglas (diseño §4.4 y §4.5):
//  - `sucursal` opcional con el mismo `resolveBranchSelection` del catalogo: omitida = todas las permitidas; una sucursal fuera del alcance responde
//    IGUAL que una inexistente. La fila «No asignado» solo existe con alcance de organizacion completa y sin elegir sucursal (lo decide el servicio).
//  - Las cifras salen de las vistas del servicio (montos en pesos = centavos / 100, en celdas NUMERICAS: asi la guardia de numeros del motor las
//    reconoce). `valor: null` del servicio se queda en `null` («—»): nunca 0. El resumen narrado viene de `narrativa.ts` (CFO-04, plantilla
//    determinista con su propia guardia de numeros).
//  - Sin PII: solo alias, nombres de sucursal/producto y cifras agregadas.
//  - NO sustituye al contador: el aviso viaja en la `source` de cada respuesta.
//  - Base sin migrar: `disponible: false` del servicio (o `DataChatUnavailableError` del lector) => status `unavailable` honesto.
import {
  PERIOD_PARAMS,
  formatMxn,
  resolvePeriod,
  roundMoney,
  type DataChatColumn,
  type DataChatTool,
  type DataChatToolContext,
  type DataChatToolResult,
  type ParamsSpec,
  type ParsedArgs,
  type ResolvedPeriod,
} from "@atiende/agent-core/data-chat";
import { CfoParametroInvalidoError, CfoSinAccesoError } from "../cfo/repositorio.ts";
import type { ServicioCfo, ConsultaCfo } from "../cfo/servicio.ts";
import { formatoEntero } from "../cfo/util.ts";
import { AVISO_CFO } from "../cfo/estado-resultados.ts";
import type { AlcanceSucursales, Cifra } from "../cfo/tipos.ts";
import type { ClientesColumna, SucursalApi, VistaCfoBase } from "../cfo/tipos-api.ts";
import { resolveBranchSelection } from "./catalog.ts";
import { DataChatUnavailableError, type RestaurantesDataChatReader } from "./reader.ts";

const UNAVAILABLE_MESSAGE = "Esa información todavía no está disponible para tu cuenta (falta activar una actualización). Tus tableros siguen funcionando.";
/** Recordatorio corto (el aviso legal completo es `AVISO_CFO`): el copiloto organiza datos operativos, no sustituye al contador. */
export const AVISO_CONTADOR_COPILOTO = "Organiza tus datos operativos; no sustituye a tu contador ni da asesoría fiscal.";
const RUTA_CAPTURA = "CFO > Costos (captura de nómina, renta, insumos)";

const BRANCH_PARAM: ParamsSpec = {
  sucursal: {
    type: "string",
    maxLength: 60,
    optional: true,
    description: "Nombre de UNA sucursal (opcional). Omítelo para consultar todas las sucursales a las que tiene acceso el usuario. No inventes nombres.",
  },
};
const WINDOW_PARAMS: ParamsSpec = { ...PERIOD_PARAMS, ...BRANCH_PARAM };

const pesos = (centavos: number | null | undefined): number | null => (centavos == null ? null : roundMoney(centavos / 100));
const valor = (c: Cifra | null | undefined): number | null => c?.valor ?? null;
const pesosDe = (c: Cifra | null | undefined): number | null => pesos(valor(c));

function failure(status: DataChatToolResult["status"], message: string, source: string): DataChatToolResult {
  return { status, message, source, scopeLabel: "", columns: [], rows: [] };
}

function fuenteDe(v: Pick<VistaCfoBase, "fuentes" | "avisos">, extra?: string): string {
  const usadas = v.fuentes.filter((f) => f.disponible).map((f) => `${f.nombre} (${f.confianza})`);
  const base = usadas.length > 0 ? `CFO: ${usadas.join("; ")}` : "CFO: sin fuentes disponibles en este periodo";
  const avisos = v.avisos.length > 0 ? ` Avisos: ${v.avisos.slice(0, 3).join(" ")}` : "";
  return `${base}.${avisos}${extra ? ` ${extra}` : ""} ${AVISO_CONTADOR_COPILOTO}`;
}

function granularidad(period: ResolvedPeriod): ConsultaCfo["granularidad"] {
  const dias = Math.round((period.end.getTime() - period.start.getTime()) / 86_400_000);
  return dias <= 31 ? "dia" : dias <= 180 ? "semana" : "mes";
}

interface Preparado {
  readonly servicio: ServicioCfo;
  readonly q: ConsultaCfo;
  readonly period: ResolvedPeriod;
  readonly scopeLabel: string;
  readonly alcance: AlcanceSucursales;
}

async function preparar(reader: RestaurantesDataChatReader, ctx: DataChatToolContext, args: ParsedArgs): Promise<Preparado | DataChatToolResult> {
  if (!reader.cfo) return failure("unavailable", UNAVAILABLE_MESSAGE, "CFO");
  const p = resolvePeriod(args, ctx.now, ctx.scope.timezone);
  if (!p.ok) return failure(p.kind === "needs_clarification" ? "needs_clarification" : "error", p.message, "CFO");
  const visible = await reader.listVisibleBranches(ctx.scope.organizationId, ctx.scope.allowedPropertyIds);
  const b = resolveBranchSelection(visible, ctx.scope.allowedPropertyIds, args["sucursal"] as string | undefined);
  if (!b.ok) return failure("needs_clarification", b.message, "CFO");
  const elegida = args["sucursal"] !== undefined && args["sucursal"] !== "";
  const elegidas = elegida ? visible.filter((v) => b.propertyIds?.includes(v.propertyId)) : visible;
  if (elegidas.length === 0) return { status: "empty", message: "No tienes sucursales activas asignadas para consultar el CFO.", source: "CFO", scopeLabel: b.label, columns: [], rows: [] };
  const organizacionCompleta = ctx.scope.allowedPropertyIds === null;
  const sucursales: SucursalApi[] = elegidas.map((v) => ({ propertyId: v.propertyId, nombre: v.name, slug: v.slug }));
  const alcance: AlcanceSucursales = { propertyIds: sucursales.map((s) => s.propertyId), todas: !elegida, organizacionCompleta };
  // Org completa sin elegir sucursal: null deja que la SQL incluya «No asignado». Acotado o una sola sucursal: su lista explicita (la base la valida de nuevo).
  const propertyIdsSql = elegida || !organizacionCompleta ? alcance.propertyIds : null;
  const servicio = await reader.cfo({ organizationId: ctx.scope.organizationId, alcance, propertyIdsSql, sucursales, ahora: ctx.now });
  return { servicio, q: { desde: p.period.fromDate, hasta: p.period.toDate, comparar: "periodo_anterior", granularidad: granularidad(p.period) }, period: p.period, scopeLabel: b.label, alcance };
}

function esResultado(v: Preparado | DataChatToolResult): v is DataChatToolResult {
  return (v as DataChatToolResult).status !== undefined;
}

function cfoTool(
  reader: RestaurantesDataChatReader,
  def: { name: string; label: string; description: string; extraParams?: ParamsSpec },
  run: (p: Preparado, args: ParsedArgs, ctx: DataChatToolContext) => Promise<DataChatToolResult>,
): DataChatTool {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    params: { ...WINDOW_PARAMS, ...def.extraParams },
    async run(ctx, args) {
      try {
        const prep = await preparar(reader, ctx, args);
        if (esResultado(prep)) return prep;
        const r = await run(prep, args, ctx);
        return r.scopeLabel === "" ? { ...r, scopeLabel: prep.scopeLabel, periodLabel: r.periodLabel ?? prep.period.label } : r;
      } catch (err) {
        if (err instanceof DataChatUnavailableError) return failure("unavailable", UNAVAILABLE_MESSAGE, "CFO");
        if (err instanceof CfoSinAccesoError) return failure("needs_clarification", "No encontré esa sucursal entre las que puedes consultar.", "CFO");
        if (err instanceof CfoParametroInvalidoError) return failure("error", "No pude consultar ese periodo del CFO. Prueba con un rango más corto.", "CFO");
        throw err;
      }
    },
  };
}

function base(p: Preparado, source: string): Pick<DataChatToolResult, "source" | "periodLabel" | "scopeLabel"> {
  return { source, periodLabel: p.period.label, scopeLabel: p.scopeLabel };
}

function sinBloque(p: Preparado, v: Pick<VistaCfoBase, "bloques" | "fuentes" | "avisos">, bloques: ReadonlyArray<keyof VistaCfoBase["bloques"]>): DataChatToolResult | null {
  if (bloques.every((b) => v.bloques[b])) return null;
  return { ...failure("unavailable", UNAVAILABLE_MESSAGE, fuenteDe(v)), scopeLabel: p.scopeLabel, periodLabel: p.period.label };
}

const REFERENCIA_RE = /\s?\[[a-z0-9_]+\]/g;
const quitarReferencias = (t: string): string => t.replace(REFERENCIA_RE, "");
const mxn = (centavos: number): string => formatMxn(centavos / 100);

const URGENCIAS: Readonly<Record<string, string>> = { alta: "Alta", media: "Media", baja: "Baja" };

export function buildCfoDataChatTools(reader: RestaurantesDataChatReader): readonly DataChatTool[] {
  // ---- cfo_resumen --------------------------------------------------------------------------------------------------------------------------
  const resumen = cfoTool(
    reader,
    {
      name: "cfo_resumen",
      label: "CFO: resumen del periodo",
      description: "KPIs clave del CFO (ventas netas, pedidos, ticket) con su variación contra el periodo anterior, y un resumen narrado. Úsala para 'cuánto vendió X ayer/esta semana', 'cómo voy' o 'dame un resumen'.",
    },
    async (p) => {
      const v = await p.servicio.resumen(p.q);
      const no = sinBloque(p, v, ["ventas"]);
      if (no) return no;
      const k = (id: string) => v.kpis.total.kpis.find((x) => x.id === id);
      const ventas = k("ventas_netas");
      const variacion = ventas?.variacion.tipo === "pct" ? ventas.variacion.valor : null;
      const columns: DataChatColumn[] = [
        { key: "ventas", label: "Ventas netas", kind: "mxn" },
        { key: "pedidos", label: "Pedidos", kind: "integer" },
        { key: "ticket", label: "Ticket medio", kind: "mxn" },
        { key: "variacion_ventas", label: "Variación vs periodo anterior", kind: "percent" },
      ];
      return {
        status: v.narrativa.sinDatos ? "empty" : "ok",
        ...base(p, fuenteDe(v)),
        columns,
        rows: [{ ventas: pesosDe(ventas?.valor), pedidos: valor(k("pedidos")?.valor), ticket: pesosDe(k("ticket")?.valor), variacion_ventas: variacion }],
        chart: { kind: "kpi", x: "ventas", y: "ventas" },
        summary: quitarReferencias(v.narrativa.texto),
      };
    },
  );

  // ---- cfo_lo_mas_importante -----------------------------------------------------------------------------------------------------------------
  const importante = cfoTool(
    reader,
    {
      name: "cfo_lo_mas_importante",
      label: "CFO: lo más importante",
      description: "Hallazgos ordenados por impacto en pesos o por urgencia, cada uno con su cifra y la acción sugerida (caída de ventas, descuentos, cancelaciones, entregas lentas, etc.). Úsala para '¿qué es lo más importante?'.",
      extraParams: { orden: { type: "enum", values: ["impacto", "urgencia"], optional: true, description: "Criterio de orden. Por defecto 'impacto'." } },
    },
    async (p, args) => {
      const v = await p.servicio.resumen(p.q, (args["orden"] as "impacto" | "urgencia" | undefined) ?? "impacto");
      const no = sinBloque(p, v, ["ventas"]);
      if (no) return no;
      const rows = v.hallazgos.slice(0, 10).map((h) => ({
        hallazgo: h.titulo,
        sucursal: h.sucursal,
        cifra: h.cifraTexto,
        impacto: pesos(h.impactoCentavos),
        urgencia: URGENCIAS[h.urgencia] ?? h.urgencia,
        accion: h.accion.texto,
      }));
      const mayor = v.hallazgos.find((h) => h.impactoCentavos != null);
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, fuenteDe(v)),
        columns: [
          { key: "hallazgo", label: "Hallazgo", kind: "text" },
          { key: "sucursal", label: "Sucursal", kind: "text" },
          { key: "cifra", label: "Cifra", kind: "text" },
          { key: "impacto", label: "Impacto estimado", kind: "mxn" },
          { key: "urgencia", label: "Urgencia", kind: "text" },
          { key: "accion", label: "Acción sugerida", kind: "text" },
        ],
        rows,
        chart: { kind: "bar", x: "hallazgo", y: "impacto" },
        summary:
          rows.length === 0
            ? `Sin hallazgos que atender en ${p.period.label}.`
            : `${rows.length} hallazgo(s) en ${p.period.label}${mayor ? `; el de mayor impacto: ${mayor.titulo} (${mxn(mayor.impactoCentavos as number)})` : ""}.`,
      };
    },
  );

  // ---- cfo_estado_resultados ------------------------------------------------------------------------------------------------------------------
  const estado = cfoTool(
    reader,
    {
      name: "cfo_estado_resultados",
      label: "CFO: estado de resultados",
      description: "Estado de resultados operativo (P&L) por sucursal y total: ventas, costo de ventas, costo del agente, nómina, renta y EBITDA operativo. Las líneas que el dueño aún no captura salen como 'captura pendiente' (nunca 0). Úsala para food cost, nómina, utilidad o 'cómo va mi estado de resultados'.",
    },
    async (p) => {
      const v = await p.servicio.estadoResultados(p.q);
      const no = sinBloque(p, v, ["ventas"]);
      if (no) return no;
      const todas = v.estadoResultados.acumulado.columnas;
      // Tope de columnas de la tabla: el Total NUNCA se recorta (si hay muchas sucursales se omiten las ultimas).
      const columnas = todas.length > 9 ? [...todas.filter((c) => c.clave !== "total").slice(0, 8), ...todas.filter((c) => c.clave === "total")] : todas;
      const total = columnas.find((c) => c.clave === "total") ?? columnas[columnas.length - 1];
      if (!total) return { status: "empty", ...base(p, fuenteDe(v)), columns: [], rows: [] };
      const cols: DataChatColumn[] = [{ key: "linea", label: "Concepto", kind: "text" }, ...columnas.map((c, i) => ({ key: `c${i}`, label: c.nombre, kind: "mxn" as const }))];
      const rows = total.lineas.map((l) => {
        const etiqueta = `${l.etiqueta}${l.faltaCaptura ? " (captura pendiente)" : ""}${l.estimadoPorProrrateo ? " (estimado)" : ""}`;
        const fila: Record<string, string | number | null> = { linea: etiqueta };
        columnas.forEach((c, i) => {
          const m = c.lineas.find((x) => x.id === l.id);
          fila[`c${i}`] = pesosDe(m?.cifra);
        });
        return fila;
      });
      const pendientes = total.lineas.filter((l) => l.faltaCaptura).map((l) => l.etiqueta);
      const ventasNetas = total.lineas.find((l) => l.id === "ventas_netas");
      const ebitda = total.ebitda.valor;
      const partes = [
        ventasNetas?.cifra.valor != null ? `Ventas netas de ${p.period.label}: ${mxn(ventasNetas.cifra.valor)}.` : `Sin ventas registradas en ${p.period.label}.`,
        ebitda != null ? `EBITDA operativo: ${mxn(ebitda)}.` : `EBITDA operativo incompleto${total.incompleto.length > 0 ? ` (faltan ${total.incompleto.length} línea(s) de captura)` : ""}.`,
        pendientes.length > 0 ? `Captura pendiente: ${pendientes.join(", ")}. Regístrela en ${RUTA_CAPTURA}.` : "",
      ].filter(Boolean);
      return {
        status: ventasNetas?.cifra.valor == null && rows.every((r) => Object.entries(r).every(([k, x]) => k === "linea" || x == null)) ? "empty" : "ok",
        ...base(p, fuenteDe(v, `Estado de resultados operativo, no contable. ${AVISO_CFO}`)),
        columns: cols,
        rows,
        summary: partes.join(" "),
      };
    },
  );

  // ---- cfo_comparar_sucursales -----------------------------------------------------------------------------------------------------------------
  const comparar = cfoTool(
    reader,
    {
      name: "cfo_comparar_sucursales",
      label: "CFO: comparar sucursales",
      description: "Compara las sucursales lado a lado (ventas, pedidos, participación, ticket, descuento, cancelación), con ranking y las que se salen de lo común. Úsala para 'compara mis sucursales' o '¿qué sucursal vende menos?'.",
    },
    async (p) => {
      const v = await p.servicio.sucursalesVista(p.q);
      const no = sinBloque(p, v, ["ventas"]);
      if (no) return no;
      const n = v.tabla.length;
      const promedio = n > 0 ? v.tabla.reduce((s, f) => s + f.netaCentavos, 0) / n : 0;
      const rows = v.tabla.map((f) => ({
        sucursal: f.nombre,
        ventas: pesos(f.netaCentavos),
        pedidos: f.pedidos,
        participacion: valor(f.participacionPct),
        ticket: pesosDe(f.ticket),
        descuento_pct: valor(f.descuentoPct),
        cancelacion_pct: valor(f.cancelacionPct),
        vs_promedio_pct: promedio > 0 ? Math.round(((f.netaCentavos - promedio) / promedio) * 1000) / 10 : null,
      }));
      const primero = v.ranking[0];
      const ultimo = v.ranking[v.ranking.length - 1];
      const nombresFuera = [...new Set(v.outliers.map((o) => o.nombre))];
      const partes = [
        primero ? `Mayor venta en ${p.period.label}: ${primero.nombre} con ${mxn(primero.netaCentavos)}.` : "",
        ultimo && v.ranking.length > 1 ? `Menor venta: ${ultimo.nombre} con ${mxn(ultimo.netaCentavos)}.` : "",
        nombresFuera.length > 0 ? `Fuera de lo común: ${nombresFuera.join(", ")}.` : "",
      ].filter(Boolean);
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, fuenteDe(v)),
        columns: [
          { key: "sucursal", label: "Sucursal", kind: "text" },
          { key: "ventas", label: "Ventas netas", kind: "mxn" },
          { key: "pedidos", label: "Pedidos", kind: "integer" },
          { key: "participacion", label: "Participación", kind: "percent" },
          { key: "ticket", label: "Ticket medio", kind: "mxn" },
          { key: "descuento_pct", label: "Descuento", kind: "percent" },
          { key: "cancelacion_pct", label: "Cancelación", kind: "percent" },
          { key: "vs_promedio_pct", label: "Ventas vs promedio de sucursales", kind: "percent" },
        ],
        rows,
        chart: { kind: "bar", x: "sucursal", y: "ventas" },
        summary: partes.join(" ") || undefined,
      };
    },
  );

  // ---- cfo_clientes -----------------------------------------------------------------------------------------------------------------------------
  const clientes = cfoTool(
    reader,
    {
      name: "cfo_clientes",
      label: "CFO: clientes",
      description: "Clientes del periodo: activos, dormidos, perdidos, porcentaje de frecuentes, recompra a 30 días y concentración, por sucursal y del conjunto. Solo conteos y porcentajes, nunca datos personales. Úsala para '¿qué porcentaje de mis clientes son frecuentes?'.",
    },
    async (p) => {
      const v = await p.servicio.clientesVista(p.q);
      const no = sinBloque(p, v, ["clientes"]);
      if (no) return no;
      const fila = (nombre: string, c: ClientesColumna, recompra: number | null) => ({
        sucursal: nombre,
        activos: c.segmentos.activos,
        dormidos: c.segmentos.dormidos,
        perdidos: c.segmentos.perdidos,
        frecuentes: c.segmentos.frecuentes,
        frecuentes_pct: valor(c.segmentos.frecuentesPct),
        recompra_30d_pct: recompra,
        concentracion_pct: valor(c.concentracion),
      });
      const conjuntoCohortes = v.cohortes.filter((c) => c.propertyId === null);
      const con = conjuntoCohortes.reduce((s, c) => s + c.recompra30.con, 0);
      const obs = conjuntoCohortes.reduce((s, c) => s + c.recompra30.observables, 0);
      const recompra = obs > 0 ? Math.round((con / obs) * 1000) / 10 : null;
      const rows = [
        ...v.porSucursal.map((s) => fila(s.nombre, s, null)),
        ...(v.total ? [fila(v.porSucursal.length > 1 ? "Todas (clientes únicos)" : "Total", v.total, recompra)] : []),
      ];
      const t = v.total;
      const partes = [
        t ? `En ${p.period.label}: ${formatoEntero(t.segmentos.activos)} clientes activos; frecuentes ${valor(t.segmentos.frecuentesPct) == null ? "sin dato" : `${valor(t.segmentos.frecuentesPct)}%`}.` : "Sin conjunto de clientes en este periodo.",
        v.multiSucursal.texto ?? "",
      ].filter(Boolean);
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, fuenteDe(v, "Un cliente se cuenta una vez en el conjunto aunque compre en varias sucursales.")),
        columns: [
          { key: "sucursal", label: "Sucursal", kind: "text" },
          { key: "activos", label: "Activos", kind: "integer" },
          { key: "dormidos", label: "Dormidos", kind: "integer" },
          { key: "perdidos", label: "Perdidos", kind: "integer" },
          { key: "frecuentes", label: "Frecuentes", kind: "integer" },
          { key: "frecuentes_pct", label: "% frecuentes", kind: "percent" },
          { key: "recompra_30d_pct", label: "Recompra a 30 días", kind: "percent" },
          { key: "concentracion_pct", label: "Concentración", kind: "percent" },
        ],
        rows,
        chart: { kind: "kpi", x: "frecuentes_pct", y: "frecuentes_pct" },
        summary: partes.join(" "),
      };
    },
  );

  // ---- cfo_platillos -----------------------------------------------------------------------------------------------------------------------------
  const platillos = cfoTool(
    reader,
    {
      name: "cfo_platillos",
      label: "CFO: platillos",
      description: "Platillos: los más o menos vendidos por unidades o por ingreso, mezcla por categoría o pares de productos que se piden juntos (canasta).",
      extraParams: {
        vista: { type: "enum", values: ["mas_vendidos", "menos_vendidos", "categorias", "canasta"], optional: true, description: "Qué mostrar. Por defecto 'mas_vendidos'." },
        ordenar_por: { type: "enum", values: ["unidades", "ingreso"], optional: true, description: "Criterio del ranking de platillos. Por defecto 'unidades'." },
        limite: { type: "integer", min: 1, max: 20, optional: true, description: "Cuántas filas mostrar (1-20). Por defecto 10." },
      },
    },
    async (p, args) => {
      const v = await p.servicio.productosVista(p.q);
      const no = sinBloque(p, v, ["ventas"]);
      if (no) return no;
      const vista = (args["vista"] as string | undefined) ?? "mas_vendidos";
      const por = (args["ordenar_por"] as "unidades" | "ingreso" | undefined) ?? "unidades";
      const limite = (args["limite"] as number | undefined) ?? 10;
      const src = fuenteDe(v);
      if (vista === "categorias") {
        const rows = v.mixCategoria.slice(0, limite).map((c) => ({ categoria: c.categoria, unidades: c.unidades, ingreso: pesos(c.ingresoCentavos), participacion: c.participacionPct }));
        return {
          status: rows.length === 0 ? "empty" : "ok",
          ...base(p, src),
          columns: [{ key: "categoria", label: "Categoría", kind: "text" }, { key: "unidades", label: "Unidades", kind: "integer" }, { key: "ingreso", label: "Ingreso", kind: "mxn" }, { key: "participacion", label: "Participación del ingreso", kind: "percent" }],
          rows,
          chart: { kind: "bar", x: "categoria", y: "ingreso" },
          summary: rows[0] ? `Categoría con más ingreso en ${p.period.label}: ${rows[0].categoria} con ${mxn(v.mixCategoria[0]!.ingresoCentavos)}.` : undefined,
        };
      }
      if (vista === "canasta") {
        const rows = v.canasta.slice(0, limite).map((c) => ({ producto_a: c.nombreA, producto_b: c.nombreB, pedidos_juntos: c.pedidosJuntos, soporte_pct: c.soportePct, lift: c.lift }));
        return {
          status: rows.length === 0 ? "empty" : "ok",
          ...base(p, src),
          columns: [{ key: "producto_a", label: "Producto A", kind: "text" }, { key: "producto_b", label: "Producto B", kind: "text" }, { key: "pedidos_juntos", label: "Pedidos juntos", kind: "integer" }, { key: "soporte_pct", label: "% de pedidos", kind: "percent" }, { key: "lift", label: "Lift", kind: "decimal" }],
          rows,
          chart: { kind: "bar", x: "producto_a", y: "pedidos_juntos" },
          summary: rows[0] ? `Par más pedido junto en ${p.period.label}: ${rows[0].producto_a} y ${rows[0].producto_b} (${rows[0].pedidos_juntos} pedidos).` : undefined,
        };
      }
      // Ranking sobre TODA la matriz (no solo el top 10 del servicio), para poder ordenar por ingreso.
      const orden = [...v.matriz].sort((a, b) => (por === "ingreso" ? b.ingresoCentavos - a.ingresoCentavos || b.unidades - a.unidades : b.unidades - a.unidades || b.ingresoCentavos - a.ingresoCentavos));
      const lista = (vista === "menos_vendidos" ? [...orden].reverse() : orden).filter((m) => m.unidades > 0).slice(0, limite);
      const rows = lista.map((m) => ({ platillo: m.nombre, unidades: m.unidades, ingreso: pesos(m.ingresoCentavos), cuadrante: m.cuadrante }));
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, src),
        columns: [{ key: "platillo", label: "Platillo", kind: "text" }, { key: "unidades", label: "Unidades", kind: "integer" }, { key: "ingreso", label: "Ingreso", kind: "mxn" }, { key: "cuadrante", label: "Cuadrante", kind: "text" }],
        rows,
        chart: { kind: "bar", x: "platillo", y: por === "ingreso" ? "ingreso" : "unidades" },
        summary: rows[0] ? `${vista === "menos_vendidos" ? "Menos vendido" : "Más vendido"} por ${por} en ${p.period.label}: ${rows[0].platillo}.` : undefined,
      };
    },
  );

  // ---- cfo_patrones --------------------------------------------------------------------------------------------------------------------------------
  const patrones = cfoTool(
    reader,
    {
      name: "cfo_patrones",
      label: "CFO: patrones de venta",
      description: "Patrones: ventas por día de la semana, colonias con más pedidos (solo colonias con al menos 5 pedidos) o pedidos por canal y hora.",
      extraParams: {
        vista: { type: "enum", values: ["dia_semana", "colonias", "canal_hora"], optional: true, description: "Qué patrón mostrar. Por defecto 'dia_semana'." },
        limite: { type: "integer", min: 1, max: 24, optional: true, description: "Cuántas filas mostrar (1-24). Por defecto 10." },
      },
    },
    async (p, args) => {
      const v = await p.servicio.patronesVista(p.q);
      const no = sinBloque(p, v, ["ventas"]);
      if (no) return no;
      const vista = (args["vista"] as string | undefined) ?? "dia_semana";
      const limite = (args["limite"] as number | undefined) ?? 10;
      const src = fuenteDe(v);
      if (vista === "colonias") {
        const rows = v.colonias.slice(0, limite).map((c) => ({ colonia: c.colonia, pedidos: c.pedidos, ventas: pesos(c.netaCentavos), ticket: pesosDe(c.ticket), entrega_min: valor(c.entregaPromedioMin) }));
        return {
          status: rows.length === 0 ? "empty" : "ok",
          ...base(p, `${src} Solo colonias con suficientes pedidos para no identificar clientes.`),
          columns: [{ key: "colonia", label: "Colonia", kind: "text" }, { key: "pedidos", label: "Pedidos", kind: "integer" }, { key: "ventas", label: "Ventas netas", kind: "mxn" }, { key: "ticket", label: "Ticket medio", kind: "mxn" }, { key: "entrega_min", label: "Entrega promedio (min)", kind: "decimal" }],
          rows,
          chart: { kind: "bar", x: "colonia", y: "pedidos" },
          summary: rows[0] ? `Colonia con más pedidos en ${p.period.label}: ${rows[0].colonia} (${rows[0].pedidos} pedidos).` : undefined,
        };
      }
      if (vista === "canal_hora") {
        const rows = [...v.canalPorHora].sort((a, b) => b.pedidos - a.pedidos).slice(0, limite).map((c) => ({ canal: c.source, hora: `${String(c.hora).padStart(2, "0")}:00`, pedidos: c.pedidos, ventas: pesos(c.netaCentavos) }));
        return {
          status: rows.length === 0 ? "empty" : "ok",
          ...base(p, src),
          columns: [{ key: "canal", label: "Canal", kind: "text" }, { key: "hora", label: "Hora", kind: "text" }, { key: "pedidos", label: "Pedidos", kind: "integer" }, { key: "ventas", label: "Ventas netas", kind: "mxn" }],
          rows,
          chart: { kind: "bar", x: "hora", y: "pedidos" },
          summary: rows[0] ? `Combinación canal-hora con más pedidos en ${p.period.label}: ${rows[0].canal} a las ${rows[0].hora} (${rows[0].pedidos} pedidos).` : undefined,
        };
      }
      const rows = v.estacionalidadSemanal.map((d) => ({ dia: d.etiqueta, pedidos: d.pedidos, ventas: pesos(d.netaCentavos), promedio_dia: pesos(d.promedioDiaCentavos) }));
      const mejor = [...v.estacionalidadSemanal].sort((a, b) => b.netaCentavos - a.netaCentavos)[0];
      return {
        status: rows.every((r) => r.pedidos === 0) ? "empty" : "ok",
        ...base(p, src),
        columns: [{ key: "dia", label: "Día", kind: "text" }, { key: "pedidos", label: "Pedidos", kind: "integer" }, { key: "ventas", label: "Ventas netas", kind: "mxn" }, { key: "promedio_dia", label: "Promedio por día", kind: "mxn" }],
        rows,
        chart: { kind: "bar", x: "dia", y: "ventas" },
        summary: mejor && mejor.pedidos > 0 ? `Mejor día de la semana en ${p.period.label}: ${mejor.etiqueta} con ${mxn(mejor.netaCentavos)}.` : undefined,
      };
    },
  );

  // ---- cfo_agente ------------------------------------------------------------------------------------------------------------------------------------
  const agente = cfoTool(
    reader,
    {
      name: "cfo_agente",
      label: "CFO: el agente",
      description: "Desempeño del agente de WhatsApp y voz: tasa de cierre (conversaciones que terminan en pedido), costo por pedido y escalaciones a una persona. Úsala para '¿cuánto me cuesta el agente por pedido?'.",
    },
    async (p) => {
      const v = await p.servicio.operacionVista(p.q);
      const no = sinBloque(p, v, ["clientes"]);
      if (no) return no;
      const handoffs = v.escalacionesPorHora.reduce((s, e) => s + e.handoffs, 0);
      const conversaciones = v.escalacionesPorHora.reduce((s, e) => s + e.conversaciones, 0);
      const fila = (nombre: string, e: { readonly tasaCierreAgente: Cifra } | null, c: { readonly porPedido: Cifra; readonly total: Cifra } | null, esc: number | null) => ({
        sucursal: nombre,
        tasa_cierre: valor(e?.tasaCierreAgente),
        costo_por_pedido: pesosDe(c?.porPedido),
        costo_total: pesosDe(c?.total),
        escalaciones: esc,
      });
      const rows = [
        ...v.embudo.porSucursal.map((e) => fila(e.nombre, e, v.costoAgente.porSucursal.find((c) => c.propertyId === e.propertyId) ?? null, null)),
        ...(v.costoAgente.noAsignado ? [fila("No asignado", null, { porPedido: { valor: null, confianza: "sin_dato", fuente: "no_asignado" }, total: v.costoAgente.noAsignado.total }, null)] : []),
        fila(v.embudo.porSucursal.length > 1 ? "Total" : (v.embudo.porSucursal[0]?.nombre ?? "Total"), v.embudo.total, v.costoAgente.total, handoffs),
      ];
      const dedup = v.embudo.porSucursal.length <= 1 ? rows.slice(-1) : rows;
      const total = v.costoAgente.total;
      const metaNoMedida = total.meta.valor == null;
      const partes = [
        total.porPedido.valor != null ? `Costo del agente por pedido en ${p.period.label}: ${mxn(total.porPedido.valor)}.` : `Sin costo por pedido del agente en ${p.period.label}.`,
        valor(v.embudo.total.tasaCierreAgente) != null ? `Tasa de cierre: ${valor(v.embudo.total.tasaCierreAgente)}%.` : "",
        conversaciones > 0 ? `Escalaciones a una persona: ${handoffs} de ${conversaciones} conversaciones.` : "",
        metaNoMedida ? "El costo de Meta (WhatsApp) no se mide: el costo por pedido no lo incluye." : "",
      ].filter(Boolean);
      return {
        status: dedup.every((r) => r.tasa_cierre == null && r.costo_total == null) ? "empty" : "ok",
        ...base(p, fuenteDe(v)),
        columns: [
          { key: "sucursal", label: "Sucursal", kind: "text" },
          { key: "tasa_cierre", label: "Tasa de cierre", kind: "percent" },
          { key: "costo_por_pedido", label: "Costo por pedido", kind: "mxn" },
          { key: "costo_total", label: "Costo total del agente", kind: "mxn" },
          { key: "escalaciones", label: "Escalaciones a persona", kind: "integer" },
        ],
        rows: dedup,
        chart: { kind: "bar", x: "sucursal", y: "costo_por_pedido" },
        summary: partes.join(" "),
      };
    },
  );

  // ---- cfo_softrestaurant --------------------------------------------------------------------------------------------------------------------------
  const softrestaurant = cfoTool(
    reader,
    {
      name: "cfo_softrestaurant",
      label: "CFO: SoftRestaurant",
      description: "Ventas del negocio según SoftRestaurant (domicilio vs mostrador/presencial) y el cuadre contra lo que registró el agente. Si el dueño aún no importó datos de SoftRestaurant, lo dice. Úsala para '¿cuánto vendí en mostrador?'.",
    },
    async (p) => {
      const est = await p.servicio.estadoResultados(p.q);
      const no = sinBloque(p, est, ["ventas"]);
      if (no) return no;
      const total = est.estadoResultados.acumulado.columnas.find((c) => c.clave === "total");
      const titular = total?.titular;
      const src = fuenteDe(est);
      if (!titular || titular.origen !== "softrestaurant" || !titular.desglose) {
        const msg = `Todavía no hay ventas importadas de SoftRestaurant en ${p.period.label}, así que no puedo separar mostrador y domicilio. Cuando importe sus reportes en CFO > SoftRestaurant lo verá aquí.`;
        return { status: "empty", message: msg, ...base(p, src), columns: [], rows: [], summary: msg };
      }
      const d = titular.desglose;
      const rows = [
        { concepto: "Domicilio (SoftRestaurant)", ventas: pesos(d.domicilioSR) },
        { concepto: "Presencial (comedor, para llevar y rápido)", ventas: pesos(d.presencial) },
        { concepto: "Comedor", ventas: pesos(d.comedor) },
        { concepto: "Para llevar", ventas: pesos(d.paraLlevar) },
        { concepto: "Rápido", ventas: pesos(d.rapido) },
        { concepto: "Otro", ventas: pesos(d.otro) },
      ];
      const cuadre = await p.servicio.cuadreSr(p.q);
      const rojos = cuadre.porSucursal.filter((s) => s.semaforo === "rojo").map((s) => s.nombre);
      return {
        status: "ok",
        ...base(p, src),
        columns: [{ key: "concepto", label: "Concepto", kind: "text" }, { key: "ventas", label: "Ventas", kind: "mxn" }],
        rows,
        chart: { kind: "bar", x: "concepto", y: "ventas" },
        summary: `Ventas presenciales en ${p.period.label}: ${mxn(d.presencial)}; domicilio según SoftRestaurant: ${mxn(d.domicilioSR)}.${rojos.length > 0 ? ` Cuadre con diferencia relevante en: ${rojos.join(", ")}.` : ""}`,
      };
    },
  );

  return [resumen, importante, estado, comparar, clientes, platillos, patrones, agente, softrestaurant];
}
