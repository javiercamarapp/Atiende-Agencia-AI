// H-25 (migracion 037) -- AGENTE DE RESERVAS, lado STAFF: ver las pre-reservas (holds) que apartó el agente de WhatsApp/voz, aprobarlas o
// rechazarlas (politica "aprobacion humana"), registrar la referencia de un link de pago que el hotel genero por fuera (SOLO registro: aqui no se
// cobra ni se integra ninguna pasarela), confirmarlas (crea la reserva y su folio) o cancelarlas, y editar la politica por hotel.
// Mismo montaje que grupos.ts: authMiddleware + dbSession + requirePropertyMembership, filtrado fino con assertVerticalRole; la base (funciones
// definer de la 037) es la autoridad final del rol.
//
// REGLA DURA DE COMPATIBILIDAD: contra una base sin la migracion 037 las lecturas degradan (`disponible: false`) y las escrituras responden 503.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  HOLD_DECISION_ROLES,
  HOLD_POLICY_ROLES,
  HOLD_STATUSES,
  HOLD_VIEW_ROLES,
  PostgresReservasAgenteRepository,
  ReservasAgenteError,
  type BookingPolicyRecord,
  type HoldRecord,
  type HoldStatus,
  type ReservasAgenteRepository,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";
import { programarMensajesHuesped } from "./mensajes-huesped.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serializeHold(h: HoldRecord) {
  return {
    id: h.id,
    tipoHabitacionId: h.roomTypeId,
    llegada: h.checkInDate,
    salida: h.checkOutDate,
    noches: h.nights,
    huespedes: h.guests,
    canal: h.channel,
    nombreHuesped: h.guestName,
    telefonoContacto: h.contactPhone,
    moneda: "MXN",
    subtotalCentavos: h.netCents,
    ivaCentavos: h.ivaCents,
    impuestoHospedajeCentavos: h.ishCents,
    totalCentavos: h.totalCents,
    modo: h.mode,
    estado: h.status,
    venceEn: h.expiresAt,
    referenciaLinkPago: h.paymentLinkRef,
    decididoPor: h.decidedBy,
    decididoEn: h.decidedAt,
    motivoDecision: h.decisionReason,
    reservaId: h.reservationId,
    creadoEn: h.createdAt,
  };
}

function serializePolicy(p: BookingPolicyRecord) {
  return {
    habilitado: p.holdsEnabled,
    modo: p.mode,
    vigenciaMinutos: p.holdTtlMinutes,
    nochesMaximas: p.maxNights,
    huespedesMaximos: p.maxGuests,
    diasMaximosDeAnticipacion: p.maxAdvanceDays,
    holdsAbiertosMaximos: p.maxActiveHolds,
    configurada: p.configured,
  };
}

/** Traduce los errores de dominio a respuestas HTTP (nunca un 500 crudo). */
function toApiError(err: unknown): unknown {
  if (!(err instanceof ReservasAgenteError)) return err;
  switch (err.code) {
    case "no_disponible_aun":
      return Errors.serviceUnavailable(err.message);
    case "no_encontrada":
      return Errors.notFound("Pre-reserva no encontrada, o sin permiso para verla.");
    case "sin_permiso":
      return Errors.forbidden();
    case "estado_no_valido":
    case "sin_disponibilidad":
    case "idempotencia_conflicto":
      return Errors.conflict(err.message);
    default:
      return Errors.validation(err.message);
  }
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw Errors.validation(`${field}: se esperaba un UUID.`);
  return value;
}
function requireText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) throw Errors.validation(`${field}: texto de ${min} a ${max} caracteres.`);
  return value.trim();
}
function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw Errors.validation(`${field}: entero entre ${min} y ${max}.`);
  return value;
}

export function hotelesReservasAgenteRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/reservas-agente/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/reservas-agente", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  function repoOf(c: Context<CoreAuthHonoEnv>): ReservasAgenteRepository {
    const db = c.get("db");
    return deps.hotelesReservasAgenteRepo ? deps.hotelesReservasAgenteRepo(db) : new PostgresReservasAgenteRepository(db);
  }
  const pid = (c: Context<CoreAuthHonoEnv>): string => c.req.param("propertyId") ?? "";
  async function readBody(c: Context<CoreAuthHonoEnv>): Promise<Record<string, unknown>> {
    const raw = await c.req.json().catch(() => ({}));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  }

  app.get("/hoteles/:propertyId/reservas-agente/holds", async (c) => {
    assertVerticalRole(c, HOLD_VIEW_ROLES);
    const estado = c.req.query("estado");
    if (estado !== undefined && !(HOLD_STATUSES as readonly string[]).includes(estado)) throw Errors.validation("estado invalido.");
    const result = await guarded(() => repoOf(c).listHolds(pid(c), { ...(estado ? { status: estado as HoldStatus } : {}), onlyOpen: c.req.query("abiertas") === "1" }));
    return c.json({ disponible: result.disponible, holds: result.holds.map(serializeHold) });
  });

  app.post("/hoteles/:propertyId/reservas-agente/holds/:holdId/decidir", async (c) => {
    assertVerticalRole(c, HOLD_DECISION_ROLES);
    const raw = await readBody(c);
    const holdId = requireUuid(c.req.param("holdId"), "holdId");
    if (raw.decision !== "aprobar" && raw.decision !== "rechazar") throw Errors.validation("decision: 'aprobar' o 'rechazar'.");
    const motivo = requireText(raw.motivo, "motivo", 1, 500);
    const hold = await guarded(() => repoOf(c).decideHold(pid(c), holdId, raw.decision as "aprobar" | "rechazar", motivo));
    // H-P3-03: el huesped se entera de la decision (hold.aprobado / hold.rechazado). Corre DESPUES del commit, en sesion de sistema, acotado a este
    // hold; el cron de mensajes-huesped es la red de seguridad. Nunca afecta la respuesta.
    programarMensajesHuesped(deps, c, { propertyId: pid(c), refId: holdId });
    return c.json({ hold: serializeHold(hold) });
  });

  app.post("/hoteles/:propertyId/reservas-agente/holds/:holdId/link-pago", async (c) => {
    assertVerticalRole(c, HOLD_DECISION_ROLES);
    const raw = await readBody(c);
    const holdId = requireUuid(c.req.param("holdId"), "holdId");
    const referencia = requireText(raw.referencia, "referencia", 1, 200);
    const hold = await guarded(() => repoOf(c).registerPaymentLink(pid(c), holdId, referencia));
    return c.json({ hold: serializeHold(hold) });
  });

  app.post("/hoteles/:propertyId/reservas-agente/holds/:holdId/confirmar", async (c) => {
    assertVerticalRole(c, HOLD_DECISION_ROLES);
    const holdId = requireUuid(c.req.param("holdId"), "holdId");
    const hold = await guarded(() => repoOf(c).confirmHold(pid(c), holdId));
    if (hold.status === "confirmado" && hold.reservationId) {
      // La reserva ya existe (la creo la base, con el inventario retenido por el hold); su folio primario es idempotente.
      await deps.hotelesRepo(c.get("db")).ensurePrimaryFolio(pid(c), c.get("organizationId"), hold.reservationId);
      // H-P3-03: hold.confirmado (la reserva ya existe): aviso al huesped despues del commit.
      programarMensajesHuesped(deps, c, { propertyId: pid(c), refId: holdId });
    }
    return c.json({ hold: serializeHold(hold) });
  });

  app.post("/hoteles/:propertyId/reservas-agente/holds/:holdId/cancelar", async (c) => {
    assertVerticalRole(c, HOLD_DECISION_ROLES);
    const raw = await readBody(c);
    const holdId = requireUuid(c.req.param("holdId"), "holdId");
    const motivo = requireText(raw.motivo, "motivo", 1, 500);
    const hold = await guarded(() => repoOf(c).staffCancelHold(pid(c), holdId, motivo));
    return c.json({ hold: serializeHold(hold) });
  });

  app.get("/hoteles/:propertyId/reservas-agente/politica", async (c) => {
    assertVerticalRole(c, HOLD_VIEW_ROLES);
    const result = await guarded(() => repoOf(c).getPolicy(pid(c)));
    return c.json({ disponible: result.disponible, politica: serializePolicy(result.politica) });
  });

  app.put("/hoteles/:propertyId/reservas-agente/politica", async (c) => {
    assertVerticalRole(c, HOLD_POLICY_ROLES);
    const raw = await readBody(c);
    if (typeof raw.habilitado !== "boolean") throw Errors.validation("habilitado: booleano.");
    if (raw.modo !== "aprobacion_humana" && raw.modo !== "link_pago") throw Errors.validation("modo: 'aprobacion_humana' o 'link_pago'.");
    const input = {
      holdsEnabled: raw.habilitado,
      mode: raw.modo as "aprobacion_humana" | "link_pago",
      holdTtlMinutes: requireInt(raw.vigenciaMinutos, "vigenciaMinutos", 15, 4320),
      maxNights: requireInt(raw.nochesMaximas, "nochesMaximas", 1, 60),
      maxGuests: requireInt(raw.huespedesMaximos, "huespedesMaximos", 1, 20),
      maxAdvanceDays: requireInt(raw.diasMaximosDeAnticipacion, "diasMaximosDeAnticipacion", 1, 730),
      maxActiveHolds: requireInt(raw.holdsAbiertosMaximos, "holdsAbiertosMaximos", 1, 500),
    };
    const result = await guarded(() => repoOf(c).upsertPolicy(pid(c), input));
    return c.json({ disponible: result.disponible, politica: serializePolicy(result.politica) });
  });

  return app;
}
