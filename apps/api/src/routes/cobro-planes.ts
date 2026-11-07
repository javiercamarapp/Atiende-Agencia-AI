// Cobro por plan MEDIDO (packages/db/migrations/0080_cobro_planes_medidos.sql + restaurantes 200_uso_facturable.sql):
//   GET  /superadmin/planes/tarifas            tarifa de todos los planes del catalogo (superadmin, zona CFO de lectura)
//   PUT  /superadmin/planes/:id/tarifa          fija la tarifa medida de un plan (superadmin + step-up MFA, bitacora en la base)
//   GET  /billing/plan-medido[?organizationId=&mes=YYYY-MM]
//        tarifa vigente, uso del mes contra lo incluido y factura ESTIMADA (subtotal, IVA, total) de la organizacion:
//        miembro de la organizacion o superadmin (otra organizacion -> 403, la decide la base).
//
// Ningun precio vive aqui: la tarifa es dato de core.plan y el calculo es `@atiende/billing::calcularFacturaPlanMedido`.
// La API habla en PESOS (hasta 2 decimales) para montos y en enteros para minutos/conversaciones; la base guarda centavos.
// Base sin migrar -> `disponible: false` (GET) o 503 (PUT), nunca 500.
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { calcularFacturaPlanMedido, TarifaInvalida, type FacturaPlanMedido } from "@atiende/billing";
import type { TarifaPlanInput, TarifaPlanRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import { readJsonCapped, requestActor } from "../http-security.ts";
import { traducirErrorSeguridad } from "./superadmin-mfa.ts";
import type { AppDeps } from "../deps.ts";

const NO_DISPONIBLE = "El cobro por plan medido todavía no está disponible en este despliegue (faltan las migraciones 0080_cobro_planes_medidos y restaurantes 200_uso_facturable).";
const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MES_RE = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const MUTACION_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;
const MAX_TARIFA_BODY_BYTES = 4 * 1024;

const pesos = (centavos: number | null): number | null => (centavos === null ? null : centavos / 100);

export function serializarTarifa(t: TarifaPlanRow) {
  return {
    planId: t.planId,
    nombre: t.nombre,
    vertical: t.vertical,
    activo: t.activo,
    modeloCobro: t.modeloCobro,
    cuotaFijaMxn: pesos(t.cuotaFijaCentavos),
    precioSucursalMxn: pesos(t.precioSucursalCentavos),
    sucursalesIncluidas: t.sucursalesIncluidas,
    minutosVozIncluidos: t.minutosVozIncluidos,
    minutosVozIncluidosPorSucursal: t.minutosVozIncluidosPorSucursal,
    precioMinutoVozExcedenteMxn: pesos(t.precioMinutoVozExcedenteCentavos),
    conversacionesWaIncluidas: t.conversacionesWaIncluidas,
    conversacionesWaIncluidasPorSucursal: t.conversacionesWaIncluidasPorSucursal,
    precioConversacionWaExcedenteMxn: pesos(t.precioConversacionWaExcedenteCentavos),
    usoJustoPct: t.usoJustoPct,
    cuotaAltaMxn: pesos(t.cuotaAltaCentavos),
    tasaIvaPct: t.tasaIvaBp / 100,
    organizacionExclusivaId: t.organizacionExclusivaId,
    cuotaAltaPorSucursalMxn: pesos(t.cuotaAltaPorSucursalCentavos),
    margenMinimoPct: t.margenMinimoPct,
    tramosSucursal: t.tramosSucursal.map((tr) => ({ desde: tr.desde, hasta: tr.hasta, precioMxn: pesos(tr.precioCentavos), minutosVozIncluidosPorSucursal: tr.minutosVozIncluidosPorSucursal, conversacionesWaIncluidasPorSucursal: tr.conversacionesWaIncluidasPorSucursal })),
    bandasUso: t.bandasUso.map((b) => ({ metrica: b.metrica, desde: b.desde, hasta: b.hasta, precioMxn: pesos(b.precioCentavos), costoUnitarioMxn: b.costoUnitarioMxn })),
  };
}

export function serializarFactura(f: FacturaPlanMedido) {
  return {
    renglones: f.renglones.map((r) => ({ concepto: r.concepto, descripcion: r.descripcion, cantidad: r.cantidad, precioUnitarioMxn: r.precioUnitarioCentavos / 100, importeMxn: r.importeCentavos / 100 })),
    subtotalMxn: f.subtotalCentavos / 100,
    ivaMxn: f.ivaCentavos / 100,
    totalMxn: f.totalCentavos / 100,
    tasaIvaPct: f.tasaIvaBp / 100,
    voz: f.voz,
    whatsapp: f.whatsapp,
    avisos: f.avisos,
  };
}

/** Pesos con hasta 2 decimales -> centavos; `null` -> null. Lanza 422 con el campo. */
function centavos(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000_000) throw Errors.validation(`${field} debe ser un monto en MXN >= 0 o null.`);
  const c = Math.round(value * 100);
  if (Math.abs(value * 100 - c) > 1e-6) throw Errors.validation(`${field} admite como máximo 2 decimales.`);
  return c;
}

function entero(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw Errors.validation(`${field} debe ser un entero entre ${min} y ${max}.`);
  return value;
}

/** Cuerpo de PUT /superadmin/planes/:id/tarifa -> claves de `core.superadmin_set_plan_tarifa`. Solo se mandan las presentes. */
export function parsearTarifa(raw: Record<string, unknown>): TarifaPlanInput {
  const out: { -readonly [K in keyof TarifaPlanInput]: TarifaPlanInput[K] } = {};
  const conocidas = new Set([
    "modeloCobro", "precioSucursalMxn", "sucursalesIncluidas", "minutosVozIncluidos", "minutosVozIncluidosPorSucursal", "precioMinutoVozExcedenteMxn",
    "conversacionesWaIncluidas", "conversacionesWaIncluidasPorSucursal", "precioConversacionWaExcedenteMxn", "usoJustoPct", "cuotaAltaMxn", "tasaIvaPct", "organizacionExclusivaId",
  ]);
  for (const k of Object.keys(raw)) if (!conocidas.has(k)) throw Errors.validation(`Campo desconocido: ${k}.`);
  if ("modeloCobro" in raw) {
    if (raw.modeloCobro !== "medido" && raw.modeloCobro !== "por_asiento") throw Errors.validation("modeloCobro debe ser medido o por_asiento.");
    out.modeloCobro = raw.modeloCobro;
  }
  if ("precioSucursalMxn" in raw) out.precioSucursalCentavos = centavos(raw.precioSucursalMxn, "precioSucursalMxn");
  if ("precioMinutoVozExcedenteMxn" in raw) out.precioMinutoVozExcedenteCentavos = centavos(raw.precioMinutoVozExcedenteMxn, "precioMinutoVozExcedenteMxn");
  if ("precioConversacionWaExcedenteMxn" in raw) out.precioConversacionWaExcedenteCentavos = centavos(raw.precioConversacionWaExcedenteMxn, "precioConversacionWaExcedenteMxn");
  if ("cuotaAltaMxn" in raw) out.cuotaAltaCentavos = centavos(raw.cuotaAltaMxn, "cuotaAltaMxn");
  if ("sucursalesIncluidas" in raw) out.sucursalesIncluidas = entero(raw.sucursalesIncluidas, "sucursalesIncluidas", 0, 10_000);
  if ("minutosVozIncluidos" in raw) out.minutosVozIncluidos = entero(raw.minutosVozIncluidos, "minutosVozIncluidos", 0, 100_000_000);
  if ("minutosVozIncluidosPorSucursal" in raw) out.minutosVozIncluidosPorSucursal = entero(raw.minutosVozIncluidosPorSucursal, "minutosVozIncluidosPorSucursal", 0, 1_000_000);
  if ("conversacionesWaIncluidas" in raw) out.conversacionesWaIncluidas = entero(raw.conversacionesWaIncluidas, "conversacionesWaIncluidas", 0, 100_000_000);
  if ("conversacionesWaIncluidasPorSucursal" in raw) out.conversacionesWaIncluidasPorSucursal = entero(raw.conversacionesWaIncluidasPorSucursal, "conversacionesWaIncluidasPorSucursal", 0, 1_000_000);
  if ("usoJustoPct" in raw) out.usoJustoPct = raw.usoJustoPct === null ? null : entero(raw.usoJustoPct, "usoJustoPct", 100, 1000);
  if ("tasaIvaPct" in raw) {
    const pct = raw.tasaIvaPct;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) throw Errors.validation("tasaIvaPct debe estar entre 0 y 100.");
    const bp = Math.round(pct * 100);
    if (Math.abs(pct * 100 - bp) > 1e-6) throw Errors.validation("tasaIvaPct admite como máximo 2 decimales.");
    out.tasaIvaBp = bp;
  }
  if ("organizacionExclusivaId" in raw) {
    const v = raw.organizacionExclusivaId;
    if (v !== null && (typeof v !== "string" || !UUID_RE.test(v))) throw Errors.validation("organizacionExclusivaId debe ser un UUID o null.");
    out.organizacionExclusivaId = v as string | null;
  }
  if (Object.keys(out).length === 0) throw Errors.validation("No hay ningún campo de tarifa que cambiar.");
  return out;
}

/** Mes actual en la zona del negocio (`YYYY-MM-01`). */
export function mesActualEn(zonaHoraria: string, ahora = new Date()): string {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: zonaHoraria, year: "numeric", month: "2-digit" }).formatToParts(ahora);
  const y = partes.find((p) => p.type === "year")?.value;
  const m = partes.find((p) => p.type === "month")?.value;
  return `${y}-${m}-01`;
}

export function cobroPlanesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.get("/superadmin/planes/tarifas", async (c) => {
    if (!deps.cobroPlanesRepo) return c.json({ disponible: false, motivo: NO_DISPONIBLE, tarifas: [] });
    const repo = deps.cobroPlanesRepo;
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).listTarifas(callerId));
    if (r.availability === "not_migrated") return c.json({ disponible: false, motivo: NO_DISPONIBLE, tarifas: [] });
    return c.json({ disponible: true, tarifas: r.tarifas.map(serializarTarifa) });
  });

  app.put("/superadmin/planes/:id/tarifa", async (c) => {
    if (!deps.cobroPlanesRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.cobroPlanesRepo;
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:planes-tarifa:${requestActor(c.req.raw, callerId)}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados cambios de tarifa en poco tiempo.");
    const planId = c.req.param("id");
    if (!PLAN_ID_RE.test(planId)) throw Errors.validation("id de plan inválido.");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_TARIFA_BODY_BYTES);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw Errors.validation("Se esperaba un objeto con la tarifa.");
    const tarifa = parsearTarifa(raw);
    try {
      const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).setTarifa(callerId, planId, tarifa));
      if (r.availability === "not_migrated" || !r.tarifa) throw Errors.serviceUnavailable(NO_DISPONIBLE);
      return c.json({ ok: true, tarifa: serializarTarifa(r.tarifa) });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  app.use("/billing/plan-medido", authMiddleware(deps.env));
  app.get("/billing/plan-medido", async (c) => {
    const callerId = c.get("userId");
    const queryOrg = c.req.query("organizationId");
    if (queryOrg !== undefined && !UUID_RE.test(queryOrg)) throw Errors.validation("organizationId: se esperaba un UUID.");
    const organizationId = queryOrg ?? c.get("organizationId");
    if (!organizationId || !UUID_RE.test(organizationId)) throw Errors.validation("organizationId: indica la organización (query) o inicia sesión dentro de una.");
    const queryMes = c.req.query("mes");
    if (queryMes !== undefined && !MES_RE.test(queryMes)) throw Errors.validation("mes: se esperaba YYYY-MM.");
    if (!deps.cobroPlanesRepo) return c.json({ disponible: false, motivo: NO_DISPONIBLE });
    const repo = deps.cobroPlanesRepo;

    const lectura = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
      const r = repo(db);
      const t = await r.tarifaDeOrganizacion(callerId, organizationId);
      if (t.availability === "not_migrated" || !t.tarifa) return { t, u: null };
      const mes = queryMes ? `${queryMes}-01` : mesActualEn(t.tarifa.zonaHoraria);
      const u = t.tarifa.vertical === "restaurantes" ? await r.usoFacturableRestaurantes(callerId, organizationId, mes) : null;
      return { t, u, mes };
    });
    if (lectura.t.availability === "not_migrated") return c.json({ disponible: false, motivo: NO_DISPONIBLE });
    if (!lectura.t.tarifa) throw Errors.forbidden("No perteneces a esta organización.");
    const tarifa = lectura.t.tarifa;
    const base = { disponible: true, organizationId, vertical: tarifa.vertical, sucursalesActivas: tarifa.sucursalesActivas, plan: tarifa.plan ? serializarTarifa(tarifa.plan) : null };
    if (!tarifa.plan || tarifa.plan.modeloCobro !== "medido") {
      return c.json({ ...base, uso: null, factura: null, motivo: tarifa.plan ? "El plan de esta organización no es medido." : "Esta organización todavía no tiene plan asignado." });
    }
    if (!lectura.u || lectura.u.availability === "not_migrated" || !lectura.u.uso) {
      return c.json({ ...base, uso: null, factura: null, motivo: tarifa.vertical === "restaurantes" ? NO_DISPONIBLE : "La medición de uso facturable de esta vertical todavía no existe." });
    }
    const uso = lectura.u.uso;
    try {
      const factura = calcularFacturaPlanMedido(tarifa.plan, { sucursalesActivas: tarifa.sucursalesActivas, minutosVoz: uso.minutosVoz, conversacionesWa: uso.conversacionesWa });
      return c.json({ ...base, uso, factura: serializarFactura(factura), estimada: true });
    } catch (err) {
      if (err instanceof TarifaInvalida) return c.json({ ...base, uso, factura: null, motivo: `La tarifa del plan está incompleta: ${err.message}` });
      throw err;
    }
  });

  return app;
}
