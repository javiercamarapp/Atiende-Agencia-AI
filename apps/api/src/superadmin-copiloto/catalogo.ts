// Catalogo CERRADO del Copiloto de superadmin (CHAT-16): herramientas de SOLO LECTURA sobre la plataforma completa. Cada una lee de
// `FuentesPlataforma` (fuentes.ts: funciones `core.*_for_superadmin` ya existentes, con la sesion del superadmin) y devuelve filas ya
// acotadas, sin SQL libre, sin contenido de conversaciones de organizaciones y sin PII de clientes finales (las columnas con datos de contacto
// ni se leen: p. ej. `prospectos` omite nombre de contacto, telefono, correo y notas). Todo texto que viene de la base pasa por `sanitizeCell`.
//
// Dos grupos:
//   * OPERATIVAS (superadmin completo): organizaciones, costos_ia, consumo_vs_tope, uso_por_vertical, agentes_interruptores, ultimas_corridas,
//     errores, salud_colas, planes_y_topes, eventos_seguridad, prospectos, uso_copiloto.
//   * FINANCIERAS (Copiloto CFO, SA-33): mrr, margen_costos_unitarios, pyl, contratos_por_vencer. Las puede usar el superadmin con step-up
//     (o sin MFA activa, segun la politica ya vigente del back office) y el rol `finanzas` (solo lectura, que NO ve ninguna operativa). Cada
//     llamada deja una fila en core.cfo_access_log ANTES de leer el dato; sin step-up deja una fila `denegado` y no devuelve cifras. La respuesta
//     cita la consulta (herramienta y parametros) y dice "no tengo el dato" cuando falta la fuente. Sin pagos y sin escrituras.
import {
  PERIOD_PARAMS,
  formatMxn,
  resolvePeriod,
  roundMoney,
  sanitizeCell,
  type DataChatCatalog,
  type DataChatColumn,
  type DataChatTool,
  type DataChatToolContext,
  type DataChatToolResult,
  type ParamsSpec,
  type ParsedArgs,
} from "@atiende/agent-core/data-chat";
import { aportaMrr, calcularIngresos } from "@atiende/billing";
import type { BillingSnapshotRow } from "@atiende/db";
import { SWITCHABLE_AGENT_ROLES } from "../platform-switches.ts";
import { UMBRAL_MARGEN_PCT_DEFAULT, construirFilasCfo, tipoCambioDeFilas } from "../cfo/filas.ts";
import { infraDelMes, pylDelMes } from "../routes/superadmin-pyl.ts";
import type { PlatformScope } from "./alcance.ts";
import type { Fuente, FuentesPlataforma, RazonFuente } from "./fuentes.ts";

export const HERRAMIENTAS_FINANCIERAS: readonly string[] = ["mrr", "margen_costos_unitarios", "pyl", "contratos_por_vencer"];

export const HERRAMIENTAS_OPERATIVAS: readonly string[] = [
  "organizaciones",
  "costos_ia",
  "consumo_vs_tope",
  "uso_por_vertical",
  "agentes_interruptores",
  "ultimas_corridas",
  "errores",
  "salud_colas",
  "planes_y_topes",
  "eventos_seguridad",
  "prospectos",
  "uso_copiloto",
];

export const MENSAJE_FUERA_DE_CATALOGO = "No tengo el dato: esa pregunta no está cubierta por las consultas de plataforma disponibles, así que no puedo darte una cifra confiable.";

const VERTICALES = ["restaurantes", "hoteles", "rentas", "citas", "despachos", "licitaciones"] as const;
const MES_RE = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const MICRO = 1_000_000;

export interface OpcionesCatalogoPlataforma {
  /** Tope mensual propio del Copiloto de plataforma (micro-USD), para `consumo_vs_tope`. */
  readonly topeCopilotoMicroUsd?: number | undefined;
}

const RAZON_TEXTO: Readonly<Record<RazonFuente, string>> = {
  no_migrado: "falta aplicar una actualización de la base de datos en este despliegue",
  error: "la fuente no respondió en este momento",
  sin_repositorio: "esa fuente no está configurada en este despliegue",
};

function falla(status: DataChatToolResult["status"], message: string, source: string): DataChatToolResult {
  return { status, message, source, scopeLabel: "", columns: [], rows: [] };
}

/** La fuente falta: el Copiloto lo dice y NO inventa una cifra. */
function sinDato(source: string, razon: RazonFuente): DataChatToolResult {
  return falla("unavailable", `No tengo el dato: ${RAZON_TEXTO[razon]}. Tus tableros de plataforma siguen disponibles.`, source);
}

const usd = (micro: number): number => Math.round(micro / 100) / 10_000;
const mxnDeCentavos = (centavos: number): number => roundMoney(centavos / 100);
const pct1 = (n: number): number => Math.round(n * 10) / 10;
const texto = (v: string | null | undefined, max = 60): string => sanitizeCell(v ?? "", max);
const fechaHora = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const fechaHoraIso = (iso: string | null): string | null => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") : null);

function hoy(ctx: DataChatToolContext): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ctx.scope.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ctx.now);
}

function sumarDias(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}

/** Primer dia del mes en curso (en la zona de la plataforma) hasta hoy. */
function mesEnCurso(ctx: DataChatToolContext): { readonly desde: string; readonly hasta: string } {
  const h = hoy(ctx);
  return { desde: `${h.slice(0, 7)}-01`, hasta: h };
}

function cita(nombre: string, args: ParsedArgs): string {
  const partes = Object.entries(args)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${sanitizeCell(String(v), 40)}`);
  return `Consulta «${nombre}»${partes.length > 0 ? ` (${partes.join(", ")})` : ""}`;
}

const col = (key: string, label: string, kind: DataChatColumn["kind"] = "text"): DataChatColumn => ({ key, label, kind });

function tabla(rows: readonly Readonly<Record<string, string | number | null>>[], maxRows: number): readonly Readonly<Record<string, string | number | null>>[] {
  return rows.slice(0, maxRows + 1);
}

interface DefHerramienta {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly params: ParamsSpec;
  run(ctx: DataChatToolContext, args: ParsedArgs): Promise<DataChatToolResult>;
}

function herramienta(def: DefHerramienta): DataChatTool {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    params: def.params,
    async run(ctx, args) {
      try {
        return await def.run(ctx, args);
      } catch (err) {
        if ((err as { code?: string } | null)?.code === "tool_timeout") throw err;
        // Una fuente que lanzo algo inesperado no tumba el turno ni se disfraza de cifra.
        return falla("unavailable", `No tengo el dato: ${RAZON_TEXTO.error}.`, def.label);
      }
    },
  };
}

/** Periodo estandar de las herramientas con ventana de tiempo (zona de la plataforma). */
function periodoDe(ctx: DataChatToolContext, args: ParsedArgs, source: string): { readonly ok: true; readonly period: Extract<ReturnType<typeof resolvePeriod>, { ok: true }>["period"] } | { readonly ok: false; readonly result: DataChatToolResult } {
  const p = resolvePeriod(args, ctx.now, ctx.scope.timezone);
  if (!p.ok) return { ok: false, result: falla(p.kind === "needs_clarification" ? "needs_clarification" : "error", p.message, source) };
  return { ok: true, period: p.period };
}

function resultado(base: Pick<DataChatToolResult, "source" | "scopeLabel"> & Partial<Pick<DataChatToolResult, "periodLabel" | "summary" | "chart">>, columns: readonly DataChatColumn[], rows: readonly Readonly<Record<string, string | number | null>>[], maxRows: number): DataChatToolResult {
  return { status: rows.length === 0 ? "empty" : "ok", ...base, columns, rows: tabla(rows, maxRows) };
}

const SCOPE_PLATAFORMA = "Toda la plataforma";

// ---------------------------------------------------------------------------------------------------------------------------
// Herramientas operativas
// ---------------------------------------------------------------------------------------------------------------------------

function organizaciones(f: FuentesPlataforma): DataChatTool {
  const fuente = "Organizaciones de la plataforma y personal con membresía (core.list_all_organizations_for_superadmin y core.count_staff_by_organization_for_superadmin)";
  return herramienta({
    name: "organizaciones",
    label: "Organizaciones y personal",
    description: "Organizaciones de la plataforma con su vertical, estado y cuántas personas del personal tienen acceso. Útil para contar clientes activos, en prueba o suspendidos.",
    params: {
      vertical: { type: "enum", values: VERTICALES, optional: true, description: "Solo esa vertical; sin él, todas." },
      estado: { type: "enum", values: ["trial", "active", "suspended"], optional: true, description: "Solo ese estado; sin él, todos." },
    },
    async run(ctx, args) {
      const r = await f.organizaciones();
      if (!r.ok) return sinDato(fuente, r.razon);
      const filtradas = r.data.filter((o) => (!args["vertical"] || o.vertical === args["vertical"]) && (!args["estado"] || o.status === args["estado"]));
      const activas = filtradas.filter((o) => o.status === "active").length;
      const rows = [...filtradas]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((o) => ({ organizacion: texto(o.name), vertical: o.vertical, estado: o.status, personal: o.staffCount, alta: o.createdAt.slice(0, 10) }));
      return resultado(
        { source: `${cita("organizaciones", args)}: ${fuente}`, scopeLabel: SCOPE_PLATAFORMA, summary: `${filtradas.length} organizaciones, ${activas} activas.` },
        [col("organizacion", "Organización"), col("vertical", "Vertical"), col("estado", "Estado"), col("personal", "Personal con acceso", "integer"), col("alta", "Alta")],
        rows,
        ctx.maxRows,
      );
    },
  });
}

function costosIa(f: FuentesPlataforma): DataChatTool {
  const fuente = "Gasto de IA registrado por el gateway de modelos (core.llm_usage_daily), en USD";
  return herramienta({
    name: "costos_ia",
    label: "Costos de IA",
    description: "Gasto de IA (USD) del periodo agrupado por organización, vertical, rol del agente o modelo.",
    params: {
      ...PERIOD_PARAMS,
      agrupar: { type: "enum", values: ["organizacion", "vertical", "rol", "modelo"], optional: true, description: "Cómo agrupar el gasto; sin él, por organización." },
    },
    async run(ctx, args) {
      const p = periodoDe(ctx, args, fuente);
      if (!p.ok) return p.result;
      const { fromDate, toDate, label } = p.period;
      const agrupar = (args["agrupar"] as string | undefined) ?? "organizacion";
      const base = { source: `${cita("costos_ia", { ...args, agrupar })}: ${fuente}`, periodLabel: label, scopeLabel: SCOPE_PLATAFORMA };
      if (agrupar === "organizacion") {
        const r = await f.llmPorOrganizacion(fromDate, toDate);
        if (!r.ok) return sinDato(fuente, r.razon);
        const filas = [...r.data].sort((a, b) => b.costMicroUsd - a.costMicroUsd);
        const total = filas.reduce((s, x) => s + x.costMicroUsd, 0);
        return resultado(
          { ...base, summary: `Gasto de IA total: ${usd(total)} USD en ${filas.length} organizaciones.`, chart: { kind: "bar", x: "organizacion", y: "costo_usd" } },
          [col("organizacion", "Organización"), col("vertical", "Vertical"), col("llamadas", "Llamadas", "integer"), col("costo_usd", "Costo (USD)", "decimal")],
          filas.map((x) => ({ organizacion: texto(x.organizationName), vertical: x.vertical, llamadas: x.callCount, costo_usd: usd(x.costMicroUsd) })),
          ctx.maxRows,
        );
      }
      if (agrupar === "rol") {
        const r = await f.llmPorRolMes(fromDate, toDate);
        if (!r.ok) return sinDato(fuente, r.razon);
        const porRol = new Map<string, { llamadas: number; fallbacks: number; costo: number }>();
        for (const x of r.data) {
          const a = porRol.get(x.role) ?? { llamadas: 0, fallbacks: 0, costo: 0 };
          a.llamadas += x.callCount;
          a.fallbacks += x.fallbackCallCount;
          a.costo += x.costMicroUsd;
          porRol.set(x.role, a);
        }
        const filas = [...porRol.entries()].sort((a, b) => b[1].costo - a[1].costo);
        const total = filas.reduce((s, [, v]) => s + v.costo, 0);
        return resultado(
          { ...base, summary: `Gasto de IA por rol: ${usd(total)} USD en ${filas.length} roles.`, chart: { kind: "bar", x: "rol", y: "costo_usd" } },
          [col("rol", "Rol del agente"), col("llamadas", "Llamadas", "integer"), col("fallbacks", "Con modelo de respaldo", "integer"), col("costo_usd", "Costo (USD)", "decimal")],
          filas.map(([rol, v]) => ({ rol: texto(rol), llamadas: v.llamadas, fallbacks: v.fallbacks, costo_usd: usd(v.costo) })),
          ctx.maxRows,
        );
      }
      const r = await f.llmPorModelo(fromDate, toDate);
      if (!r.ok) return sinDato(fuente, r.razon);
      if (agrupar === "vertical") {
        const porVertical = new Map<string, { llamadas: number; costo: number }>();
        for (const x of r.data) {
          const a = porVertical.get(x.vertical) ?? { llamadas: 0, costo: 0 };
          a.llamadas += x.callCount;
          a.costo += x.costMicroUsd;
          porVertical.set(x.vertical, a);
        }
        const filas = [...porVertical.entries()].sort((a, b) => b[1].costo - a[1].costo);
        const total = filas.reduce((s, [, v]) => s + v.costo, 0);
        return resultado(
          { ...base, summary: `Gasto de IA por vertical: ${usd(total)} USD.`, chart: { kind: "bar", x: "vertical", y: "costo_usd" } },
          [col("vertical", "Vertical"), col("llamadas", "Llamadas", "integer"), col("costo_usd", "Costo (USD)", "decimal")],
          filas.map(([vertical, v]) => ({ vertical, llamadas: v.llamadas, costo_usd: usd(v.costo) })),
          ctx.maxRows,
        );
      }
      const porModelo = new Map<string, { proveedor: string; llamadas: number; costo: number }>();
      for (const x of r.data) {
        const k = `${x.providerId}|${x.model}`;
        const a = porModelo.get(k) ?? { proveedor: x.providerId, llamadas: 0, costo: 0 };
        a.llamadas += x.callCount;
        a.costo += x.costMicroUsd;
        porModelo.set(k, a);
      }
      const filas = [...porModelo.entries()].sort((a, b) => b[1].costo - a[1].costo);
      const total = filas.reduce((s, [, v]) => s + v.costo, 0);
      return resultado(
        { ...base, summary: `Gasto de IA por modelo: ${usd(total)} USD en ${filas.length} modelos.` },
        [col("modelo", "Modelo"), col("proveedor", "Proveedor"), col("llamadas", "Llamadas", "integer"), col("costo_usd", "Costo (USD)", "decimal")],
        filas.map(([k, v]) => ({ modelo: texto(k.split("|")[1] ?? k), proveedor: texto(v.proveedor), llamadas: v.llamadas, costo_usd: usd(v.costo) })),
        ctx.maxRows,
      );
    },
  });
}

function consumoVsTope(f: FuentesPlataforma, opciones: OpcionesCatalogoPlataforma): DataChatTool {
  const fuente = "Gasto del mes frente al tope mensual: tope por organización y de plataforma (core.llm_org_budget, core.llm_platform_budget) y gasto propio del Copiloto de superadmin";
  return herramienta({
    name: "consumo_vs_tope",
    label: "Consumo de IA frente al tope mensual",
    description: "Gasto de IA del mes en curso frente al tope mensual: de la plataforma, del propio Copiloto de superadmin y de cada organización, con el porcentaje usado.",
    params: {},
    async run(ctx, args) {
      const { desde, hasta } = mesEnCurso(ctx);
      const [orgs, plataforma, copiloto] = await Promise.all([f.llmPorOrganizacion(desde, hasta), f.presupuestoPlataforma(), f.copilotoGastoMes()]);
      if (!orgs.ok && !plataforma.ok) return sinDato(fuente, orgs.razon);
      const pct = (gasto: number, tope: number): number | null => (tope > 0 ? pct1((gasto / tope) * 100) : null);
      const filas: Record<string, string | number | null>[] = [];
      if (plataforma.ok) {
        const x = plataforma.data;
        filas.push({ ambito: "Plataforma (tope global)", gasto_usd: usd(x.spendThisMonthMicroUsd), tope_usd: usd(x.monthlyCapMicroUsd), uso_pct: pct(x.spendThisMonthMicroUsd, x.monthlyCapMicroUsd), aviso_pct: x.alertThresholdPct });
      }
      const tope = opciones.topeCopilotoMicroUsd;
      if (tope !== undefined) {
        filas.push({ ambito: "Copiloto de superadmin", gasto_usd: copiloto.ok ? usd(copiloto.data) : null, tope_usd: usd(tope), uso_pct: copiloto.ok ? pct(copiloto.data, tope) : null, aviso_pct: null });
      }
      if (orgs.ok) {
        for (const x of [...orgs.data].sort((a, b) => b.spendThisMonthMicroUsd / Math.max(1, b.monthlyCapMicroUsd) - a.spendThisMonthMicroUsd / Math.max(1, a.monthlyCapMicroUsd))) {
          filas.push({ ambito: texto(x.organizationName), gasto_usd: usd(x.spendThisMonthMicroUsd), tope_usd: usd(x.monthlyCapMicroUsd), uso_pct: pct(x.spendThisMonthMicroUsd, x.monthlyCapMicroUsd), aviso_pct: x.alertThresholdPct });
        }
      }
      const faltan = [!orgs.ok ? "organizaciones" : null, !plataforma.ok ? "plataforma" : null].filter(Boolean).join(" y ");
      return resultado(
        {
          source: `${cita("consumo_vs_tope", args)}: ${fuente}${faltan ? `. Sin dato de ${faltan}` : ""}`,
          periodLabel: `mes en curso (${desde} al ${hasta})`,
          scopeLabel: SCOPE_PLATAFORMA,
          summary: plataforma.ok ? `Plataforma: ${usd(plataforma.data.spendThisMonthMicroUsd)} USD de ${usd(plataforma.data.monthlyCapMicroUsd)} USD de tope mensual.` : "Sin dato del tope de plataforma.",
        },
        [col("ambito", "Ámbito"), col("gasto_usd", "Gasto del mes (USD)", "decimal"), col("tope_usd", "Tope mensual (USD)", "decimal"), col("uso_pct", "Uso del tope", "percent"), col("aviso_pct", "Aviso al", "percent")],
        filas,
        ctx.maxRows,
      );
    },
  });
}

function usoPorVertical(f: FuentesPlataforma): DataChatTool {
  const fuente = "Consola de plataforma: organizaciones, operaciones atendidas, conversaciones de WhatsApp y actividad de agentes por vertical";
  return herramienta({
    name: "uso_por_vertical",
    label: "Uso por vertical",
    description: "Por vertical: organizaciones activas y demo, operaciones atendidas en el periodo, conversaciones de WhatsApp y llamadas y costo de IA de los últimos 30 días.",
    params: { ...PERIOD_PARAMS },
    async run(ctx, args) {
      const p = periodoDe(ctx, args, fuente);
      if (!p.ok) return p.result;
      const { fromDate, toDate, label } = p.period;
      const [orgs, ops, wa, act] = await Promise.all([f.consolaOrganizaciones(), f.consolaOperaciones(fromDate, toDate), f.consolaConversacionesWa(), f.consolaAgentesActividad(hoy(ctx))]);
      if (!orgs.ok && !ops.ok && !wa.ok && !act.ok) return sinDato(fuente, orgs.razon);
      const filas = VERTICALES.map((v) => {
        const o = orgs.ok ? orgs.data.find((x) => x.vertical === v) : undefined;
        const opsV = ops.ok ? ops.data.filter((x) => x.vertical === v && x.dia !== null) : [];
        const operaciones = ops.ok && opsV.length > 0 && opsV.every((x) => x.cantidad !== null) ? opsV.reduce((s, x) => s + (x.cantidad ?? 0), 0) : null;
        const w = wa.ok ? wa.data.find((x) => x.vertical === v) : undefined;
        const a = act.ok ? act.data.filter((x) => x.vertical === v) : [];
        return {
          vertical: v,
          organizaciones: orgs.ok ? (o?.total ?? 0) : null,
          activas: orgs.ok ? (o?.activas ?? 0) : null,
          demo: orgs.ok ? (o?.demo ?? 0) : null,
          operaciones,
          conversaciones_wa: w?.total ?? null,
          llamadas_ia_30d: act.ok ? a.reduce((s, x) => s + x.llamadas30d, 0) : null,
          costo_ia_30d_usd: act.ok ? usd(a.reduce((s, x) => s + x.costo30dMicroUsd, 0)) : null,
        };
      });
      const faltan = [!orgs.ok ? "organizaciones" : null, !ops.ok ? "operaciones" : null, !wa.ok ? "conversaciones de WhatsApp" : null, !act.ok ? "actividad de agentes" : null].filter(Boolean).join(", ");
      return resultado(
        {
          source: `${cita("uso_por_vertical", args)}: ${fuente}${faltan ? `. Sin dato de: ${faltan} (columna vacía = no tengo el dato)` : ""}`,
          periodLabel: label,
          scopeLabel: SCOPE_PLATAFORMA,
          chart: { kind: "bar", x: "vertical", y: "organizaciones" },
        },
        [
          col("vertical", "Vertical"),
          col("organizaciones", "Organizaciones", "integer"),
          col("activas", "Activas", "integer"),
          col("demo", "Demo", "integer"),
          col("operaciones", "Operaciones del periodo", "integer"),
          col("conversaciones_wa", "Conversaciones de WhatsApp", "integer"),
          col("llamadas_ia_30d", "Llamadas de IA (30 días)", "integer"),
          col("costo_ia_30d_usd", "Costo de IA 30 días (USD)", "decimal"),
        ],
        filas,
        ctx.maxRows,
      );
    },
  });
}

function agentesInterruptores(f: FuentesPlataforma): DataChatTool {
  const fuente = "Interruptores de plataforma (core.list_platform_switches_for_superadmin) y actividad de IA por rol de los últimos 30 días";
  return herramienta({
    name: "agentes_interruptores",
    label: "Agentes e interruptores",
    description: "Cada rol de agente de IA con su interruptor (activo o apagado) y su actividad de los últimos 30 días: llamadas, costo y llamadas con modelo de respaldo.",
    params: {},
    async run(ctx, args) {
      const [sw, act] = await Promise.all([f.interruptores(), f.consolaAgentesActividad(hoy(ctx))]);
      if (!sw.ok) return sinDato(fuente, sw.razon);
      const apagados = new Map(sw.data.filter((s) => s.blocked).map((s) => [`${s.scope}:${s.target}`, s]));
      const globalLlm = apagados.get("global:llm");
      const filas = [...SWITCHABLE_AGENT_ROLES].sort().map((rol) => {
        const bloqueo = apagados.get(`agente:${rol}`);
        const a = act.ok ? act.data.filter((x) => x.role === rol) : [];
        return {
          rol,
          estado: bloqueo || globalLlm ? "apagado" : "activo",
          motivo: bloqueo ? texto(bloqueo.reason, 80) : globalLlm ? "interruptor global de IA" : null,
          llamadas_30d: act.ok ? a.reduce((s, x) => s + x.llamadas30d, 0) : null,
          costo_30d_usd: act.ok ? usd(a.reduce((s, x) => s + x.costo30dMicroUsd, 0)) : null,
          respaldo_30d: act.ok ? a.reduce((s, x) => s + x.fallback30d, 0) : null,
        };
      });
      const apagadosN = filas.filter((x) => x.estado === "apagado").length;
      return resultado(
        {
          source: `${cita("agentes_interruptores", args)}: ${fuente}${act.ok ? "" : ". Sin dato de actividad (columna vacía = no tengo el dato)"}`,
          scopeLabel: SCOPE_PLATAFORMA,
          summary: `${filas.length} roles de agente, ${apagadosN} apagados.`,
        },
        [col("rol", "Rol del agente"), col("estado", "Interruptor"), col("motivo", "Motivo"), col("llamadas_30d", "Llamadas (30 días)", "integer"), col("costo_30d_usd", "Costo 30 días (USD)", "decimal"), col("respaldo_30d", "Con modelo de respaldo", "integer")],
        filas,
        ctx.maxRows,
      );
    },
  });
}

function ultimasCorridas(f: FuentesPlataforma): DataChatTool {
  const fuente = "Último latido de cada cron (core.list_cron_heartbeats_for_superadmin)";
  return herramienta({
    name: "ultimas_corridas",
    label: "Últimas corridas de los crons",
    description: "Última ejecución de cada tarea programada (cron): estado, hora, duración y fallos seguidos.",
    params: { estado: { type: "enum", values: ["ok", "error"], optional: true, description: "Solo las que terminaron así; sin él, todas." } },
    async run(ctx, args) {
      const r = await f.heartbeats();
      if (!r.ok) return sinDato(fuente, r.razon);
      const filtradas = r.data.filter((x) => !args["estado"] || x.lastStatus === args["estado"]);
      const filas = [...filtradas]
        .sort((a, b) => (b.lastFinishedAt ?? "").localeCompare(a.lastFinishedAt ?? ""))
        .map((x) => ({ cron: texto(x.cronName, 80), estado: x.lastStatus, ultima_corrida: fechaHoraIso(x.lastFinishedAt), duracion_ms: x.lastDurationMs, fallos_seguidos: x.consecutiveFailures }));
      const enError = r.data.filter((x) => x.lastStatus === "error").length;
      return resultado(
        { source: `${cita("ultimas_corridas", args)}: ${fuente}`, scopeLabel: SCOPE_PLATAFORMA, summary: `${r.data.length} crons con latido, ${enError} con su última corrida en error.` },
        [col("cron", "Cron"), col("estado", "Último estado"), col("ultima_corrida", "Última corrida (UTC)"), col("duracion_ms", "Duración (ms)", "integer"), col("fallos_seguidos", "Fallos seguidos", "integer")],
        filas,
        ctx.maxRows,
      );
    },
  });
}

function errores(f: FuentesPlataforma): DataChatTool {
  const fuente = "Crons en error, mensajes muertos de las colas, fuentes de licitaciones en falla y accesos denegados a /superadmin";
  return herramienta({
    name: "errores",
    label: "Errores y fallas recientes",
    description: "Hallazgos de falla de la plataforma: crons en error, colas con mensajes muertos, fuentes de licitaciones caídas y accesos denegados.",
    params: { fuente: { type: "enum", values: ["todas", "crons", "colas", "licitaciones", "denegaciones"], optional: true, description: "Qué revisar; sin él, todas." } },
    async run(ctx, args) {
      const quiere = (args["fuente"] as string | undefined) ?? "todas";
      const quieren = (k: string): boolean => quiere === "todas" || quiere === k;
      const [hb, colas, muertos, lic, den] = await Promise.all([
        quieren("crons") ? f.heartbeats() : Promise.resolve(null),
        quieren("colas") ? f.colas() : Promise.resolve(null),
        quieren("colas") ? f.colasMuertos(200) : Promise.resolve(null),
        quieren("licitaciones") ? f.fuentesLicitaciones() : Promise.resolve(null),
        quieren("denegaciones") ? f.denegaciones(200) : Promise.resolve(null),
      ]);
      const consultadas: { nombre: string; r: Fuente<unknown> }[] = [
        ...(hb ? [{ nombre: "crons", r: hb }] : []),
        ...(colas ? [{ nombre: "colas", r: colas }] : []),
        ...(lic ? [{ nombre: "licitaciones", r: lic }] : []),
        ...(den ? [{ nombre: "denegaciones", r: den }] : []),
      ];
      const todasFallan = consultadas.length > 0 && consultadas.every((c) => !c.r.ok);
      if (todasFallan) return sinDato(fuente, (consultadas[0]!.r as { razon: RazonFuente }).razon);
      const filas: Record<string, string | number | null>[] = [];
      if (hb?.ok) {
        for (const x of hb.data.filter((c) => c.lastStatus === "error" || c.consecutiveFailures > 0)) {
          filas.push({ fuente: "cron", elemento: texto(x.cronName, 80), detalle: texto(x.lastError, 100) || "sin detalle", cantidad: x.consecutiveFailures, ultima_vez: fechaHoraIso(x.lastFinishedAt) });
        }
      }
      if (colas?.ok) {
        for (const x of colas.data.filter((c) => c.deadCount > 0 || c.failedCount > 0)) {
          filas.push({ fuente: "cola", elemento: x.queueName, detalle: `${x.deadCount} muertos, ${x.failedCount} fallidos, ${x.pendingCount} pendientes`, cantidad: x.deadCount, ultima_vez: fechaHoraIso(x.lastSentAt) });
        }
      }
      if (muertos?.ok) {
        const grupos = new Map<string, { cola: string; org: string; evento: string; canal: string; n: number; ultima: string }>();
        for (const m of muertos.data) {
          const k = `${m.queueName}|${m.organizationId}|${m.eventType}`;
          const g = grupos.get(k) ?? { cola: m.queueName, org: m.organizationName, evento: m.eventType, canal: m.channel, n: 0, ultima: m.createdAt };
          g.n += 1;
          if (m.createdAt > g.ultima) g.ultima = m.createdAt;
          grupos.set(k, g);
        }
        for (const g of grupos.values()) filas.push({ fuente: "mensaje muerto", elemento: `${g.cola} / ${texto(g.org)}`, detalle: `${texto(g.evento, 50)} por ${texto(g.canal, 20)}`, cantidad: g.n, ultima_vez: fechaHoraIso(g.ultima) });
      }
      if (lic?.ok) {
        for (const x of lic.data.filter((s) => s.state !== "ok" && s.state !== "not_configured")) {
          filas.push({ fuente: "licitaciones", elemento: `${texto(x.source, 40)} / ${texto(x.organizationName)}`, detalle: `${texto(x.state, 30)}${x.message ? `: ${texto(x.message, 80)}` : ""}`, cantidad: 1, ultima_vez: fechaHoraIso(x.finishedAt) });
        }
      }
      if (den?.ok) {
        const grupos = new Map<string, { n: number; ultima: number; razon: string }>();
        for (const d of den.data.filter((x) => x.decision !== "allowed")) {
          const k = `${d.method} ${d.route}|${d.reason ?? ""}`;
          const g = grupos.get(k) ?? { n: 0, ultima: 0, razon: d.reason ?? d.decision };
          g.n += 1;
          g.ultima = Math.max(g.ultima, d.occurredAtMs);
          grupos.set(k, g);
        }
        for (const [k, g] of grupos) filas.push({ fuente: "acceso denegado", elemento: texto(k.split("|")[0], 80), detalle: texto(g.razon, 80), cantidad: g.n, ultima_vez: fechaHora(g.ultima) });
      }
      const faltan = consultadas.filter((c) => !c.r.ok).map((c) => c.nombre).join(", ");
      return resultado(
        {
          source: `${cita("errores", args)}: ${fuente}${faltan ? `. Sin dato de: ${faltan}` : ""}`,
          scopeLabel: SCOPE_PLATAFORMA,
          summary: `${filas.length} hallazgos de falla.`,
        },
        [col("fuente", "Fuente"), col("elemento", "Elemento"), col("detalle", "Detalle"), col("cantidad", "Cantidad", "integer"), col("ultima_vez", "Última vez (UTC)")],
        filas,
        ctx.maxRows,
      );
    },
  });
}

function saludColas(f: FuentesPlataforma): DataChatTool {
  const fuente = "Salud de las colas de mensajes por vertical (core.get_outbox_health_for_superadmin)";
  return herramienta({
    name: "salud_colas",
    label: "Salud de las colas de mensajes",
    description: "Por cola de mensajes (una por vertical): pendientes, en proceso, enviados, fallidos, muertos, antigüedad del pendiente más viejo y último envío.",
    params: {},
    async run(ctx, args) {
      const r = await f.colas();
      if (!r.ok) return sinDato(fuente, r.razon);
      const muertos = r.data.reduce((s, x) => s + x.deadCount, 0);
      return resultado(
        { source: `${cita("salud_colas", args)}: ${fuente}`, scopeLabel: SCOPE_PLATAFORMA, summary: `${r.data.length} colas, ${muertos} mensajes muertos en total.` },
        [
          col("cola", "Cola"),
          col("pendientes", "Pendientes", "integer"),
          col("procesando", "En proceso", "integer"),
          col("enviados", "Enviados", "integer"),
          col("fallidos", "Fallidos", "integer"),
          col("muertos", "Muertos", "integer"),
          col("pendiente_mas_viejo_seg", "Pendiente más viejo (seg)", "integer"),
          col("ultimo_envio", "Último envío (UTC)"),
        ],
        r.data.map((x) => ({ cola: x.queueName, pendientes: x.pendingCount, procesando: x.processingCount, enviados: x.sentCount, fallidos: x.failedCount, muertos: x.deadCount, pendiente_mas_viejo_seg: x.oldestPendingSeconds, ultimo_envio: fechaHoraIso(x.lastSentAt) })),
        ctx.maxRows,
      );
    },
  });
}

function planesYTopes(f: FuentesPlataforma): DataChatTool {
  const fuente = "Catálogo de planes con sus límites y asignaciones de plan a organizaciones (core.list_plans_for_superadmin, core.list_plan_assignments_for_superadmin)";
  return herramienta({
    name: "planes_y_topes",
    label: "Planes y topes",
    description: "Planes del catálogo con precio, asientos y límites (topes), o las asignaciones de plan a organizaciones.",
    params: { ver: { type: "enum", values: ["planes", "asignaciones"], optional: true, description: "Qué mostrar; sin él, los planes." } },
    async run(ctx, args) {
      const ver = (args["ver"] as string | undefined) ?? "planes";
      if (ver === "asignaciones") {
        const r = await f.asignaciones(100);
        if (!r.ok) return sinDato(fuente, r.razon);
        return resultado(
          { source: `${cita("planes_y_topes", { ...args, ver })}: ${fuente}`, scopeLabel: SCOPE_PLATAFORMA, summary: `${r.data.length} asignaciones de plan recientes.` },
          [col("organizacion", "Organización"), col("plan", "Plan"), col("estado", "Estado"), col("motivo", "Motivo"), col("creada", "Creada (UTC)"), col("vence", "Vence (UTC)")],
          r.data.map((a) => ({ organizacion: texto(a.organizationName ?? ""), plan: texto(a.planId), estado: a.estado, motivo: texto(a.motivo, 80), creada: fechaHora(a.creadoEnMs), vence: fechaHora(a.venceEnMs) })),
          ctx.maxRows,
        );
      }
      const r = await f.planes();
      if (!r.ok) return sinDato(fuente, r.razon);
      return resultado(
        { source: `${cita("planes_y_topes", { ...args, ver })}: ${fuente}`, scopeLabel: SCOPE_PLATAFORMA, summary: `${r.data.length} planes en el catálogo, ${r.data.filter((p) => p.activo).length} activos.` },
        [
          col("plan", "Plan"),
          col("vertical", "Vertical"),
          col("precio_base_mxn", "Precio base (MXN)", "mxn"),
          col("precio_asiento_mxn", "Precio por asiento (MXN)", "mxn"),
          col("asientos", "Asientos incluidos", "integer"),
          col("activo", "Activo"),
          col("organizaciones", "Organizaciones", "integer"),
          col("limites", "Límites"),
        ],
        r.data.map((p) => ({
          plan: texto(p.nombre),
          vertical: p.vertical,
          precio_base_mxn: p.precioBaseCentavos === null ? null : mxnDeCentavos(p.precioBaseCentavos),
          precio_asiento_mxn: p.precioAsientoCentavos === null ? null : mxnDeCentavos(p.precioAsientoCentavos),
          asientos: p.asientosIncluidos,
          activo: p.activo ? "sí" : "no",
          organizaciones: p.organizaciones,
          limites: p.limites.length === 0 ? "sin límites" : texto(p.limites.map((l) => `${l.metrica} ${l.limite} (${l.accion})`).join("; "), 160),
        })),
        ctx.maxRows,
      );
    },
  });
}

function eventosSeguridad(f: FuentesPlataforma): DataChatTool {
  const fuente = "Eventos de seguridad de plataforma: MFA, interruptores y gestión de organizaciones (core.list_superadmin_security_events)";
  return herramienta({
    name: "eventos_seguridad",
    label: "Eventos de seguridad",
    description: "Eventos recientes de seguridad de la plataforma: cambios de MFA, de interruptores y de gestión de organizaciones.",
    params: { area: { type: "enum", values: ["mfa", "switch", "org"], optional: true, description: "Solo esa área; sin él, todas." } },
    async run(ctx, args) {
      const r = await f.eventosSeguridad(100);
      if (!r.ok) return sinDato(fuente, r.razon);
      const filtrados = r.data.filter((e) => !args["area"] || e.area === args["area"]);
      return resultado(
        { source: `${cita("eventos_seguridad", args)}: ${fuente}`, scopeLabel: SCOPE_PLATAFORMA, summary: `${filtrados.length} eventos de seguridad recientes.` },
        [col("ocurrio", "Cuándo (UTC)"), col("area", "Área"), col("evento", "Evento")],
        filtrados.map((e) => ({ ocurrio: fechaHora(e.occurredAtMs), area: e.area, evento: texto(e.event, 80) })),
        ctx.maxRows,
      );
    },
  });
}

function prospectos(f: FuentesPlataforma): DataChatTool {
  const fuente = "Cerebro de ventas: prospectos de la plataforma (core.list_prospectos_for_superadmin); no incluye datos de contacto";
  return herramienta({
    name: "prospectos",
    label: "Prospectos (cerebro de ventas)",
    description: "Prospectos de ventas de la plataforma: conteo por estado o por vertical, o la lista con empresa, vertical, ciudad y estado (sin datos de contacto).",
    params: {
      agrupar: { type: "enum", values: ["estado", "vertical", "lista"], optional: true, description: "Cómo mostrarlos; sin él, por estado." },
      estado: { type: "enum", values: ["nuevo", "contactado", "demo", "propuesta", "negociacion", "ganado", "perdido", "descartado"], optional: true, description: "Solo ese estado." },
    },
    async run(ctx, args) {
      const r = await f.prospectos();
      if (!r.ok) return sinDato(fuente, r.razon);
      const agrupar = (args["agrupar"] as string | undefined) ?? "estado";
      const lista = r.data.filter((p) => !args["estado"] || p.estado === args["estado"]);
      const base = { source: `${cita("prospectos", { ...args, agrupar })}: ${fuente}`, scopeLabel: SCOPE_PLATAFORMA, summary: `${lista.length} prospectos.` };
      if (agrupar === "lista") {
        return resultado(
          base,
          [col("empresa", "Empresa"), col("vertical", "Vertical"), col("ciudad", "Ciudad"), col("estado", "Estado"), col("actualizado", "Actualizado")],
          [...lista].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((p) => ({ empresa: texto(p.empresa), vertical: p.vertical, ciudad: texto(p.ciudad), estado: p.estado, actualizado: p.updatedAt.slice(0, 10) })),
          ctx.maxRows,
        );
      }
      const clave = (p: (typeof lista)[number]): string => (agrupar === "vertical" ? p.vertical : p.estado);
      const conteo = new Map<string, number>();
      for (const p of lista) conteo.set(clave(p), (conteo.get(clave(p)) ?? 0) + 1);
      return resultado(
        { ...base, chart: { kind: "bar", x: "grupo", y: "prospectos" } },
        [col("grupo", agrupar === "vertical" ? "Vertical" : "Estado"), col("prospectos", "Prospectos", "integer")],
        [...conteo.entries()].sort((a, b) => b[1] - a[1]).map(([grupo, prospectos]) => ({ grupo, prospectos })),
        ctx.maxRows,
      );
    },
  });
}

function usoCopiloto(f: FuentesPlataforma): DataChatTool {
  const fuente = "Bitácora del Copiloto, sin texto de preguntas ni respuestas (core.get_copiloto_uso_for_superadmin)";
  return herramienta({
    name: "uso_copiloto",
    label: "Uso del Copiloto",
    description: "Uso del Copiloto en todas las verticales y en plataforma: consultas, filas devueltas y costo (USD) por vertical, resultado y ruta.",
    params: { ...PERIOD_PARAMS },
    async run(ctx, args) {
      const p = periodoDe(ctx, args, fuente);
      if (!p.ok) return p.result;
      const r = await f.copilotoUso(p.period.fromDate, p.period.toDate);
      if (!r.ok) return sinDato(fuente, r.razon);
      const consultas = r.data.reduce((s, x) => s + x.consultas, 0);
      const costo = r.data.reduce((s, x) => s + x.costoMicroUsd, 0);
      return resultado(
        { source: `${cita("uso_copiloto", args)}: ${fuente}`, periodLabel: p.period.label, scopeLabel: SCOPE_PLATAFORMA, summary: `${consultas} registros de consulta y ${usd(costo)} USD de costo en el periodo.` },
        [col("vertical", "Vertical"), col("resultado", "Resultado"), col("ruta", "Ruta"), col("consultas", "Registros", "integer"), col("filas", "Filas devueltas", "integer"), col("costo_usd", "Costo (USD)", "decimal")],
        r.data.map((x) => ({ vertical: x.vertical, resultado: x.outcome, ruta: x.route, consultas: x.consultas, filas: x.filas, costo_usd: usd(x.costoMicroUsd) })),
        ctx.maxRows,
      );
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Herramientas financieras (Copiloto CFO)
// ---------------------------------------------------------------------------------------------------------------------------

const MES_PARAM: ParamsSpec = { mes: { type: "string", maxLength: 7, optional: true, description: "Mes AAAA-MM (no futuro); sin él, el mes en curso." } };

type MesResuelto = { readonly ok: true; readonly mes: string; readonly enCurso: boolean } | { readonly ok: false; readonly result: DataChatToolResult };

function resolverMes(ctx: DataChatToolContext, args: ParsedArgs, source: string): MesResuelto {
  const actual = hoy(ctx).slice(0, 7); // zona de la plataforma, igual que las herramientas operativas
  const raw = args["mes"];
  const mes = typeof raw === "string" && raw !== "" ? raw : actual;
  if (!MES_RE.test(mes)) return { ok: false, result: falla("needs_clarification", "El mes debe tener formato AAAA-MM (por ejemplo 2026-09).", source) };
  if (mes > actual) return { ok: false, result: falla("needs_clarification", "Ese mes todavía no ocurre; indica el mes en curso o uno anterior.", source) };
  return { ok: true, mes, enCurso: mes === actual };
}

/** Una herramienta financiera: exige step-up (o la politica vigente) y deja SIEMPRE una fila en core.cfo_access_log antes de leer. */
function herramientaCfo(f: FuentesPlataforma, scope: PlatformScope, def: DefHerramienta): DataChatTool {
  return herramienta({
    ...def,
    async run(ctx, args) {
      const filtros: Record<string, unknown> = { herramienta: def.name, _ruta: "/superadmin/copiloto" };
      for (const [k, v] of Object.entries(args)) if (v !== undefined) filtros[k] = typeof v === "string" ? v.slice(0, 40) : v;
      if (!scope.stepUp) {
        await f.registrarAccesoCfo("denegado", `copiloto/${def.name} (sin step-up)`, filtros);
        return falla("unavailable", "No tengo el dato: las consultas financieras exigen verificar tu código MFA (step-up) y no hay una verificación vigente. Verifica y vuelve a preguntar.", cita(def.name, args));
      }
      const huella = await f.registrarAccesoCfo("consulta", `copiloto/${def.name}`, filtros);
      if (huella === "error") return falla("unavailable", "No tengo el dato: no pude registrar la consulta financiera en la bitácora y, por seguridad, no se ejecuta.", cita(def.name, args));
      return def.run(ctx, args);
    },
  });
}

function mrr(f: FuentesPlataforma, scope: PlatformScope): DataChatTool {
  const fuente = "MRR esperado según el plan asignado de las organizaciones activas (no es lo cobrado por Stripe), en MXN";
  return herramientaCfo(f, scope, {
    name: "mrr",
    label: "MRR y ARR",
    description: "Ingreso recurrente mensual (MRR) y anual (ARR) por vertical, con clientes que aportan y clientes sin precio. Solo consulta financiera.",
    params: MES_PARAM,
    async run(ctx, args) {
      const m = resolverMes(ctx, args, fuente);
      if (!m.ok) return m.result;
      const source = `${cita("mrr", args)}: ${fuente}`;
      if (m.enCurso) {
        const r = await f.cfoFilas(m.mes);
        if (!r.ok) return sinDato(source, r.razon);
        const fx = tipoCambioDeFilas(r.data);
        const ing = calcularIngresos(construirFilasCfo(r.data, { umbralMargenPct: UMBRAL_MARGEN_PCT_DEFAULT, mxnPorUsd: fx?.mxnPorUsd ?? null }));
        const filas = [...ing.porVertical.map((v) => ({ vertical: v.vertical, mrr_mxn: v.mrrMxn, clientes: v.clientes, sin_precio: v.sinPrecio })), { vertical: "Total", mrr_mxn: ing.mrrMxn, clientes: ing.clientesConIngreso, sin_precio: ing.clientesSinPrecio }];
        return resultado(
          { source, periodLabel: `mes en curso (${m.mes})`, scopeLabel: SCOPE_PLATAFORMA, summary: `MRR de ${m.mes}: ${formatMxn(ing.mrrMxn)} (ARR ${formatMxn(ing.arrMxn)}); ${ing.clientesConIngreso} clientes aportan y ${ing.clientesSinPrecio} no tienen precio.`, chart: { kind: "bar", x: "vertical", y: "mrr_mxn" } },
          [col("vertical", "Vertical"), col("mrr_mxn", "MRR (MXN)", "mxn"), col("clientes", "Clientes con ingreso", "integer"), col("sin_precio", "Sin precio", "integer")],
          filas,
          ctx.maxRows,
        );
      }
      // Mes cerrado: la foto mensual guardada (no el plan de hoy).
      const r = await f.cfoFotos(`${m.mes}-01`, `${m.mes}-01`);
      if (!r.ok) return sinDato(source, r.razon);
      const delMes: readonly BillingSnapshotRow[] = r.data.filter((s) => s.mes.slice(0, 7) === m.mes);
      if (delMes.length === 0) return falla("unavailable", `No tengo el dato: no hay foto mensual de ingreso guardada para ${m.mes}.`, source);
      const porVertical = new Map<string, { centavos: number; clientes: number; sinPrecio: number }>();
      for (const s of delMes.filter((x) => x.orgStatus === "active")) {
        const a = porVertical.get(s.vertical) ?? { centavos: 0, clientes: 0, sinPrecio: 0 };
        if (s.mrrCentavos === null) a.sinPrecio += 1;
        else if (aportaMrr(s.orgStatus, s.billingStatus, s.mrrCentavos)) {
          a.centavos += s.mrrCentavos;
          a.clientes += 1;
        }
        porVertical.set(s.vertical, a);
      }
      const verticales = [...porVertical.entries()].sort((a, b) => b[1].centavos - a[1].centavos || a[0].localeCompare(b[0]));
      const totalCentavos = verticales.reduce((s, [, v]) => s + v.centavos, 0);
      const totalClientes = verticales.reduce((s, [, v]) => s + v.clientes, 0);
      const totalSin = verticales.reduce((s, [, v]) => s + v.sinPrecio, 0);
      const filas = [...verticales.map(([vertical, v]) => ({ vertical, mrr_mxn: mxnDeCentavos(v.centavos), clientes: v.clientes, sin_precio: v.sinPrecio })), { vertical: "Total", mrr_mxn: mxnDeCentavos(totalCentavos), clientes: totalClientes, sin_precio: totalSin }];
      return resultado(
        { source: `${source}. Mes cerrado: foto mensual guardada`, periodLabel: m.mes, scopeLabel: SCOPE_PLATAFORMA, summary: `MRR de ${m.mes}: ${formatMxn(mxnDeCentavos(totalCentavos))} (ARR ${formatMxn(mxnDeCentavos(totalCentavos) * 12)}).` },
        [col("vertical", "Vertical"), col("mrr_mxn", "MRR (MXN)", "mxn"), col("clientes", "Clientes con ingreso", "integer"), col("sin_precio", "Sin precio", "integer")],
        filas,
        ctx.maxRows,
      );
    },
  });
}

function margenCostosUnitarios(f: FuentesPlataforma, scope: PlatformScope): DataChatTool {
  const fuente = "Reporte de costo y margen por organización (core.get_cost_margin_report_for_superadmin): ingreso esperado según el plan vigente menos el costo real del mes; costos unitarios con eventos del mes";
  return herramientaCfo(f, scope, {
    name: "margen_costos_unitarios",
    label: "Margen y costos unitarios",
    description: "Por organización: ingreso esperado, costo del mes, margen en MXN y porcentaje, costo de IA por mensaje y costo de voz por minuto. Primero las de mayor pérdida o menor margen. Solo consulta financiera.",
    params: MES_PARAM,
    async run(ctx, args) {
      const m = resolverMes(ctx, args, fuente);
      if (!m.ok) return m.result;
      const source = `${cita("margen_costos_unitarios", args)}: ${fuente}`;
      const r = await f.cfoFilas(m.mes);
      if (!r.ok) return sinDato(source, r.razon);
      const fx = tipoCambioDeFilas(r.data);
      const filas = construirFilasCfo(r.data, { umbralMargenPct: UMBRAL_MARGEN_PCT_DEFAULT, mxnPorUsd: fx?.mxnPorUsd ?? null }).map((x) => x.fila);
      // Primero la mayor perdida (margen en MXN mas bajo); las organizaciones sin margen calculable (sin plan, precio o tipo de cambio) al final.
      const ordenadas = [...filas].sort((a, b) => (a.margenMxn ?? Number.POSITIVE_INFINITY) - (b.margenMxn ?? Number.POSITIVE_INFINITY) || a.nombre.localeCompare(b.nombre));
      const bajoUmbral = filas.filter((x) => x.margenPct !== null && x.margenPct < UMBRAL_MARGEN_PCT_DEFAULT).length;
      return resultado(
        {
          source: `${source}${fx ? "" : ". Sin tipo de cambio configurado: costos y márgenes en MXN sin dato"}`,
          periodLabel: m.enCurso ? `mes en curso (${m.mes})` : m.mes,
          scopeLabel: SCOPE_PLATAFORMA,
          summary: `${filas.length} organizaciones; ${bajoUmbral} con margen menor a ${UMBRAL_MARGEN_PCT_DEFAULT}%.`,
        },
        [
          col("organizacion", "Organización"),
          col("vertical", "Vertical"),
          col("ingreso_mxn", "Ingreso esperado (MXN)", "mxn"),
          col("costo_mxn", "Costo del mes (MXN)", "mxn"),
          col("margen_mxn", "Margen (MXN)", "mxn"),
          col("margen_pct", "Margen", "percent"),
          col("llm_por_mensaje_usd", "IA por mensaje (USD)", "decimal"),
          col("voz_por_minuto_usd", "Voz por minuto (USD)", "decimal"),
        ],
        ordenadas.map((x) => ({
          organizacion: texto(x.nombre),
          vertical: x.vertical,
          ingreso_mxn: x.ingresoMxn,
          costo_mxn: x.costoMxn,
          margen_mxn: x.margenMxn,
          margen_pct: x.margenPct === null ? null : pct1(x.margenPct),
          llm_por_mensaje_usd: x.mensajes > 0 ? Math.round((x.costoMicroUsd.llm / MICRO / x.mensajes) * 1e6) / 1e6 : null,
          voz_por_minuto_usd: x.minutosVoz > 0 ? Math.round((x.costoMicroUsd.voz / MICRO / x.minutosVoz) * 1e4) / 1e4 : null,
        })),
        ctx.maxRows,
      );
    },
  });
}

function pyl(f: FuentesPlataforma, scope: PlatformScope): DataChatTool {
  const fuente = "P&L por vertical: ingreso reconocido, costo directo (IA, voz, WhatsApp, telefonía), infraestructura prorrateada y márgenes, en MXN";
  return herramientaCfo(f, scope, {
    name: "pyl",
    label: "P&L por vertical",
    description: "Estado de resultados del mes por vertical: ingreso, costo directo, contribución, infraestructura y margen bruto, con el total. Solo consulta financiera.",
    params: MES_PARAM,
    async run(ctx, args) {
      const m = resolverMes(ctx, args, fuente);
      if (!m.ok) return m.result;
      const source = `${cita("pyl", args)}: ${fuente}`;
      const [filas, fotos, infra] = await Promise.all([f.cfoFilas(m.mes), m.enCurso ? Promise.resolve({ ok: true as const, data: [] as readonly BillingSnapshotRow[] }) : f.cfoFotos(`${m.mes}-01`, `${m.mes}-01`), f.infra(`${m.mes}-01`, `${m.mes}-01`)]);
      if (!filas.ok) return sinDato(source, filas.razon);
      if (!fotos.ok) return sinDato(source, fotos.razon);
      const { pyl: p } = pylDelMes(m.mes, filas.data, fotos.data, infra.ok ? infraDelMes(infra.data, m.mes) : null, 0);
      const fila = (clave: string, a: (typeof p)["total"]): Record<string, string | number | null> => ({
        vertical: clave,
        ingreso_mxn: a.ingresoMxn,
        costo_directo_mxn: a.cogsDirectoMxn,
        contribucion_mxn: a.contribucionMxn,
        contribucion_pct: a.contribucionPct === null ? null : pct1(a.contribucionPct),
        infra_mxn: a.infraMxn,
        margen_bruto_mxn: a.margenBrutoMxn,
        margen_bruto_pct: a.margenBrutoPct === null ? null : pct1(a.margenBrutoPct),
      });
      const rows = [...p.porVertical.map((v) => fila(v.clave, v)), fila("Total", p.total)];
      const notas = [p.mxnPorUsd === null ? "sin tipo de cambio configurado" : null, p.infra.disponible ? null : "sin infraestructura capturada", infra.ok ? null : "infraestructura sin dato"].filter(Boolean).join("; ");
      return resultado(
        {
          source: `${source}${notas ? `. Sin dato: ${notas} (columna vacía = no tengo el dato)` : ""}`,
          periodLabel: m.enCurso ? `mes en curso (${m.mes})` : m.mes,
          scopeLabel: SCOPE_PLATAFORMA,
          summary: p.total.contribucionMxn === null ? `P&L de ${m.mes}: ingreso ${formatMxn(p.total.ingresoMxn)}; sin dato de costos.` : `P&L de ${m.mes}: ingreso ${formatMxn(p.total.ingresoMxn)}, contribución ${formatMxn(p.total.contribucionMxn)}.`,
          chart: { kind: "bar", x: "vertical", y: "ingreso_mxn" },
        },
        [
          col("vertical", "Vertical"),
          col("ingreso_mxn", "Ingreso (MXN)", "mxn"),
          col("costo_directo_mxn", "Costo directo (MXN)", "mxn"),
          col("contribucion_mxn", "Contribución (MXN)", "mxn"),
          col("contribucion_pct", "Contribución", "percent"),
          col("infra_mxn", "Infraestructura (MXN)", "mxn"),
          col("margen_bruto_mxn", "Margen bruto (MXN)", "mxn"),
          col("margen_bruto_pct", "Margen bruto", "percent"),
        ],
        rows,
        ctx.maxRows,
      );
    },
  });
}

function contratosPorVencer(f: FuentesPlataforma, scope: PlatformScope): DataChatTool {
  const fuente = "Contratos por cliente: versión vigente de cada contrato con fecha de fin (core.list_customer_contracts_for_superadmin)";
  return herramientaCfo(f, scope, {
    name: "contratos_por_vencer",
    label: "Contratos por vencer",
    description: "Contratos de clientes cuya vigencia termina dentro de los próximos días indicados (por defecto 60), con organización, fecha de fin y base mensual. Solo consulta financiera.",
    params: { dias: { type: "integer", min: 1, max: 365, optional: true, description: "Ventana en días desde hoy; sin él, 60." } },
    async run(ctx, args) {
      const dias = typeof args["dias"] === "number" ? args["dias"] : 60;
      const source = `${cita("contratos_por_vencer", { ...args, dias })}: ${fuente}`;
      const r = await f.contratos();
      if (!r.ok) return sinDato(source, r.razon);
      const h = hoy(ctx);
      const limite = sumarDias(h, dias);
      // La version mas reciente de cada contrato es la vigente.
      const ultima = new Map<string, (typeof r.data)[number]>();
      for (const v of r.data) {
        const a = ultima.get(v.contractId);
        if (!a || v.version > a.version) ultima.set(v.contractId, v);
      }
      const porVencer = [...ultima.values()].filter((v) => v.vigenteHasta !== null && v.vigenteHasta >= h && v.vigenteHasta <= limite).sort((a, b) => (a.vigenteHasta ?? "").localeCompare(b.vigenteHasta ?? ""));
      const diasRestantes = (hasta: string): number => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${h}T00:00:00Z`)) / 86_400_000);
      return resultado(
        { source, periodLabel: `del ${h} al ${limite}`, scopeLabel: SCOPE_PLATAFORMA, summary: `${porVencer.length} contratos vencen en los próximos ${dias} días.` },
        [col("organizacion", "Organización"), col("vigente_hasta", "Vigente hasta"), col("dias_restantes", "Días restantes", "integer"), col("base_mxn", "Base mensual (MXN)", "mxn"), col("version", "Versión", "integer")],
        porVencer.map((v) => ({ organizacion: texto(v.organizationName ?? ""), vigente_hasta: v.vigenteHasta, dias_restantes: diasRestantes(v.vigenteHasta as string), base_mxn: mxnDeCentavos(v.baseCentavos), version: v.version })),
        ctx.maxRows,
      );
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Catalogo
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * Catalogo del turno, segun el rol: `finanzas` SOLO ve las herramientas financieras; el superadmin completo ve las operativas y las financieras
 * (estas ultimas rechazan el turno sin step-up y dejan huella). `vertical` = 'plataforma'.
 */
export function buildCatalogoPlataforma(fuentes: FuentesPlataforma, scope: PlatformScope, opciones: OpcionesCatalogoPlataforma = {}): DataChatCatalog {
  const financieras = [mrr(fuentes, scope), margenCostosUnitarios(fuentes, scope), pyl(fuentes, scope), contratosPorVencer(fuentes, scope)];
  const operativas = [
    organizaciones(fuentes),
    costosIa(fuentes),
    consumoVsTope(fuentes, opciones),
    usoPorVertical(fuentes),
    agentesInterruptores(fuentes),
    ultimasCorridas(fuentes),
    errores(fuentes),
    saludColas(fuentes),
    planesYTopes(fuentes),
    eventosSeguridad(fuentes),
    prospectos(fuentes),
    usoCopiloto(fuentes),
  ];
  const tools = scope.rol === "finanzas" ? financieras : [...operativas, ...financieras];
  return {
    vertical: "plataforma",
    domain:
      scope.rol === "finanzas"
        ? "la plataforma Atiende, rol finanzas de solo lectura (únicamente consultas financieras: MRR, márgenes, P&L y contratos)"
        : "la plataforma Atiende, vista de superadmin (organizaciones, costos de IA, salud operativa, planes, seguridad y finanzas de todos los clientes)",
    tools,
    outOfCatalogMessage: MENSAJE_FUERA_DE_CATALOGO,
    async describeScope() {
      return scope.rol === "finanzas"
        ? "Rol finanzas (solo lectura): únicamente consultas financieras de la plataforma completa. Ingresos, costos y márgenes en MXN."
        : "Plataforma completa (superadmin). Costos de IA en USD; ingresos, costos y márgenes del CFO en MXN. Las consultas financieras exigen step-up.";
    },
  };
}
