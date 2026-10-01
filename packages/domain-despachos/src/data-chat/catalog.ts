// Catalogo CERRADO de "Chatea con tus datos" para DESPACHOS contables (SAT/CFDI/cobranza). Ocho
// herramientas de solo lectura con parametros tipados (periodo, cliente por NOMBRE, nada mas) y alcance
// fijado por el servidor. Para agregar otra vertical: ver docs/DATA-CHAT.md.
//
// Lo que el modelo de datos NO tiene (y por tanto el chat lo dice en vez de inventarlo):
//  - CFDI EMITIDOS por el contribuyente (IVA trasladado, ingresos): `despachos.invoice` guarda los CFDI
//    que se INGIEREN (recibidos de proveedores y nomina); el IVA que se muestra es acreditable.
//  - Responsable (contador) por revision/tarea/vencimiento: la carga de trabajo es POR CLIENTE.
import {
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
import { DataChatUnavailableError, type DespachosDataChatReader, type DespachosDataChatWindow, type VisibleClient } from "./reader.ts";

const UNAVAILABLE_MESSAGE = "Esa información todavía no está disponible para tu cuenta (falta activar una actualización). Tus tableros siguen funcionando.";

const CLIENT_PARAM: ParamsSpec = {
  cliente: {
    type: "string",
    maxLength: 80,
    optional: true,
    description: "Nombre de UN cliente (contribuyente) del despacho (opcional). Omítelo para consultar todos los clientes a los que tiene acceso el usuario. No inventes nombres.",
  },
};
const PERIOD_AND_CLIENT: ParamsSpec = { ...PERIOD_PARAMS, ...CLIENT_PARAM };

const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

type ClientResolution =
  | { readonly ok: true; readonly propertyIds: readonly string[] | null; readonly clients: readonly VisibleClient[]; readonly label: string }
  | { readonly ok: false; readonly message: string };

/** Resuelve `cliente` SOLO entre los clientes que el usuario puede ver. Un nombre fuera de ese conjunto
 * responde igual que uno inexistente: nunca confirma que exista un cliente ajeno. */
export function resolveClientSelection(visible: readonly VisibleClient[], allowed: readonly string[] | null, requested: string | undefined): ClientResolution {
  if (requested === undefined || requested === "") {
    if (allowed === null) return { ok: true, propertyIds: null, clients: visible, label: "todos tus clientes" };
    const n = visible.length;
    return { ok: true, propertyIds: allowed, clients: visible, label: n === 1 ? `cliente ${visible[0]!.name}` : `tus ${n} clientes asignados` };
  }
  const needle = fold(requested);
  const exact = visible.filter((c) => fold(c.name) === needle);
  const matches = exact.length > 0 ? exact : visible.filter((c) => fold(c.name).includes(needle));
  if (matches.length === 1) return { ok: true, propertyIds: [matches[0]!.propertyId], clients: matches, label: `cliente ${matches[0]!.name}` };
  const names = visible
    .slice(0, 15)
    .map((c) => c.name)
    .join(", ");
  if (matches.length > 1) return { ok: false, message: `Hay varios clientes que coinciden con "${requested}": ${matches.map((c) => c.name).join(", ")}. ¿Cuál quieres?` };
  return { ok: false, message: `No encontré ese cliente entre los que puedes consultar${names ? `: ${names}${visible.length > 15 ? " y más" : ""}` : ""}.` };
}

function failure(status: DataChatToolResult["status"], message: string, source: string): DataChatToolResult {
  return { status, message, source, scopeLabel: "", columns: [], rows: [] };
}

interface Prepared {
  readonly window: DespachosDataChatWindow;
  readonly clients: readonly VisibleClient[];
  readonly periodLabel: string | undefined;
  readonly scopeLabel: string;
}

function isResult(v: Prepared | DataChatToolResult): v is DataChatToolResult {
  return (v as DataChatToolResult).status !== undefined;
}

/** Prepara ventana/alcance. `withPeriod=false` (cartera, cierres, carga, 69-B): solo importa "hoy". */
async function prepare(reader: DespachosDataChatReader, ctx: DataChatToolContext, args: ParsedArgs, withPeriod: boolean, source: string): Promise<Prepared | DataChatToolResult> {
  const hoyRes = resolvePeriod({ periodo: "hoy" }, ctx.now, ctx.scope.timezone);
  if (!hoyRes.ok) return failure("error", hoyRes.message, source);
  let fromDate = hoyRes.period.fromDate;
  let toDate = hoyRes.period.toDate;
  let periodLabel: string | undefined;
  if (withPeriod) {
    const p = resolvePeriod(args, ctx.now, ctx.scope.timezone);
    if (!p.ok) return failure(p.kind === "needs_clarification" ? "needs_clarification" : "error", p.message, source);
    fromDate = p.period.fromDate;
    toDate = p.period.toDate;
    periodLabel = p.period.label;
  }
  const visible = await reader.listVisibleClients(ctx.scope.organizationId, ctx.scope.allowedPropertyIds);
  const sel = resolveClientSelection(visible, ctx.scope.allowedPropertyIds, args["cliente"] as string | undefined);
  if (!sel.ok) return failure("needs_clarification", sel.message, source);
  return {
    clients: sel.clients,
    periodLabel,
    scopeLabel: sel.label,
    window: { organizationId: ctx.scope.organizationId, propertyIds: sel.propertyIds, fromDate, toDate, hoy: hoyRes.period.fromDate, limit: ctx.maxRows + 1 },
  };
}

function tool(
  reader: DespachosDataChatReader,
  def: { name: string; label: string; description: string; source: string; withPeriod: boolean; extraParams?: ParamsSpec },
  run: (p: Prepared, args: ParsedArgs) => Promise<DataChatToolResult>,
): DataChatTool {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    params: { ...(def.withPeriod ? PERIOD_AND_CLIENT : CLIENT_PARAM), ...def.extraParams },
    async run(ctx, args) {
      try {
        const prepared = await prepare(reader, ctx, args, def.withPeriod, def.source);
        if (isResult(prepared)) return prepared;
        return await run(prepared, args);
      } catch (err) {
        if (err instanceof DataChatUnavailableError) return failure("unavailable", UNAVAILABLE_MESSAGE, def.source);
        throw err;
      }
    },
  };
}

const base = (p: Prepared, source: string): Pick<DataChatToolResult, "source" | "periodLabel" | "scopeLabel"> => ({ source, periodLabel: p.periodLabel, scopeLabel: p.scopeLabel });

const TIPO_CFDI: Readonly<Record<string, string>> = {
  I: "Ingreso (I)",
  E: "Egreso / nota de crédito (E)",
  T: "Traslado (T)",
  P: "Complemento de pago (P)",
  N: "Nómina (N)",
};
const MESES_LARGO = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const ESTADO_CIERRE: Readonly<Record<string, string>> = { open: "Abierto", overdue: "Vencido", closed: "Cerrado" };
const ESTADO_VENCIMIENTO: Readonly<Record<string, string>> = { pendiente: "Pendiente", en_proceso: "En proceso", completado: "Completado", vencido: "Vencido", escalado: "Escalado" };
const NOTA_SIN_EMITIDOS = "El sistema guarda los CFDI que se ingieren al despacho (recibidos de proveedores y nómina); no guarda los CFDI emitidos por el cliente.";

export function buildDespachosDataChatTools(reader: DespachosDataChatReader): readonly DataChatTool[] {
  const SRC_COBRANZA = "Cuentas por cobrar de CFDI en seguimiento de cobranza, sin pagar (monto = total del CFDI)";

  const cartera = tool(
    reader,
    {
      name: "cartera_por_cliente",
      label: "Cartera por cliente",
      description: "Cuentas por cobrar pendientes (MXN) por cliente del despacho: número de cuentas, monto pendiente y cuánto de eso ya está vencido a hoy.",
      source: SRC_COBRANZA,
      withPeriod: false,
    },
    async (p) => {
      const rows = await reader.carteraPorCliente(p.window);
      const totalPendiente = roundMoney(rows.reduce((n, r) => n + r.montoPendiente, 0));
      const totalVencido = roundMoney(rows.reduce((n, r) => n + r.montoVencido, 0));
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SRC_COBRANZA),
        columns: [
          { key: "cliente", label: "Cliente", kind: "text" },
          { key: "cuentas", label: "Cuentas pendientes", kind: "integer" },
          { key: "pendiente", label: "Monto pendiente", kind: "mxn" },
          { key: "vencidas", label: "Cuentas vencidas", kind: "integer" },
          { key: "vencido", label: "Monto vencido", kind: "mxn" },
        ],
        rows: rows.map((r) => ({ cliente: r.cliente, cuentas: r.cuentasPendientes, pendiente: roundMoney(r.montoPendiente), vencidas: r.cuentasVencidas, vencido: roundMoney(r.montoVencido) })),
        chart: { kind: "bar", x: "cliente", y: "pendiente" },
        summary: rows.length > 0 ? `Cartera pendiente a hoy (${p.window.hoy}): ${formatMxn(totalPendiente)}, de los cuales ${formatMxn(totalVencido)} están vencidos (${p.scopeLabel}).` : `Sin cuentas por cobrar pendientes (${p.scopeLabel}).`,
      };
    },
  );

  const antiguedad = tool(
    reader,
    {
      name: "cobranza_antiguedad",
      label: "Cobranza vencida y antigüedad",
      description: "Antigüedad de saldos de la cobranza pendiente: cuentas y monto (MXN) vigentes y vencidas de 1-30, 31-60, 61-90 y más de 90 días, a la fecha de hoy.",
      source: SRC_COBRANZA,
      withPeriod: false,
    },
    async (p) => {
      const rows = await reader.antiguedadCobranza(p.window);
      const vencido = roundMoney(rows.filter((r) => !r.bucket.startsWith("Vigente")).reduce((n, r) => n + r.monto, 0));
      const cuentasVencidas = rows.filter((r) => !r.bucket.startsWith("Vigente")).reduce((n, r) => n + r.cuentas, 0);
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SRC_COBRANZA),
        columns: [
          { key: "antiguedad", label: "Antigüedad", kind: "text" },
          { key: "cuentas", label: "Cuentas", kind: "integer" },
          { key: "monto", label: "Monto", kind: "mxn" },
        ],
        rows: rows.map((r) => ({ antiguedad: r.bucket, cuentas: r.cuentas, monto: roundMoney(r.monto) })),
        chart: { kind: "bar", x: "antiguedad", y: "monto" },
        summary: rows.length > 0 ? `Cobranza vencida a hoy (${p.window.hoy}): ${cuentasVencidas} cuentas por ${formatMxn(vencido)} (${p.scopeLabel}).` : `Sin cuentas por cobrar pendientes (${p.scopeLabel}).`,
      };
    },
  );

  const SRC_CFDI = `CFDI ingeridos al despacho por fecha del comprobante. ${NOTA_SIN_EMITIDOS}`;
  const cfdi = tool(
    reader,
    {
      name: "cfdi_por_periodo",
      label: "CFDI por periodo",
      description: "CFDI ingeridos en un periodo, por tipo (Ingreso, Egreso, Traslado, Pago, Nómina): cantidad, total en MXN, inválidos y los que esperan revisión humana. No incluye CFDI emitidos por el cliente (el sistema no los guarda).",
      source: SRC_CFDI,
      withPeriod: true,
    },
    async (p) => {
      const rows = await reader.cfdiPorPeriodo(p.window);
      const total = rows.reduce((n, r) => n + r.cfdi, 0);
      const invalidos = rows.reduce((n, r) => n + r.invalidos, 0);
      const revision = rows.reduce((n, r) => n + r.enRevision, 0);
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SRC_CFDI),
        columns: [
          { key: "tipo", label: "Tipo de CFDI", kind: "text" },
          { key: "cfdi", label: "CFDI", kind: "integer" },
          { key: "total", label: "Total", kind: "mxn" },
          { key: "invalidos", label: "Con hallazgos", kind: "integer" },
          { key: "revision", label: "En revisión", kind: "integer" },
        ],
        rows: rows.map((r) => ({ tipo: TIPO_CFDI[r.tipo] ?? r.tipo, cfdi: r.cfdi, total: roundMoney(r.total), invalidos: r.invalidos, revision: r.enRevision })),
        chart: { kind: "bar", x: "tipo", y: "cfdi" },
        summary: rows.length > 0 ? `CFDI ingeridos en ${p.periodLabel}: ${total}, ${invalidos} con hallazgos de validación y ${revision} en revisión (${p.scopeLabel}).` : undefined,
      };
    },
  );

  const SRC_IVA = "IVA de los CFDI de Ingreso (tipo I) válidos ingeridos, tratado como acreditable (misma convención que la DIOT del sistema); no es una declaración";
  const impuestos = tool(
    reader,
    {
      name: "impuestos_del_mes",
      label: "Impuestos del mes (IVA acreditable)",
      description:
        "IVA acreditable (MXN) por cliente en un periodo, sumando los CFDI de Ingreso válidos ingeridos. NO calcula IVA trasladado, saldo a cargo/favor ni ISR (el sistema no guarda los CFDI emitidos): para eso hay que usar la calculadora de declaraciones. Para fechas de pago de impuestos usa obligaciones_fiscales.",
      source: SRC_IVA,
      withPeriod: true,
    },
    async (p) => {
      const rows = await reader.ivaAcreditable(p.window);
      const iva = roundMoney(rows.reduce((n, r) => n + r.ivaAcreditable, 0));
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SRC_IVA),
        columns: [
          { key: "cliente", label: "Cliente", kind: "text" },
          { key: "cfdi", label: "CFDI válidos", kind: "integer" },
          { key: "base", label: "Subtotal", kind: "mxn" },
          { key: "iva", label: "IVA acreditable", kind: "mxn" },
        ],
        rows: rows.map((r) => ({ cliente: r.cliente, cfdi: r.cfdi, base: roundMoney(r.base), iva: roundMoney(r.ivaAcreditable) })),
        chart: { kind: "bar", x: "cliente", y: "iva" },
        summary: rows.length > 0 ? `IVA acreditable de ${p.periodLabel}: ${formatMxn(iva)} (${p.scopeLabel}). No incluye IVA trasladado ni saldo a cargo.` : undefined,
      };
    },
  );

  const SRC_OBLIG = "Vencimientos fiscales del despacho (ISR, IVA, DIOT, Nómina) por fecha límite";
  const obligaciones = tool(
    reader,
    {
      name: "obligaciones_fiscales",
      label: "Obligaciones fiscales por vencer",
      description: "Vencimientos de obligaciones ante el SAT (ISR, IVA, DIOT, Nómina) cuya fecha límite cae en el periodo, con su estado (pendiente, en proceso, completado, vencido, escalado) y prioridad.",
      source: SRC_OBLIG,
      withPeriod: true,
    },
    async (p) => {
      const rows = await reader.obligacionesFiscales(p.window);
      const abiertas = rows.filter((r) => r.estado !== "completado").length;
      const vencidas = rows.filter((r) => r.estado === "vencido").length;
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SRC_OBLIG),
        columns: [
          { key: "cliente", label: "Cliente", kind: "text" },
          { key: "obligacion", label: "Obligación", kind: "text" },
          { key: "periodo", label: "Periodo fiscal", kind: "text" },
          { key: "limite", label: "Fecha límite", kind: "text" },
          { key: "estado", label: "Estado", kind: "text" },
          { key: "prioridad", label: "Prioridad", kind: "text" },
        ],
        rows: rows.map((r) => ({ cliente: r.cliente, obligacion: r.tipo, periodo: r.periodo, limite: r.fechaLimite, estado: ESTADO_VENCIMIENTO[r.estado] ?? r.estado, prioridad: r.prioridad })),
        summary: rows.length > 0 ? `Obligaciones con fecha límite en ${p.periodLabel}: ${rows.length}, ${abiertas} sin completar (${vencidas} vencidas) (${p.scopeLabel}).` : undefined,
      };
    },
  );

  const SRC_CIERRE = "Periodos de cierre mensual sin cerrar y su checklist de tareas";
  const cierres = tool(
    reader,
    {
      name: "cierres_pendientes",
      label: "Cierres mensuales pendientes",
      description: "Periodos de cierre mensual contable que siguen abiertos o vencidos por cliente, con tareas del checklist pendientes y vencidas a hoy.",
      source: SRC_CIERRE,
      withPeriod: false,
    },
    async (p) => {
      const rows = await reader.cierresPendientes(p.window);
      const tareas = rows.reduce((n, r) => n + r.tareasPendientes, 0);
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SRC_CIERRE),
        columns: [
          { key: "cliente", label: "Cliente", kind: "text" },
          { key: "periodo", label: "Periodo", kind: "text" },
          { key: "estado", label: "Estado", kind: "text" },
          { key: "pendientes", label: "Tareas pendientes", kind: "integer" },
          { key: "vencidas", label: "Tareas vencidas", kind: "integer" },
          { key: "total", label: "Tareas totales", kind: "integer" },
        ],
        rows: rows.map((r) => ({ cliente: r.cliente, periodo: `${MESES_LARGO[r.mes - 1] ?? r.mes} ${r.anio}`, estado: ESTADO_CIERRE[r.status] ?? r.status, pendientes: r.tareasPendientes, vencidas: r.tareasVencidas, total: r.tareasTotal })),
        summary: rows.length > 0 ? `Cierres mensuales sin cerrar: ${rows.length}, con ${tareas} tareas pendientes (${p.scopeLabel}).` : undefined,
      };
    },
  );

  const SRC_EFOS = "Lista 69-B del SAT (EFOS) contra los CFDI ya ingeridos de cada cliente; solo emisores presuntos o definitivos";
  const efos: DataChatTool = {
    name: "alertas_efos",
    label: "Alertas EFOS 69-B",
    description:
      "CFDI ya ingeridos cuyo emisor figura en la lista 69-B del SAT como presunto o definitivo (operaciones inexistentes), agrupados por cliente y emisor, con cantidad de CFDI y total en MXN. Si la lista no está cargada lo dice: nunca equivale a 'sin riesgo'.",
    params: CLIENT_PARAM,
    async run(ctx, args) {
      try {
        const prepared = await prepare(reader, ctx, args, false, SRC_EFOS);
        if (isResult(prepared)) return prepared;
        const r = await reader.efosAlertas(prepared.clients);
        const b = base(prepared, SRC_EFOS);
        if (r.estado === "no_disponible") {
          return { status: "unavailable", message: "La lista 69-B del SAT todavía no está cargada en este sistema, así que no puedo descartar riesgo en tus CFDI. No lo tomes como 'sin alertas'.", ...b, columns: [], rows: [] };
        }
        const rows = r.alertas.slice(0, ctx.maxRows + 1);
        const definitivos = r.alertas.filter((a) => a.situacion === "definitivo").length;
        const truncNote = r.truncado ? " Solo se revisaron los primeros clientes: pide un cliente específico para verlo completo." : "";
        return {
          status: rows.length === 0 ? "empty" : "ok",
          ...b,
          periodLabel: `lista 69-B edición ${r.periodoLista ?? "vigente"}`,
          columns: [
            { key: "cliente", label: "Cliente", kind: "text" },
            { key: "rfc", label: "RFC del emisor", kind: "text" },
            { key: "emisor", label: "Emisor", kind: "text" },
            { key: "situacion", label: "Situación 69-B", kind: "text" },
            { key: "cfdi", label: "CFDI", kind: "integer" },
            { key: "total", label: "Total", kind: "mxn" },
          ],
          rows: rows.map((a) => ({ cliente: a.cliente, rfc: a.rfcEmisor, emisor: a.emisorNombre ?? "—", situacion: a.situacion === "definitivo" ? "Definitivo" : "Presunto", cfdi: a.cfdi, total: roundMoney(a.total) })),
          summary:
            rows.length > 0
              ? `${r.alertas.length} emisores en la lista 69-B con CFDI ingeridos (${definitivos} definitivos) (${prepared.scopeLabel}).${truncNote}`
              : `Ningún CFDI ingerido tiene emisor presunto o definitivo en la lista 69-B edición ${r.periodoLista ?? "vigente"} (${prepared.scopeLabel}).${truncNote}`,
        };
      } catch (err) {
        if (err instanceof DataChatUnavailableError) return failure("unavailable", UNAVAILABLE_MESSAGE, SRC_EFOS);
        throw err;
      }
    },
  };

  const SRC_CARGA = "Pendientes accionables por cliente: revisiones de CFDI, vencimientos fiscales abiertos y tareas de cierre. El sistema no registra un contador responsable por pendiente";
  const carga = tool(
    reader,
    {
      name: "carga_de_trabajo",
      label: "Carga de trabajo por cliente",
      description:
        "Pendientes accionables por cliente: revisiones de CFDI por resolver, vencimientos fiscales abiertos y vencidos, y tareas de cierre mensual pendientes. IMPORTANTE: el sistema no guarda qué contador es responsable de cada pendiente, así que NO existe carga por contador; si preguntan por un contador, explica eso y ofrece la carga por cliente.",
      source: SRC_CARGA,
      withPeriod: false,
    },
    async (p) => {
      const rows = await reader.cargaDeTrabajo(p.window);
      const total = rows.reduce((n, r) => n + r.revisionesPendientes + r.vencimientosAbiertos + r.tareasCierrePendientes, 0);
      return {
        status: rows.length === 0 ? "empty" : "ok",
        ...base(p, SRC_CARGA),
        columns: [
          { key: "cliente", label: "Cliente", kind: "text" },
          { key: "revisiones", label: "Revisiones de CFDI", kind: "integer" },
          { key: "vencimientos", label: "Vencimientos abiertos", kind: "integer" },
          { key: "vencidos", label: "Vencimientos vencidos", kind: "integer" },
          { key: "cierre", label: "Tareas de cierre", kind: "integer" },
        ],
        rows: rows.map((r) => ({ cliente: r.cliente, revisiones: r.revisionesPendientes, vencimientos: r.vencimientosAbiertos, vencidos: r.vencimientosVencidos, cierre: r.tareasCierrePendientes })),
        chart: { kind: "bar", x: "cliente", y: "vencimientos" },
        summary: rows.length > 0 ? `Pendientes accionables a hoy (${p.window.hoy}): ${total} entre revisiones, vencimientos abiertos y tareas de cierre (${p.scopeLabel}). Es carga por cliente, no por contador.` : undefined,
      };
    },
  );

  return [cartera, antiguedad, cfdi, impuestos, obligaciones, cierres, efos, carga];
}

export function buildDespachosDataChatCatalog(reader: DespachosDataChatReader): DataChatCatalog {
  return {
    vertical: "despachos",
    domain: "un despacho contable en México (clientes/contribuyentes, CFDI, SAT, cobranza, vencimientos fiscales y cierre mensual)",
    tools: buildDespachosDataChatTools(reader),
    async describeScope(scope) {
      const visible = await reader.listVisibleClients(scope.organizationId, scope.allowedPropertyIds);
      if (visible.length === 0) return "No tiene clientes activos asignados.";
      const shown = visible.slice(0, 40).map((c) => c.name).join(", ");
      return `Clientes que puede consultar (${visible.length}): ${shown}${visible.length > 40 ? " y más" : ""}. Si pide un cliente, usa su nombre en el parámetro "cliente".`;
    },
  };
}
