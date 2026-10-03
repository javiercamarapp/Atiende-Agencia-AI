// P&L por vertical y por cliente (SA-29, superadmin "CFO") con comparativo mes contra mes,
// movimiento de MRR por vertical (SA-05) y exportacion CSV.
// Ver packages/billing/src/pyl.ts (formulas y definiciones) y
// packages/db/migrations/0032_superadmin_pyl_infra.sql (infra compartida).
//
// No agrega lecturas de ingreso ni de costo: compone las del dashboard CFO (0030) --
// `getDashboardRows` por mes (costo del mes, plan, tipo de cambio) y `listSnapshots` (foto
// mensual de ingreso) -- mas la infraestructura capturada (0032). Un mes cerrado usa la foto de
// ingreso guardada; el mes en curso, el plan vigente.
//
// REGLA DE LA CASA: nunca inventar una cifra. Fuente faltante = null con su razon.
//
// Base sin migrar: 0030 sin aplicar -> `disponible: false` con mensaje (200, nunca 500);
// 0032 sin aplicar -> el P&L se calcula igual pero la infra sale "sin_infra_capturada" y la
// captura responde 503 honesto. Todas las lecturas corren bajo SAVEPOINT (ver los repositorios),
// asi que un SQLSTATE de migracion pendiente no aborta la transaccion de la sesion.
//
// Solo lectura salvo `PUT /superadmin/pyl/infra` (step-up, ver superadmin-seguridad/step-up.ts).
import { Hono } from "hono";
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { armarPyl, compararPyl, ingresoReconocidoFoto, ingresoReconocidoVivo, movimientoMrrPorVertical, pylACsv, snapshotDesdeFila } from "@atiende/billing";
import type { ComparativoPyl, EntradaPylOrg, FotoIngresoPyl, MovimientoMrrVertical, Pyl, SnapshotConVertical } from "@atiende/billing";
import type { BillingSnapshotRow, CfoOrgRow, InfraCostRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import { construirFilasCfo, tipoCambioDeFilas } from "../cfo/filas.ts";
import { traducirErrorSeguridad } from "./superadmin-mfa.ts";
import type { AppDeps } from "../deps.ts";

export const PYL_NO_DISPONIBLE = "El P&L por vertical y cliente todavía no está disponible en este despliegue (falta aplicar la migración 0030_superadmin_cfo_dashboard).";
export const INFRA_NO_DISPONIBLE = "La captura de infraestructura compartida todavía no está disponible en este despliegue (falta aplicar la migración 0032_superadmin_pyl_infra).";
const MES_RE = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const EXPORT_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;
const MUTACION_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;
const MAX_MONTO_MXN = 1_000_000_000;

function mesActualUtc(): string {
  return new Date().toISOString().slice(0, 7);
}

function mesAnterior(mes: string): string {
  const [y, m] = mes.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

function parseMes(raw: string | undefined): string {
  const mes = raw === undefined || raw === "" ? mesActualUtc() : raw;
  if (!MES_RE.test(mes)) throw Errors.validation("mes debe tener formato YYYY-MM.");
  if (mes > mesActualUtc()) throw Errors.validation("mes no puede ser futuro.");
  return mes;
}

function aFoto(s: BillingSnapshotRow): FotoIngresoPyl {
  return { organizationId: s.organizationId, orgStatus: s.orgStatus, billingStatus: s.billingStatus, mrrCentavos: s.mrrCentavos, mrrRazon: s.mrrRazon };
}

function costoDe(r: CfoOrgRow): EntradaPylOrg["costo"] {
  return { llm: r.llmMicroUsd, voz: r.vozMicroUsd, whatsapp: r.whatsappMicroUsd, telefonia: r.telefoniaMicroUsd, otros: r.otrosMicroUsd };
}

export type InfraEntrada = readonly { readonly concepto: string; readonly montoMxnCentavos: number }[] | null;

/** P&L de un mes: ingreso vivo (mes en curso) o de la foto guardada (mes cerrado). Exportado: lo reusa el Copiloto CFO (superadmin-copiloto/catalogo.ts). */
export function pylDelMes(mes: string, rows: readonly CfoOrgRow[], fotos: readonly BillingSnapshotRow[], infra: InfraEntrada, umbralMargenPct: number): { pyl: Pyl; fx: ReturnType<typeof tipoCambioDeFilas> } {
  const fx = tipoCambioDeFilas(rows);
  const enCurso = mes === mesActualUtc();
  let orgs: EntradaPylOrg[];
  if (enCurso) {
    const filas = construirFilasCfo(rows, { umbralMargenPct, mxnPorUsd: fx?.mxnPorUsd ?? null });
    orgs = filas.map((f, i) => ({
      organizationId: f.fila.organizationId,
      nombre: f.fila.nombre,
      vertical: f.fila.vertical,
      ...ingresoReconocidoVivo(f),
      costo: costoDe(rows[i] as CfoOrgRow),
    }));
  } else {
    const porOrg = new Map(fotos.filter((s) => s.mes.slice(0, 7) === mes).map((s) => [s.organizationId, aFoto(s)]));
    orgs = rows.map((r) => ({
      organizationId: r.organizationId,
      nombre: r.organizationName,
      vertical: r.vertical,
      ...ingresoReconocidoFoto(porOrg.get(r.organizationId)),
      costo: costoDe(r),
    }));
  }
  return { pyl: armarPyl({ mes, orgs, mxnPorUsd: fx?.mxnPorUsd ?? null, infra }), fx };
}

export function infraDelMes(costs: readonly InfraCostRow[], mes: string): InfraEntrada {
  const delMes = costs.filter((c) => c.mes.slice(0, 7) === mes);
  return delMes.length === 0 ? null : delMes.map((c) => ({ concepto: c.concepto, montoMxnCentavos: c.montoMxnCentavos }));
}

export type RespuestaPyl =
  | { readonly disponible: false; readonly mes: string; readonly mensaje: string }
  | {
      readonly disponible: true;
      readonly mes: string;
      readonly mesPrevio: string;
      readonly tipoCambio: ReturnType<typeof tipoCambioDeFilas>;
      readonly infraCapturaDisponible: boolean;
      readonly pyl: Pyl;
      readonly previo: Pyl;
      readonly comparativo: ComparativoPyl;
      readonly movimientoMrr: { readonly disponible: true; readonly porVertical: readonly MovimientoMrrVertical[] } | { readonly disponible: false; readonly razon: "sin_foto_previa" | "sin_foto_del_mes" };
      readonly supuestos: readonly string[];
    };

export function superadminPylRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  async function calcular(callerId: string, mes: string): Promise<RespuestaPyl> {
    if (!deps.cfoRepo) return { disponible: false, mes, mensaje: PYL_NO_DISPONIBLE };
    const cfo = deps.cfoRepo;
    const pylRepo = deps.pylRepo;
    const previo = mesAnterior(mes);
    const esMesEnCurso = mes === mesActualUtc();

    const datos = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
      const r = cfo(db);
      const actual = await r.getDashboardRows(callerId, `${mes}-01`);
      if (actual.availability === "not_migrated") return null;
      const prev = await r.getDashboardRows(callerId, `${previo}-01`);
      const fotos = await r.listSnapshots(callerId, `${previo}-01`, `${mes}-01`);
      const infra = pylRepo ? await pylRepo(db).listInfraCosts(callerId, `${previo}-01`, `${mes}-01`) : null;
      return { actual: actual.rows, prev: prev.rows, fotos: fotos.snapshots, infra };
    });
    if (datos === null) return { disponible: false, mes, mensaje: PYL_NO_DISPONIBLE };

    const costos = datos.infra !== null && datos.infra.availability === "available" ? datos.infra.costs : [];
    const a = pylDelMes(mes, datos.actual, datos.fotos, infraDelMes(costos, mes), 0);
    const p = pylDelMes(previo, datos.prev, datos.fotos, infraDelMes(costos, previo), 0);

    // Movimiento de MRR por vertical: la misma NRR del dashboard CFO, filtrada por vertical.
    const fotosPrevias: SnapshotConVertical[] = datos.fotos.filter((s) => s.mes.slice(0, 7) === previo).map((s) => ({ organizationId: s.organizationId, orgStatus: s.orgStatus, billingStatus: s.billingStatus, mrrCentavos: s.mrrCentavos, vertical: s.vertical }));
    const fotosActuales: SnapshotConVertical[] | null = esMesEnCurso
      ? construirFilasCfo(datos.actual, { umbralMargenPct: 0, mxnPorUsd: a.fx?.mxnPorUsd ?? null }).map((f) => ({ ...snapshotDesdeFila(f), vertical: f.fila.vertical }))
      : datos.fotos.filter((s) => s.mes.slice(0, 7) === mes).map((s) => ({ organizationId: s.organizationId, orgStatus: s.orgStatus, billingStatus: s.billingStatus, mrrCentavos: s.mrrCentavos, vertical: s.vertical }));
    const movimientoMrr: Extract<RespuestaPyl, { disponible: true }>["movimientoMrr"] =
      fotosActuales === null || fotosActuales.length === 0
        ? { disponible: false, razon: "sin_foto_del_mes" }
        : fotosPrevias.length === 0
          ? { disponible: false, razon: "sin_foto_previa" }
          : { disponible: true, porVertical: movimientoMrrPorVertical(fotosPrevias, fotosActuales) };

    const supuestos = [
      "Ingreso reconocido = ingreso esperado del mes según el plan asignado (base + asientos facturables x precio por asiento) de las organizaciones activas con suscripción no cancelada; no es lo cobrado por Stripe. Una organización inactiva o cancelada reconoce 0; una activa sin plan o con plan sin precio queda «sin ingreso» y NO entra a los márgenes.",
      "Mes en curso: plan vigente hoy. Mes cerrado: foto mensual de ingreso guardada por el cron de alertas CFO; sin foto, el ingreso del mes es «sin foto» (nunca 0).",
      "COGS directo = LLM (core.llm_usage_daily) + voz + WhatsApp + telefonía + otros (SMS, correo, storage; core.usage_cost_event), convertido con el tipo de cambio vigente de cada mes. Voz, WhatsApp y telefonía son estimados hasta conciliarlos con la factura del proveedor.",
      "Infra prorrateada = conceptos de infraestructura compartida capturados para el mes (Vercel, base de datos, etc.), repartidos entre las organizaciones en proporción a su COGS directo, en centavos exactos. Sin captura del mes no hay margen bruto, solo margen de contribución.",
      "Margen de contribución = ingreso - COGS directo. Margen bruto = ingreso - COGS directo - infra prorrateada. Los márgenes de un agregado solo cuentan organizaciones con ingreso conocido; el costo de las demás se muestra aparte.",
      "El movimiento de MRR (expansión, contracción, churn) usa la foto mensual del mes anterior; mientras no exista, sale «no disponible».",
      "Caja, cuentas por cobrar y pagos reales no tienen fuente en el modelo: el P&L es de devengo esperado, no de caja.",
    ];
    const infraCapturaDisponible = datos.infra !== null && datos.infra.availability === "available";
    return { disponible: true, mes, mesPrevio: previo, tipoCambio: a.fx, infraCapturaDisponible, pyl: a.pyl, previo: p.pyl, comparativo: compararPyl(a.pyl, p.pyl), movimientoMrr, supuestos };
  }

  app.get("/superadmin/pyl", async (c) => {
    const mes = parseMes(c.req.query("mes"));
    return c.json(await calcular(c.get("userId"), mes));
  });

  async function exportar(c: Context<CoreAuthHonoEnv>) {
    const mes = parseMes(c.req.query("mes"));
    const nivel = c.req.query("nivel") ?? "vertical";
    if (nivel !== "vertical" && nivel !== "cliente") throw Errors.validation("nivel debe ser vertical o cliente.");
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:pyl-export:${requestActor(c.req.raw, callerId)}`, EXPORT_RATE_LIMIT.max, EXPORT_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiadas exportaciones en poco tiempo.");
    const r = await calcular(callerId, mes);
    if (!r.disponible) throw Errors.serviceUnavailable(r.mensaje);
    return new Response(pylACsv(r.pyl, nivel), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="pyl-${nivel}-${mes}.csv"`,
        "cache-control": "no-store",
      },
    });
  }
  app.get("/superadmin/pyl/export.csv", exportar);

  // Sensible (step-up): la infraestructura capturada mueve el margen bruto de todas las organizaciones.
  app.put("/superadmin/pyl/infra", async (c) => {
    if (!deps.pylRepo) throw Errors.serviceUnavailable(INFRA_NO_DISPONIBLE);
    const repo = deps.pylRepo;
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:pyl-infra:${requestActor(c.req.raw, callerId)}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados cambios de infraestructura en poco tiempo.");

    const raw = (await c.req.json().catch(() => ({}))) as { mes?: unknown; concepto?: unknown; montoMxn?: unknown; nota?: unknown };
    const mes = typeof raw.mes === "string" ? raw.mes : "";
    if (!MES_RE.test(mes) || mes > mesActualUtc()) throw Errors.validation("mes debe tener formato YYYY-MM y no puede ser futuro.");
    const concepto = typeof raw.concepto === "string" ? raw.concepto.trim() : "";
    if (concepto.length < 2 || concepto.length > 80) throw Errors.validation("concepto es obligatorio (2 a 80 caracteres), p. ej. «Vercel».");
    if (typeof raw.montoMxn !== "number" || !Number.isFinite(raw.montoMxn) || raw.montoMxn < 0 || raw.montoMxn > MAX_MONTO_MXN) throw Errors.validation("montoMxn debe ser un número entre 0 y 1,000,000,000.");
    const centavos = Math.round(raw.montoMxn * 100);
    if (Math.abs(raw.montoMxn * 100 - centavos) > 1e-6) throw Errors.validation("montoMxn admite como máximo 2 decimales.");
    let nota: string | null = null;
    if (raw.nota !== undefined && raw.nota !== null) {
      if (typeof raw.nota !== "string" || raw.nota.trim().length > 300) throw Errors.validation("nota debe ser texto de máximo 300 caracteres.");
      nota = raw.nota.trim() === "" ? null : raw.nota.trim();
    }

    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).setInfraCost(callerId, `${mes}-01`, concepto, centavos, nota));
      if (result.availability === "not_migrated") throw Errors.serviceUnavailable(INFRA_NO_DISPONIBLE);
      return c.json({ ok: true });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  return app;
}
