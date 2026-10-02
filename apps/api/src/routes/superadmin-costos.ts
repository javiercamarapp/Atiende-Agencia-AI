// Costo por evento por organizacion, margen y alertas de tope (SA-02, superadmin "CFO").
// Ver packages/db/migrations/0028_superadmin_costos_planes.sql y docs/SUPERADMIN_COSTOS_PLANES.md.
//
// El reporte une, por organizacion y mes: LLM (core.llm_usage_daily, la fuente que ya tiene
// tope y reserva) + eventos de voz/WhatsApp/telefonia/sms/email/storage
// (core.usage_cost_event) SIN doble conteo, lo compara contra el ingreso esperado del plan
// asignado y devuelve margen, alertas y consumo contra los limites del plan. Toda la
// aritmetica vive en @atiende/billing (cost-margin.ts, pura y con tests).
//
// REGLA DE LA CASA: nunca inventar una cifra. Sin tipo de cambio configurado, el costo en MXN y
// el margen son `null` (el costo en USD si se muestra); sin plan o con plan sin precio, el ingreso
// es `null` con su razon. Nada de esto cobra ni cambia nada: es solo lectura, salvo
// `PUT /superadmin/costos/tipo-cambio` (acepta step-up, ver superadmin-seguridad/step-up.ts).
//
// Base sin migrar (0028 sin aplicar): `disponible: false` con listas vacias en las lecturas y 503
// honesto en la escritura -- nunca un 500 ni un reporte inventado.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { calcularFilaCostoMargen, resumirCostoMargen, UMBRAL_MARGEN_PCT_DEFAULT } from "@atiende/billing";
import type { EntradaCostoMargen, FilaCostoMargen, LimitePlan } from "@atiende/billing";
import { listarUsoSuperadmin } from "@atiende/db";
import type { FxRateRow, PlanRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import { traducirErrorSeguridad } from "./superadmin-mfa.ts";
import type { AppDeps } from "../deps.ts";

const NO_DISPONIBLE = "El costo por evento y el margen todavía no están disponibles en este despliegue (falta aplicar la migración 0028_superadmin_costos_planes).";
const MUTACION_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;
const MES_RE = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RIESGO_ORDEN: Readonly<Record<FilaCostoMargen["riesgo"], number>> = { alto: 0, medio: 1, desconocido: 2, bajo: 3 };

/** `YYYY-MM` del mes en curso, en UTC (mismo criterio que `usage_date`/`current_date` del servidor de Postgres). */
function mesActualUtc(): string {
  return new Date().toISOString().slice(0, 7);
}

function parseMes(raw: string | undefined): string {
  if (raw === undefined || raw === "") return mesActualUtc();
  if (!MES_RE.test(raw)) throw Errors.validation("mes debe tener formato YYYY-MM.");
  return raw;
}

function ultimoDiaDelMes(mes: string): string {
  const [y, m] = mes.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** El tipo de cambio vigente para un mes: el mas reciente con fecha <= fin de mes (o <= hoy en el mes en curso). */
export function elegirTipoCambio(rates: readonly FxRateRow[], mes: string, hoy: string = new Date().toISOString().slice(0, 10)): FxRateRow | null {
  const tope = mes === hoy.slice(0, 7) ? hoy : ultimoDiaDelMes(mes);
  const elegibles = rates.filter((r) => r.fecha <= tope).sort((a, b) => b.fecha.localeCompare(a.fecha));
  return elegibles[0] ?? null;
}

function limitesDe(plan: PlanRow | undefined): readonly LimitePlan[] {
  return (plan?.limites ?? []).map((l) => ({ metrica: l.metrica, limite: l.limite, accion: l.accion }));
}

export function superadminCostosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.get("/superadmin/costos/resumen", async (c) => {
    const mes = parseMes(c.req.query("mes"));
    const umbralRaw = c.req.query("umbralMargenPct");
    let umbral = UMBRAL_MARGEN_PCT_DEFAULT;
    if (umbralRaw !== undefined && umbralRaw !== "") {
      umbral = Number(umbralRaw);
      if (!Number.isFinite(umbral) || umbral < 0 || umbral > 100) throw Errors.validation("umbralMargenPct debe estar entre 0 y 100.");
    }
    if (!deps.costosPlanesRepo) return c.json({ disponible: false, mes, mensaje: NO_DISPONIBLE, organizaciones: [], resumen: null, tipoCambio: null, umbralMargenPct: umbral, supuestos: [] });
    const repo = deps.costosPlanesRepo;
    const callerId = c.get("userId");

    const { report, rates, plans } = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
      const r = repo(db);
      const report = await r.getReport(callerId, `${mes}-01`);
      const rates = await r.listFxRates(callerId, 120);
      const plans = await r.listPlans(callerId);
      return { report, rates, plans };
    });
    if (report.availability === "not_migrated") {
      return c.json({ disponible: false, mes, mensaje: NO_DISPONIBLE, organizaciones: [], resumen: null, tipoCambio: null, umbralMargenPct: umbral, supuestos: [] });
    }

    const planPorId = new Map(plans.plans.map((p) => [p.id, p]));
    const fx = elegirTipoCambio(rates.rates, mes);
    const filas = report.rows.map((r) => {
      const plan = r.planId ? planPorId.get(r.planId) : undefined;
      const entrada: EntradaCostoMargen = {
        organizationId: r.organizationId,
        nombre: r.organizationName,
        slug: r.organizationSlug,
        vertical: r.vertical,
        orgStatus: r.orgStatus,
        plan: r.planId
          ? { id: r.planId, nombre: r.planNombre ?? r.planId, precioBaseCentavos: r.precioBaseCentavos, precioAsientoCentavos: r.precioAsientoCentavos, asientosIncluidos: r.asientosIncluidos ?? 0 }
          : null,
        limites: limitesDe(plan),
        billingStatus: r.billingStatus,
        billingSeats: r.billingSeats,
        sucursalesActivas: r.sucursalesActivas,
        costo: { llm: r.llmMicroUsd, voz: r.vozMicroUsd, whatsapp: r.whatsappMicroUsd, telefonia: r.telefoniaMicroUsd, otros: r.otrosMicroUsd },
        eventosTotal: r.eventosTotal,
        eventosEstimados: r.eventosEstimados,
        minutosVoz: r.minutosVoz,
        mensajes: r.mensajes,
        llmCapMicroUsd: r.llmCapMicroUsd,
        llmAlertPct: r.llmAlertPct,
      };
      return calcularFilaCostoMargen(entrada, { mxnPorUsd: fx?.mxnPorUsd ?? null, umbralMargenPct: umbral });
    });
    filas.sort((a, b) => RIESGO_ORDEN[a.riesgo] - RIESGO_ORDEN[b.riesgo] || b.costoMicroUsd.total - a.costoMicroUsd.total || a.nombre.localeCompare(b.nombre));

    const supuestos = [
      "El LLM sale de core.llm_usage_daily; voz, WhatsApp, telefonia, SMS, correo y storage salen de core.usage_cost_event. Ningun evento se cuenta dos veces.",
      "El ingreso es el esperado segun el plan asignado (base + asientos facturables x precio por asiento), no lo cobrado por Stripe.",
      fx ? `Tipo de cambio ${fx.mxnPorUsd} MXN/USD del ${fx.fecha} (fuente: ${fx.fuente}).` : "No hay tipo de cambio configurado: el costo en MXN y el margen no se calculan hasta capturar uno.",
      "Los costos de voz, WhatsApp y telefonia son estimados hasta conciliarlos con la factura del proveedor.",
    ];
    return c.json({
      disponible: true,
      mes,
      tipoCambio: fx,
      umbralMargenPct: umbral,
      resumen: resumirCostoMargen(filas),
      organizaciones: filas,
      supuestos,
    });
  });

  app.get("/superadmin/costos/organizaciones/:id/eventos", async (c) => {
    const organizationId = c.req.param("id");
    if (!UUID_RE.test(organizationId)) throw Errors.validation("id de organización inválido.");
    const limitRaw = Number(c.req.query("limit") ?? 100);
    const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 500 ? limitRaw : 100;
    if (!deps.costosPlanesRepo) return c.json({ disponible: false, eventos: [] });
    const repo = deps.costosPlanesRepo;
    const callerId = c.get("userId");
    const { availability, events } = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).listEvents(callerId, organizationId, limit));
    return c.json({
      disponible: availability === "available",
      eventos: events.map((e) => ({
        id: e.id,
        sucursalId: e.propertyId,
        vertical: e.vertical,
        ocurrioEnMs: e.occurredAtMs,
        categoria: e.categoria,
        proveedor: e.proveedor,
        unidad: e.unidad,
        cantidad: e.cantidad,
        costoMicroUsd: e.costoMicroUsd,
        costoEstimado: e.costoEstimado,
        refTipo: e.refTipo,
        refId: e.refId,
      })),
    });
  });

  // Consumo de mensajes del mes por organizacion contra el tope de su plan (PL-16). Solo el DATO: la pantalla de consumo vs topes
  // es SA-10. Base sin la migracion 0045: `disponible: false` y lista vacia.
  app.get("/superadmin/costos/uso-mensajes", async (c) => {
    const callerId = c.get("userId");
    const limitRaw = c.req.query("limite");
    let limite = 200;
    if (limitRaw !== undefined && limitRaw !== "") {
      limite = Number(limitRaw);
      if (!Number.isInteger(limite) || limite < 1 || limite > 500) throw Errors.validation("limite debe ser un entero entre 1 y 500.");
    }
    try {
      const r = await deps.engine.withAppSession({ userId: callerId }, (db) => listarUsoSuperadmin(db, callerId, limite));
      return c.json(r.disponible ? { disponible: true, organizaciones: r.filas } : { disponible: false, organizaciones: [] });
    } catch (err) {
      if ((err as { code?: unknown })?.code === "42501") throw Errors.forbidden("Solo un superadmin de plataforma puede ver el consumo de todas las organizaciones.");
      throw err;
    }
  });

  app.get("/superadmin/costos/tipo-cambio", async (c) => {
    if (!deps.costosPlanesRepo) return c.json({ disponible: false, tiposDeCambio: [] });
    const repo = deps.costosPlanesRepo;
    const callerId = c.get("userId");
    const { availability, rates } = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).listFxRates(callerId, 60));
    return c.json({ disponible: availability === "available", tiposDeCambio: rates });
  });

  // Sensible (step-up): el tipo de cambio mueve todas las cifras en MXN del reporte.
  app.put("/superadmin/costos/tipo-cambio", async (c) => {
    if (!deps.costosPlanesRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.costosPlanesRepo;
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:costos-fx:${requestActor(c.req.raw, callerId)}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados cambios de tipo de cambio en poco tiempo.");

    const raw = (await c.req.json().catch(() => ({}))) as { fecha?: unknown; mxnPorUsd?: unknown; fuente?: unknown };
    const fecha = typeof raw.fecha === "string" ? raw.fecha : "";
    if (!FECHA_RE.test(fecha) || Number.isNaN(Date.parse(`${fecha}T00:00:00Z`))) throw Errors.validation("fecha debe tener formato YYYY-MM-DD.");
    if (typeof raw.mxnPorUsd !== "number" || !Number.isFinite(raw.mxnPorUsd) || raw.mxnPorUsd <= 0 || raw.mxnPorUsd >= 1000) throw Errors.validation("mxnPorUsd debe ser un número entre 0 (exclusivo) y 1000.");
    const fuente = typeof raw.fuente === "string" ? raw.fuente.trim() : "";
    if (fuente.length < 3 || fuente.length > 200) throw Errors.validation("fuente es obligatoria (3 a 200 caracteres), p. ej. «Banxico FIX».");

    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).setFxRate(callerId, fecha, raw.mxnPorUsd as number, fuente));
      if (result.availability === "not_migrated") throw Errors.serviceUnavailable(NO_DISPONIBLE);
      return c.json({ ok: true });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  return app;
}
