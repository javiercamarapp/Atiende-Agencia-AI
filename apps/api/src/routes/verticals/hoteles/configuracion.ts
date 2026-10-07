// H-P3-04 (P1) -- configuracion del hotel desde el panel, sin SQL: impuestos (IVA/ISH/DSA/umbral de descuento), politica de cancelacion,
// sobreventa por tipo de habitacion, y listar/editar tarifas por noche. Cada escritura pasa por una funcion `hoteles.set_*` de la
// migracion 047 (owner/gm de ESA property, valida rangos, deja valor anterior y nuevo en `hoteles.config_audit_log`); aqui se valida
// primero para devolver 400 claros, y la RLS/funcion sigue siendo la autoridad. Lectura: owner/gm/accountant.
//
// Compatibilidad con la base sin migrar: las lecturas devuelven los valores por omision con `configurado: false` (o una lista vacia);
// las escrituras responden 503 "migracion pendiente", nunca un 500 (ver `HotelConfigUnavailableError`).
//
// Autopilot: una tarifa editada a mano con PUT .../tarifas/:id queda marcada (`manualPriceAt`) y la aplicacion AUTOMATICA del motor de
// revenue no la sobreescribe (`hoteles.system_apply_rate_recommendation` rechaza con `tarifa_manual_vigente` una recomendacion
// 'pendiente'; el cron cuenta y avisa ese rechazo). El alta de rango (POST .../tarifas) no marca, y una recomendacion 'aprobada' por una
// persona se aplica y limpia la marca. PUT .../tarifas/:id es idempotente de forma natural (un precio absoluto; repetir el mismo valor
// no reescribe la fila ni duplica la bitacora): por decision, sin cabecera Idempotency-Key.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { emitirNotificacion } from "@atiende/db";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { ADMIN_ROLES, HotelConfigUnavailableError, type HotelRole } from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

/** Lectura de configuracion: owner/gm y contabilidad (el contador revisa impuestos y politicas, no los cambia). */
export const CONFIG_READ_ROLES: readonly HotelRole[] = ["owner", "gm", "accountant"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TARIFAS = 1000;
const MAX_RANGO_TARIFAS_DIAS = 366;
const AVISO_ISH = "La tasa del ISH depende del estado y del municipio: verifícala con tu contador antes de guardarla.";

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);
}

function rate01(value: unknown, campo: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw Errors.validation(`${campo} debe ser un número entre 0 y 1 (ej. 0.16 para 16 %).`);
  }
  return value;
}

function nonNegative(value: unknown, campo: string, max = 1_000_000_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) throw Errors.validation(`${campo} debe ser un número mayor o igual a 0.`);
  return value;
}

/** Traduce el rechazo real de las funciones `hoteles.set_*` (prefijo estable del mensaje) a un HTTP claro; lo demas se repropaga. */
function translateConfigError(err: unknown): never {
  if (err instanceof HotelConfigUnavailableError) throw Errors.serviceUnavailable(`${err.message} No disponible aún: requiere aplicar la migración de configuración del hotel.`);
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("configuracion_requiere_owner_gm")) throw Errors.forbidden(message);
  if (/^(impuestos_invalidos|politica_invalida|sobreventa_invalida|tarifa_invalida)/.test(message)) throw Errors.validation(message);
  throw err;
}

/** Aviso in-app (hoteles.configuracion.cambiada) de un cambio de configuracion sensible. Best-effort: nunca revierte lo guardado. Solo nombra el area. */
async function avisarCambio(c: Context<CoreAuthHonoEnv>, area: "impuestos" | "cancelacion" | "sobreventa" | "tarifas"): Promise<void> {
  const propertyId = c.req.param("propertyId") ?? "";
  try {
    await emitirNotificacion(c.get("db"), {
      evento: "hoteles.configuracion.cambiada",
      organizationId: c.get("organizationId"),
      propertyId,
      clave: `${propertyId}:${area}:${new Date().toISOString().slice(0, 10)}`,
      parametros: { area },
    });
  } catch (err) {
    console.error("hoteles/configuracion: aviso de cambio no emitido:", err);
  }
}

interface ImpuestosBody {
  readonly ivaRate?: unknown;
  readonly ishRate?: unknown;
  readonly discountThreshold?: unknown;
  readonly dsaPerNight?: unknown;
}
interface PoliticaBody {
  readonly freeUntilHours?: unknown;
  readonly penaltyPct?: unknown;
  readonly guestText?: unknown;
}
interface SobreventaBody {
  readonly maxOverbookRooms?: unknown;
  readonly thresholdPct?: unknown;
}
interface TarifaBody {
  readonly precio?: unknown;
  readonly estanciaMinima?: unknown;
}

export function hotelesConfiguracionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/hoteles/:propertyId/configuracion";
  const paths = [`${base}/impuestos`, `${base}/politica-cancelacion`, `${base}/sobreventa`, `${base}/sobreventa/:roomTypeId`, `${base}/bitacora`, "/hoteles/:propertyId/tarifas/:rateId"];
  for (const p of paths) app.use(p, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  // `/hoteles/:propertyId/tarifas` ya tiene sus middlewares en admin-catalogo.ts (POST); el GET de esta lista los reutiliza. No se
  // registran de nuevo aqui (anidaria una segunda transaccion por request): el GET falla cerrado si la sesion no esta montada.
  const tarifasPath = "/hoteles/:propertyId/tarifas";

  // ---- Impuestos ----
  app.get(`${base}/impuestos`, async (c) => {
    assertVerticalRole(c, CONFIG_READ_ROLES);
    const settings = await deps.hotelesRepo(c.get("db")).loadTaxSettings(c.req.param("propertyId"));
    return c.json({ ...settings, aviso: AVISO_ISH });
  });

  app.put(`${base}/impuestos`, async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<ImpuestosBody>(c.req.raw, 2 * 1024);
    const ivaRate = rate01(raw.ivaRate, "ivaRate");
    const ishRate = rate01(raw.ishRate, "ishRate");
    const discountThreshold = nonNegative(raw.discountThreshold, "discountThreshold");
    const dsaPerNight = raw.dsaPerNight === undefined ? 0 : nonNegative(raw.dsaPerNight, "dsaPerNight", 100_000);
    try {
      const saved = await deps.hotelesRepo(c.get("db")).saveTaxSettings({
        propertyId,
        organizationId: c.get("organizationId"),
        actorUserId: c.get("userId"),
        ivaRate,
        ishRate,
        discountThreshold,
        dsaPerNight,
      });
      await avisarCambio(c, "impuestos");
      return c.json({ ...saved, aviso: AVISO_ISH });
    } catch (err) {
      return translateConfigError(err);
    }
  });

  // ---- Politica de cancelacion ----
  app.get(`${base}/politica-cancelacion`, async (c) => {
    assertVerticalRole(c, CONFIG_READ_ROLES);
    return c.json(await deps.hotelesRepo(c.get("db")).loadCancellationPolicySettings(c.req.param("propertyId")));
  });

  app.put(`${base}/politica-cancelacion`, async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const raw = await readJsonCapped<PoliticaBody>(c.req.raw, 4 * 1024);
    if (typeof raw.freeUntilHours !== "number" || !Number.isInteger(raw.freeUntilHours) || raw.freeUntilHours < 0 || raw.freeUntilHours > 8760) {
      throw Errors.validation("freeUntilHours debe ser un entero de horas entre 0 y 8760.");
    }
    const penaltyPct = rate01(raw.penaltyPct, "penaltyPct");
    let guestText: string | null = null;
    if (raw.guestText !== undefined && raw.guestText !== null) {
      if (typeof raw.guestText !== "string") throw Errors.validation("guestText debe ser texto.");
      guestText = raw.guestText.trim().length > 0 ? raw.guestText.trim() : null;
      if (guestText && guestText.length > 1000) throw Errors.validation("guestText admite hasta 1000 caracteres.");
    }
    try {
      const saved = await deps.hotelesRepo(c.get("db")).saveCancellationPolicySettings({
          propertyId: c.req.param("propertyId"),
          organizationId: c.get("organizationId"),
          actorUserId: c.get("userId"),
          freeUntilHours: raw.freeUntilHours,
          penaltyPct,
          guestText,
        });
      await avisarCambio(c, "cancelacion");
      return c.json(saved);
    } catch (err) {
      return translateConfigError(err);
    }
  });

  // ---- Sobreventa por tipo de habitacion ----
  app.get(`${base}/sobreventa`, async (c) => {
    assertVerticalRole(c, CONFIG_READ_ROLES);
    return c.json({ tipos: await deps.hotelesRepo(c.get("db")).listRoomTypeOverbooking(c.req.param("propertyId")) });
  });

  app.put(`${base}/sobreventa/:roomTypeId`, async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const roomTypeId = c.req.param("roomTypeId");
    if (!UUID_RE.test(roomTypeId)) throw Errors.validation("roomTypeId inválido.");
    const raw = await readJsonCapped<SobreventaBody>(c.req.raw, 1024);
    if (typeof raw.maxOverbookRooms !== "number" || !Number.isInteger(raw.maxOverbookRooms) || raw.maxOverbookRooms < 0 || raw.maxOverbookRooms > 100) {
      throw Errors.validation("maxOverbookRooms debe ser un entero entre 0 y 100 (0 = sin sobreventa).");
    }
    let thresholdPct: number | null = null;
    if (raw.thresholdPct !== undefined && raw.thresholdPct !== null) {
      if (typeof raw.thresholdPct !== "number" || !Number.isFinite(raw.thresholdPct) || raw.thresholdPct < 0 || raw.thresholdPct > 100) {
        throw Errors.validation("thresholdPct debe ser un número entre 0 y 100.");
      }
      thresholdPct = raw.thresholdPct;
    }
    try {
      const saved = await deps.hotelesRepo(c.get("db")).saveRoomTypeOverbooking({
        propertyId: c.req.param("propertyId"),
        organizationId: c.get("organizationId"),
        actorUserId: c.get("userId"),
        roomTypeId,
        maxOverbookRooms: raw.maxOverbookRooms,
        thresholdPct,
      });
      if (!saved) throw Errors.notFound("Tipo de habitación no encontrado en esta property.");
      await avisarCambio(c, "sobreventa");
      return c.json(saved);
    } catch (err) {
      return translateConfigError(err);
    }
  });

  // ---- Bitacora de cambios de configuracion ----
  app.get(`${base}/bitacora`, async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const rawLimit = Number(c.req.query("limit") ?? 50);
    const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 200 ? rawLimit : 50;
    return c.json({ entradas: await deps.hotelesRepo(c.get("db")).listConfigAudit(c.req.param("propertyId"), limit) });
  });

  // ---- Tarifas por noche: listar y editar ----
  app.get(tarifasPath, async (c) => {
    if (!c.get("db") || !c.get("userId")) throw Errors.unauthorized();
    assertVerticalRole(c, CONFIG_READ_ROLES);
    const desde = c.req.query("desde") ?? hoyFechaNegocio(resolverZonaHorariaNegocio(await deps.hotelesRepo(c.get("db")).findPropertyTimezone(c.req.param("propertyId"))));
    const hasta = c.req.query("hasta") ?? new Date(Date.parse(`${desde}T00:00:00Z`) + 29 * 86_400_000).toISOString().slice(0, 10);
    if (!isIsoDate(desde) || !isIsoDate(hasta)) throw Errors.validation("desde y hasta deben tener formato YYYY-MM-DD.");
    if (hasta < desde) throw Errors.validation("hasta debe ser igual o posterior a desde.");
    if (daysBetween(desde, hasta) + 1 > MAX_RANGO_TARIFAS_DIAS) throw Errors.validation(`El rango no puede superar ${MAX_RANGO_TARIFAS_DIAS} días.`);
    const roomTypeId = c.req.query("roomTypeId") || null;
    if (roomTypeId !== null && !UUID_RE.test(roomTypeId)) throw Errors.validation("roomTypeId inválido.");
    const tarifas = await deps.hotelesRepo(c.get("db")).listRatePlans({ propertyId: c.req.param("propertyId"), from: desde, to: hasta, roomTypeId, limit: MAX_TARIFAS });
    return c.json({ desde, hasta, tarifas, truncado: tarifas.length >= MAX_TARIFAS });
  });

  app.put("/hoteles/:propertyId/tarifas/:rateId", async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const rateId = c.req.param("rateId");
    if (!UUID_RE.test(rateId)) throw Errors.validation("rateId inválido.");
    const raw = await readJsonCapped<TarifaBody>(c.req.raw, 1024);
    const precio = nonNegative(raw.precio, "precio", 9_999_999_999);
    let estanciaMinima: number | null = null;
    if (raw.estanciaMinima !== undefined && raw.estanciaMinima !== null) {
      if (typeof raw.estanciaMinima !== "number" || !Number.isInteger(raw.estanciaMinima) || raw.estanciaMinima < 1 || raw.estanciaMinima > 365) {
        throw Errors.validation("estanciaMinima debe ser un entero entre 1 y 365.");
      }
      estanciaMinima = raw.estanciaMinima;
    }
    try {
      const saved = await deps.hotelesRepo(c.get("db")).saveRatePrice({
        propertyId: c.req.param("propertyId"),
        organizationId: c.get("organizationId"),
        actorUserId: c.get("userId"),
        rateId,
        price: precio,
        minStay: estanciaMinima,
      });
      if (!saved) throw Errors.notFound("Tarifa no encontrada en esta property.");
      await avisarCambio(c, "tarifas");
      return c.json(saved);
    } catch (err) {
      return translateConfigError(err);
    }
  });

  return app;
}
