// Fase 10 hoteles — motor de recomendaciones de tarifa v1: wiring HTTP de
// `hoteles.rate_recommendation`/`hoteles.pricing_rule`/`hoteles.local_event`/
// `hoteles.competitor_rate` (migrations/029_rate_recommendation_engine.sql), sobre
// el gate/backtest YA EXISTENTES (011_revenue_engine_gate.sql, wiring en
// revenue.ts) -- archivo separado de revenue.ts (que sigue siendo el gate/backtest)
// para no mezclar dos superficies distintas en el mismo archivo, mismo criterio que
// night-audit.ts/email-dispatch.ts/pl.ts siendo archivos propios dentro de hoteles/.
//
// CLASIFICACIÓN DE SESIÓN (ver migrations/029 para el detalle completo):
//   - Listar/ver recomendaciones, configurar pricing_rule, capturar competitor_rate/
//     local_event: sesión de STAFF (esta ruta, dbSession normal).
//   - Aprobar/descartar una recomendación: sesión de STAFF (owner/gm) -- SOLO cambia
//     el estado, NUNCA escribe la tarifa real.
//   - Insertar una recomendación nueva y APLICARLA (escribir hoteles.rate_plan):
//     SIEMPRE sesión de sistema -- eso vive en el cron
//     (revenue-recommendations-cron.ts), NUNCA en esta ruta de staff. Esta ruta no
//     expone ningún endpoint de "aplicar": ni siquiera owner/gm puede invocarlo
//     directo (el trigger real lo rechazaría de todos modos, ver migrations/029).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  HOTEL_ROLES,
  REVENUE_RECOMMENDATION_APPROVE_ROLES,
  REVENUE_PRICING_RULES_MANAGE_ROLES,
  REVENUE_DATA_CAPTURE_ROLES,
  DEFAULT_PRICING_RULES,
  assertValidPricingRules,
  RateEngineUnavailableError,
  type RateRecommendationRecord,
  type RateRecommendationStatus,
  type PricingRuleRecord,
  type LocalEventRecord,
  type CompetitorRateRecord,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const RATE_RECOMMENDATION_STATUSES: readonly RateRecommendationStatus[] = ["pendiente", "aprobada", "aplicada", "descartada", "expirada"];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function serializeRecommendation(r: RateRecommendationRecord) {
  return {
    id: r.id,
    propertyId: r.propertyId,
    roomTypeId: r.roomTypeId,
    fecha: r.fecha,
    currentBarPrice: r.currentBarPrice,
    recommendedPrice: r.recommendedPrice,
    suggestedMinStay: r.suggestedMinStay,
    // El desglose YA es la explicación completa (pickup/evento/compset/regla) --
    // "nunca una caja negra" (REQ del brief) es exactamente pasarlo tal cual.
    desglose: r.desglose,
    estado: r.estado,
    aprobadaPor: r.aprobadaPor,
    aprobadaEn: r.aprobadaEn,
    aplicadaPor: r.aplicadaPor,
    aplicadaEn: r.aplicadaEn,
    descartadaPor: r.descartadaPor,
    descartadaEn: r.descartadaEn,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function serializePricingRule(r: PricingRuleRecord) {
  return {
    floorPrice: r.floorPrice,
    ceilingPrice: r.ceilingPrice,
    dayOfWeekMultiplier: r.dayOfWeekMultiplier,
    minStayDefault: r.minStayDefault,
    minStayOnHighDemand: r.minStayOnHighDemand,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt,
    esDefault: false,
  };
}

function serializeLocalEvent(r: LocalEventRecord) {
  return { id: r.id, nombre: r.nombre, fechaInicio: r.fechaInicio, fechaFin: r.fechaFin, impacto: r.impacto, magnitudPct: r.magnitudPct, registradoPor: r.registradoPor, createdAt: r.createdAt };
}

function serializeCompetitorRate(r: CompetitorRateRecord) {
  return { id: r.id, competidor: r.competidor, fecha: r.fecha, tarifa: r.tarifa, capturadaPor: r.capturadaPor, capturadaEn: r.capturadaEn };
}

/** Traduce los códigos de error estables que
 *  `hoteles.rate_recommendation_status_guard`/`hoteles.system_apply_rate_recommendation`
 *  (migrations/029) lanzan de verdad contra Postgres real -- mismo criterio que
 *  `insertRoomType`/`insertRoom` en `postgres-repository.ts` (prefijo reconocible
 *  en `err.message`, nunca un 500 genérico para un rechazo de negocio esperado). Los
 *  códigos que empiezan con "aprobacion_requiere_"/"descarte_requiere_"/
 *  "aplicacion_requiere_" son errores de AUTORIZACIÓN (403); el resto son 409 (el
 *  estado/gate/backtest no admite la transición pedida AHORA). Errores no
 *  reconocidos se repropagan tal cual -- nunca se enmascara un fallo real. */
function translateRateRecommendationDomainError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const forbiddenPrefixes = ["aprobacion_requiere_", "descarte_requiere_", "aplicacion_requiere_", "insercion_requiere_", "expiracion_requiere_"];
  const conflictPrefixes = [
    "aprobacion_fuera_de_propone",
    "estado_terminal",
    "variacion_excede_limite",
    "backtest_no_supera_baseline",
    "aplicacion_directa_solo_autopilot",
    "gate_insuficiente_para_aplicar",
    "gate_no_inicializado",
    "estado_no_aplicable",
    "expiracion_prematura",
    "transicion_no_permitida",
    "datos_de_recomendacion_inmutables",
  ];
  if (forbiddenPrefixes.some((p) => message.includes(p))) throw Errors.forbidden(message);
  if (conflictPrefixes.some((p) => message.includes(p))) throw Errors.conflict(message);
  throw err;
}

export function hotelesRevenueRecomendacionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/revenue/recomendaciones/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/revenue/recomendaciones", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/revenue/pricing-rule/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/revenue/local-events", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/revenue/competitor-rates", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // ---- Recomendaciones: listar (paginado, orden total) + ver el desglose. ----
  app.get("/hoteles/:propertyId/revenue/recomendaciones", async (c) => {
    assertVerticalRole(c, HOTEL_ROLES);
    const propertyId = c.req.param("propertyId");
    const repo = deps.hotelesRepo(c.get("db"));

    const estadoRaw = c.req.query("estado");
    if (estadoRaw && !(RATE_RECOMMENDATION_STATUSES as readonly string[]).includes(estadoRaw)) {
      throw Errors.validation(`estado: se esperaba uno de ${RATE_RECOMMENDATION_STATUSES.join("|")}.`);
    }
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw Errors.validation("limit: se esperaba un entero entre 1 y 200.");

    let beforeCursor: { fecha: string; roomTypeId: string; id: string } | undefined;
    const cursorFecha = c.req.query("cursorFecha");
    const cursorRoomTypeId = c.req.query("cursorRoomTypeId");
    const cursorId = c.req.query("cursorId");
    if (cursorFecha || cursorRoomTypeId || cursorId) {
      if (!cursorFecha || !cursorRoomTypeId || !cursorId || !ISO_DATE_RE.test(cursorFecha)) {
        throw Errors.validation("cursorFecha/cursorRoomTypeId/cursorId: para paginar se requieren los 3 juntos (del último elemento de la página anterior), cursorFecha en formato YYYY-MM-DD.");
      }
      beforeCursor = { fecha: cursorFecha, roomTypeId: cursorRoomTypeId, id: cursorId };
    }

    const recs = await repo.listRateRecommendations(propertyId, { estado: estadoRaw as RateRecommendationStatus | undefined, limit, beforeCursor });
    const last = recs[recs.length - 1];
    return c.json({
      recomendaciones: recs.map(serializeRecommendation),
      nextCursor: recs.length === limit && last ? { cursorFecha: last.fecha, cursorRoomTypeId: last.roomTypeId, cursorId: last.id } : null,
    });
  });

  app.get("/hoteles/:propertyId/revenue/recomendaciones/:id", async (c) => {
    assertVerticalRole(c, HOTEL_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const rec = await repo.findRateRecommendation(c.req.param("id"));
    if (!rec || rec.propertyId !== c.req.param("propertyId")) throw Errors.notFound("Recomendación no encontrada.");
    return c.json(serializeRecommendation(rec));
  });

  // ---- Aprobar/descartar -- sesión de STAFF, NUNCA aplica la tarifa (ver
  // cabecera del archivo). ----
  app.post("/hoteles/:propertyId/revenue/recomendaciones/:id/aprobar", async (c) => {
    assertVerticalRole(c, REVENUE_RECOMMENDATION_APPROVE_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const id = c.req.param("id");
    const userId = c.get("userId");

    const existing = await repo.findRateRecommendation(id);
    if (!existing || existing.propertyId !== propertyId) throw Errors.notFound("Recomendación no encontrada.");
    try {
      const updated = await repo.approveRateRecommendation(id, userId);
      return c.json(serializeRecommendation(updated), 200);
    } catch (err) {
      if (err instanceof RateEngineUnavailableError) throw Errors.serviceUnavailable(err.message);
      translateRateRecommendationDomainError(err);
    }
  });

  app.post("/hoteles/:propertyId/revenue/recomendaciones/:id/descartar", async (c) => {
    assertVerticalRole(c, REVENUE_RECOMMENDATION_APPROVE_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const id = c.req.param("id");
    const userId = c.get("userId");

    const existing = await repo.findRateRecommendation(id);
    if (!existing || existing.propertyId !== propertyId) throw Errors.notFound("Recomendación no encontrada.");
    try {
      const updated = await repo.discardRateRecommendation(id, userId);
      return c.json(serializeRecommendation(updated), 200);
    } catch (err) {
      if (err instanceof RateEngineUnavailableError) throw Errors.serviceUnavailable(err.message);
      translateRateRecommendationDomainError(err);
    }
  });

  // ---- Reglas de precio (floor/ceiling/DOW/LOS) por room_type. ----
  app.get("/hoteles/:propertyId/revenue/pricing-rule/:roomTypeId", async (c) => {
    assertVerticalRole(c, HOTEL_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const rule = await repo.findPricingRule(c.req.param("roomTypeId"));
    // "default razonable si el owner no configuró nada" (REQ del brief) -- se
    // refleja aquí explícitamente (`esDefault: true`) para que la pantalla pueda
    // avisar que estos valores todavía no son una decisión guardada del owner.
    if (!rule) {
      return c.json({
        floorPrice: DEFAULT_PRICING_RULES.floorPrice,
        ceilingPrice: Number.isFinite(DEFAULT_PRICING_RULES.ceilingPrice) ? DEFAULT_PRICING_RULES.ceilingPrice : null,
        dayOfWeekMultiplier: DEFAULT_PRICING_RULES.dayOfWeekMultiplier,
        minStayDefault: DEFAULT_PRICING_RULES.minStayDefault,
        minStayOnHighDemand: DEFAULT_PRICING_RULES.minStayOnHighDemand,
        updatedBy: null,
        updatedAt: null,
        esDefault: true,
      });
    }
    return c.json(serializePricingRule(rule));
  });

  interface PricingRuleBody {
    readonly floorPrice?: unknown;
    readonly ceilingPrice?: unknown;
    readonly dayOfWeekMultiplier?: unknown;
    readonly minStayDefault?: unknown;
    readonly minStayOnHighDemand?: unknown;
  }

  app.put("/hoteles/:propertyId/revenue/pricing-rule/:roomTypeId", async (c) => {
    assertVerticalRole(c, REVENUE_PRICING_RULES_MANAGE_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const roomTypeId = c.req.param("roomTypeId");
    const userId = c.get("userId");

    const raw = await readJsonCapped<PricingRuleBody>(c.req.raw, 4 * 1024);
    if (typeof raw.floorPrice !== "number" || typeof raw.ceilingPrice !== "number") throw Errors.validation("floorPrice/ceilingPrice: se esperaban números.");
    if (!Array.isArray(raw.dayOfWeekMultiplier) || raw.dayOfWeekMultiplier.length !== 7 || raw.dayOfWeekMultiplier.some((m) => typeof m !== "number")) {
      throw Errors.validation("dayOfWeekMultiplier: se esperaba un arreglo de 7 números (domingo..sábado).");
    }
    const minStayDefault = typeof raw.minStayDefault === "number" ? raw.minStayDefault : DEFAULT_PRICING_RULES.minStayDefault;
    const minStayOnHighDemand = typeof raw.minStayOnHighDemand === "number" ? raw.minStayOnHighDemand : DEFAULT_PRICING_RULES.minStayOnHighDemand;

    const input = {
      propertyId,
      roomTypeId,
      floorPrice: raw.floorPrice,
      ceilingPrice: raw.ceilingPrice,
      dayOfWeekMultiplier: raw.dayOfWeekMultiplier as readonly number[],
      minStayDefault,
      minStayOnHighDemand,
    };
    try {
      assertValidPricingRules({ floorPrice: input.floorPrice, ceilingPrice: input.ceilingPrice, dayOfWeekMultiplier: input.dayOfWeekMultiplier as [number, number, number, number, number, number, number], minStayDefault, minStayOnHighDemand });
    } catch (err) {
      throw Errors.validation(err instanceof Error ? err.message : "Reglas de precio inválidas.");
    }

    try {
      const rule = await repo.upsertPricingRule(input, userId);
      return c.json(serializePricingRule(rule), 200);
    } catch (err) {
      if (err instanceof RateEngineUnavailableError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }
  });

  // ---- Eventos locales (solo el staff de esta property los conoce). ----
  app.get("/hoteles/:propertyId/revenue/local-events", async (c) => {
    assertVerticalRole(c, HOTEL_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const desde = c.req.query("desde");
    const hasta = c.req.query("hasta");
    if (!desde || !hasta || !ISO_DATE_RE.test(desde) || !ISO_DATE_RE.test(hasta)) throw Errors.validation("desde/hasta: se esperaban fechas YYYY-MM-DD.");
    const events = await repo.listLocalEvents(c.req.param("propertyId"), desde, hasta);
    return c.json(events.map(serializeLocalEvent));
  });

  interface LocalEventBody {
    readonly nombre?: unknown;
    readonly fechaInicio?: unknown;
    readonly fechaFin?: unknown;
    readonly impacto?: unknown;
    readonly magnitudPct?: unknown;
  }

  app.post("/hoteles/:propertyId/revenue/local-events", async (c) => {
    assertVerticalRole(c, REVENUE_DATA_CAPTURE_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");

    const raw = await readJsonCapped<LocalEventBody>(c.req.raw, 4 * 1024);
    if (typeof raw.nombre !== "string" || raw.nombre.trim().length === 0) throw Errors.validation("nombre: requerido.");
    if (typeof raw.fechaInicio !== "string" || !ISO_DATE_RE.test(raw.fechaInicio)) throw Errors.validation("fechaInicio: se esperaba YYYY-MM-DD.");
    if (typeof raw.fechaFin !== "string" || !ISO_DATE_RE.test(raw.fechaFin)) throw Errors.validation("fechaFin: se esperaba YYYY-MM-DD.");
    if (raw.impacto !== "alza_demanda" && raw.impacto !== "baja_demanda") throw Errors.validation('impacto: se esperaba "alza_demanda" o "baja_demanda".');
    if (typeof raw.magnitudPct !== "number" || raw.magnitudPct <= 0) throw Errors.validation("magnitudPct: se esperaba un número positivo.");

    try {
      const event = await repo.insertLocalEvent({ organizationId, propertyId, nombre: raw.nombre, fechaInicio: raw.fechaInicio, fechaFin: raw.fechaFin, impacto: raw.impacto, magnitudPct: raw.magnitudPct }, userId);
      return c.json(serializeLocalEvent(event), 201);
    } catch (err) {
      if (err instanceof RateEngineUnavailableError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }
  });

  // ---- Tarifas de competidor (captura MANUAL -- nunca un scraper, ver
  // migrations/029). ----
  app.get("/hoteles/:propertyId/revenue/competitor-rates", async (c) => {
    assertVerticalRole(c, HOTEL_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const fecha = c.req.query("fecha");
    if (!fecha || !ISO_DATE_RE.test(fecha)) throw Errors.validation("fecha: se esperaba YYYY-MM-DD.");
    const rates = await repo.listCompetitorRates(c.req.param("propertyId"), fecha);
    return c.json(rates.map(serializeCompetitorRate));
  });

  interface CompetitorRateBody {
    readonly competidor?: unknown;
    readonly fecha?: unknown;
    readonly tarifa?: unknown;
  }

  app.post("/hoteles/:propertyId/revenue/competitor-rates", async (c) => {
    assertVerticalRole(c, REVENUE_DATA_CAPTURE_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");

    const raw = await readJsonCapped<CompetitorRateBody>(c.req.raw, 2 * 1024);
    if (typeof raw.competidor !== "string" || raw.competidor.trim().length === 0) throw Errors.validation("competidor: requerido.");
    if (typeof raw.fecha !== "string" || !ISO_DATE_RE.test(raw.fecha)) throw Errors.validation("fecha: se esperaba YYYY-MM-DD.");
    if (typeof raw.tarifa !== "number" || raw.tarifa <= 0) throw Errors.validation("tarifa: se esperaba un número positivo.");

    try {
      const rate = await repo.insertCompetitorRate({ organizationId, propertyId, competidor: raw.competidor, fecha: raw.fecha, tarifa: raw.tarifa }, userId);
      return c.json(serializeCompetitorRate(rate), 201);
    } catch (err) {
      if (err instanceof RateEngineUnavailableError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }
  });

  return app;
}
