// H-06 (migracion 036) -- GRUPOS: cotizacion con vigencia, bloqueo de cuartos (allotment) con fecha de liberacion, pickup,
// rooming list y anticipos REGISTRADOS (sin cobro). Mismo montaje que agentes.ts: authMiddleware + dbSession +
// requirePropertyMembership("propertyId"), filtrado fino con assertVerticalRole en cada handler (la RLS y las funciones
// definer de la 036 son la autoridad final: un rol de mas en el espejo solo produce un 403 de mas, nunca un acceso de mas).
//
// Dinero: SIEMPRE centavos enteros MXN; un decimal responde 400. Aceptar una cotizacion enviada BLOQUEA los cuartos
// (atomico, sin sobreventa); la liberacion automatica por cutoff NO vive aqui (ver grupos-liberacion-cron.ts, sin cron
// programado).
//
// REGLA DURA DE COMPATIBILIDAD: contra una base sin la migracion 036 las lecturas degradan (`disponible: false`, listas
// vacias) y las escrituras responden 503 -- nunca un 500.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  GRUPOS_DEPOSIT_ROLES,
  GRUPOS_MANAGE_ROLES,
  GRUPOS_ROOMING_ROLES,
  GRUPOS_VIEW_ROLES,
  GruposAccessDeniedError,
  GruposConflictError,
  GruposInvalidInputError,
  GruposNotFoundError,
  GruposUnavailableError,
  PostgresGruposRepository,
  computeQuoteTotals,
  isGroupIsoDate,
  type BlockDetail,
  type BlockRecord,
  type DepositRecord,
  type GrupoActor,
  type GruposRepository,
  type QuoteDetail,
  type QuoteLineInput,
  type QuoteRecord,
  type RoomingEntryRecord,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serializeQuote(q: QuoteRecord) {
  return {
    id: q.id,
    nombreGrupo: q.groupName,
    contacto: q.contactName,
    correoContacto: q.contactEmail,
    llegada: q.checkInDate,
    salida: q.checkOutDate,
    noches: q.nights,
    fechaLiberacion: q.cutoffDate,
    vigenteHasta: q.validUntil,
    descuentoBps: q.discountBps,
    moneda: "MXN",
    brutoCentavos: q.grossCents,
    totalCentavos: q.totalCents,
    anticipoRequeridoCentavos: q.depositRequiredCents,
    anticipoRegistradoCentavos: q.depositRecordedCents,
    estado: q.status,
    enviadaEn: q.sentAt,
    aceptadaEn: q.acceptedAt,
    motivoCierre: q.closedReason,
    creadaEn: q.createdAt,
  };
}

function serializeDeposit(d: DepositRecord) {
  return { id: d.id, montoCentavos: d.amountCents, referencia: d.reference, registradoPor: d.recordedBy, registradoEn: d.recordedAt };
}

function serializeQuoteDetail(q: QuoteDetail) {
  return {
    ...serializeQuote(q),
    renglones: q.lines.map((l) => ({ id: l.id, tipoHabitacionId: l.roomTypeId, cuartos: l.rooms, tarifaCentavos: l.rateCents })),
    anticipos: q.deposits.map(serializeDeposit),
    bloqueoId: q.blockId,
  };
}

function serializeBlock(b: BlockRecord) {
  return {
    id: b.id,
    cotizacionId: b.quoteId,
    nombreGrupo: b.groupName,
    estado: b.status,
    llegada: b.checkInDate,
    salida: b.checkOutDate,
    fechaLiberacion: b.cutoffDate,
    liberadoEn: b.releasedAt,
    tipoLiberacion: b.releaseKind,
    creadoEn: b.createdAt,
    pickup: {
      cuartosNocheBloqueados: b.pickup.blockedRoomNights,
      cuartosNocheConfirmados: b.pickup.pickedUpRoomNights,
      cuartosNocheLiberados: b.pickup.releasedRoomNights,
      cuartosNochePendientes: b.pickup.pendingRoomNights,
      cuartosNocheRetenidos: b.pickup.heldRoomNights,
      porcentaje: b.pickup.pickupPct,
    },
  };
}

function serializeEntry(e: RoomingEntryRecord) {
  return {
    id: e.id,
    bloqueoId: e.blockId,
    tipoHabitacionId: e.roomTypeId,
    huesped: e.guestName,
    llegada: e.checkInDate,
    salida: e.checkOutDate,
    estado: e.status,
    reservaId: e.reservationId,
    confirmadoEn: e.confirmedAt,
    creadoEn: e.createdAt,
  };
}

function serializeBlockDetail(b: BlockDetail) {
  return {
    ...serializeBlock(b),
    noches: b.nights.map((n) => ({ tipoHabitacionId: n.roomTypeId, fecha: n.date, bloqueados: n.blockedRooms, confirmados: n.pickedUpRooms, liberados: n.releasedRooms })),
    rooming: b.rooming.map(serializeEntry),
  };
}

/** Traduce los errores de dominio de grupos a respuestas HTTP (nunca un 500 crudo). */
function toApiError(err: unknown): unknown {
  if (err instanceof GruposUnavailableError) return Errors.serviceUnavailable(err.message);
  if (err instanceof GruposNotFoundError) return Errors.notFound(err.message);
  if (err instanceof GruposConflictError) return Errors.conflict(err.message);
  if (err instanceof GruposInvalidInputError) return Errors.validation(err.message);
  if (err instanceof GruposAccessDeniedError) return Errors.forbidden(err.message);
  return err;
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
function requireDate(value: unknown, field: string): string {
  if (!isGroupIsoDate(value)) throw Errors.validation(`${field}: fecha YYYY-MM-DD.`);
  return value;
}
function requireText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) throw Errors.validation(`${field}: texto de ${min} a ${max} caracteres.`);
  return value.trim();
}
function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > max) throw Errors.validation(`${field}: texto de hasta ${max} caracteres.`);
  return value.trim();
}
/** Entero de centavos/cuartos: un decimal, un texto o un negativo se rechazan (nunca se redondea en silencio). */
function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw Errors.validation(`${field}: entero entre ${min} y ${max} (centavos enteros, sin decimales).`);
  return value;
}
function requireInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) throw Errors.validation(`${field}: fecha y hora ISO 8601 con zona (ej. 2031-05-08T18:00:00Z).`);
  return new Date(value).toISOString();
}

export function hotelesGruposRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/grupos/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/grupos", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  function repoOf(c: Context<CoreAuthHonoEnv>): GruposRepository {
    const db = c.get("db");
    return deps.hotelesGruposRepo ? deps.hotelesGruposRepo(db) : new PostgresGruposRepository(db);
  }
  const actorOf = (c: Context<CoreAuthHonoEnv>): GrupoActor => ({ userId: c.get("userId"), role: (c.get("verticalRole") ?? null) as string | null });
  const pid = (c: Context<CoreAuthHonoEnv>): string => c.req.param("propertyId") ?? "";

  async function readBody(c: Context<CoreAuthHonoEnv>): Promise<Record<string, unknown>> {
    const raw = await c.req.json().catch(() => ({}));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  }

  // ---- cotizaciones ------------------------------------------------------------------------

  app.get("/hoteles/:propertyId/grupos/cotizaciones", async (c) => {
    assertVerticalRole(c, GRUPOS_VIEW_ROLES);
    const result = await guarded(() => repoOf(c).listQuotes(pid(c)));
    return c.json({ disponible: result.disponible, cotizaciones: result.cotizaciones.map(serializeQuote) });
  });

  app.post("/hoteles/:propertyId/grupos/cotizaciones", async (c) => {
    assertVerticalRole(c, GRUPOS_MANAGE_ROLES);
    const raw = await readBody(c);
    if (!Array.isArray(raw.renglones) || raw.renglones.length < 1 || raw.renglones.length > 50) throw Errors.validation("renglones: de 1 a 50 renglones.");
    const lines: QuoteLineInput[] = raw.renglones.map((r, i) => {
      const row = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      return {
        roomTypeId: requireUuid(row.tipoHabitacionId, `renglones[${i}].tipoHabitacionId`),
        rooms: requireInt(row.cuartos, `renglones[${i}].cuartos`, 1, 1000),
        rateCents: requireInt(row.tarifaCentavos, `renglones[${i}].tarifaCentavos`, 0, 100_000_000),
      };
    });
    const input = {
      propertyId: pid(c),
      groupName: requireText(raw.nombreGrupo, "nombreGrupo", 2, 120),
      contactName: optionalText(raw.contacto, "contacto", 120),
      contactEmail: optionalText(raw.correoContacto, "correoContacto", 200),
      checkInDate: requireDate(raw.llegada, "llegada"),
      checkOutDate: requireDate(raw.salida, "salida"),
      cutoffDate: requireDate(raw.fechaLiberacion, "fechaLiberacion"),
      validUntil: requireInstant(raw.vigenteHasta, "vigenteHasta"),
      discountBps: raw.descuentoBps === undefined ? 0 : requireInt(raw.descuentoBps, "descuentoBps", 0, 10_000),
      depositRequiredCents: raw.anticipoRequeridoCentavos === undefined ? 0 : requireInt(raw.anticipoRequeridoCentavos, "anticipoRequeridoCentavos", 0, 100_000_000_000_000),
      lines,
    };
    try {
      computeQuoteTotals(lines, input.checkInDate, input.checkOutDate, input.discountBps);
    } catch (err) {
      throw toApiError(err);
    }
    const created = await guarded(() => repoOf(c).createQuote(input, actorOf(c)));
    return c.json(serializeQuoteDetail(created), 201);
  });

  app.get("/hoteles/:propertyId/grupos/cotizaciones/:id", async (c) => {
    assertVerticalRole(c, GRUPOS_VIEW_ROLES);
    const q = await guarded(() => repoOf(c).getQuote(pid(c), requireUuid(c.req.param("id"), "id")));
    if (!q) throw Errors.notFound("Cotizacion no encontrada.");
    return c.json(serializeQuoteDetail(q));
  });

  app.post("/hoteles/:propertyId/grupos/cotizaciones/:id/enviar", async (c) => {
    assertVerticalRole(c, GRUPOS_MANAGE_ROLES);
    const q = await guarded(() => repoOf(c).sendQuote(pid(c), requireUuid(c.req.param("id"), "id"), actorOf(c)));
    return c.json(serializeQuoteDetail(q));
  });

  app.post("/hoteles/:propertyId/grupos/cotizaciones/:id/cerrar", async (c) => {
    assertVerticalRole(c, GRUPOS_MANAGE_ROLES);
    const raw = await readBody(c);
    if (raw.resultado !== "rechazada" && raw.resultado !== "cancelada") throw Errors.validation("resultado: rechazada|cancelada.");
    const reason = requireText(raw.motivo, "motivo", 5, 300);
    const q = await guarded(() => repoOf(c).closeQuote(pid(c), requireUuid(c.req.param("id"), "id"), raw.resultado as "rechazada" | "cancelada", reason, actorOf(c)));
    return c.json(serializeQuoteDetail(q));
  });

  // Aceptar = BLOQUEAR cuartos. Atomico y sin sobreventa: si una noche no alcanza responde 409 y no retiene nada.
  app.post("/hoteles/:propertyId/grupos/cotizaciones/:id/aceptar", async (c) => {
    assertVerticalRole(c, GRUPOS_MANAGE_ROLES);
    const block = await guarded(() => repoOf(c).acceptQuote(pid(c), requireUuid(c.req.param("id"), "id"), actorOf(c)));
    return c.json(serializeBlockDetail(block), 201);
  });

  // Anticipo: SOLO se registra (no hay cobro ni pasarela aqui).
  app.post("/hoteles/:propertyId/grupos/cotizaciones/:id/anticipos", async (c) => {
    assertVerticalRole(c, GRUPOS_DEPOSIT_ROLES);
    const raw = await readBody(c);
    const amount = requireInt(raw.montoCentavos, "montoCentavos", 1, 100_000_000_000_000);
    const reference = requireText(raw.referencia, "referencia", 3, 120);
    const q = await guarded(() => repoOf(c).registerDeposit(pid(c), requireUuid(c.req.param("id"), "id"), amount, reference, actorOf(c)));
    return c.json(serializeQuoteDetail(q), 201);
  });

  // ---- bloqueos, pickup y rooming ------------------------------------------------------------

  app.get("/hoteles/:propertyId/grupos/bloqueos", async (c) => {
    assertVerticalRole(c, GRUPOS_VIEW_ROLES);
    const result = await guarded(() => repoOf(c).listBlocks(pid(c)));
    return c.json({ disponible: result.disponible, bloqueos: result.bloqueos.map(serializeBlock) });
  });

  app.get("/hoteles/:propertyId/grupos/bloqueos/:id", async (c) => {
    assertVerticalRole(c, GRUPOS_VIEW_ROLES);
    const b = await guarded(() => repoOf(c).getBlock(pid(c), requireUuid(c.req.param("id"), "id")));
    if (!b) throw Errors.notFound("Bloqueo no encontrado.");
    return c.json(serializeBlockDetail(b));
  });

  app.post("/hoteles/:propertyId/grupos/bloqueos/:id/huespedes", async (c) => {
    assertVerticalRole(c, GRUPOS_ROOMING_ROLES);
    const raw = await readBody(c);
    const entry = await guarded(() =>
      repoOf(c).addRoomingEntry(
        pid(c),
        requireUuid(c.req.param("id"), "id"),
        {
          roomTypeId: requireUuid(raw.tipoHabitacionId, "tipoHabitacionId"),
          guestName: requireText(raw.huesped, "huesped", 2, 120),
          checkInDate: requireDate(raw.llegada, "llegada"),
          checkOutDate: requireDate(raw.salida, "salida"),
        },
        actorOf(c),
      ),
    );
    return c.json(serializeEntry(entry), 201);
  });

  app.post("/hoteles/:propertyId/grupos/huespedes/:entryId/confirmar", async (c) => {
    assertVerticalRole(c, GRUPOS_ROOMING_ROLES);
    const raw = await readBody(c);
    const reservationId = raw.reservaId === undefined || raw.reservaId === null ? null : requireUuid(raw.reservaId, "reservaId");
    const entry = await guarded(() => repoOf(c).confirmRoomingEntry(pid(c), requireUuid(c.req.param("entryId"), "entryId"), reservationId, actorOf(c)));
    return c.json(serializeEntry(entry));
  });

  app.post("/hoteles/:propertyId/grupos/huespedes/:entryId/cancelar", async (c) => {
    assertVerticalRole(c, GRUPOS_ROOMING_ROLES);
    const entry = await guarded(() => repoOf(c).cancelRoomingEntry(pid(c), requireUuid(c.req.param("entryId"), "entryId"), actorOf(c)));
    return c.json(serializeEntry(entry));
  });

  app.post("/hoteles/:propertyId/grupos/bloqueos/:id/liberar", async (c) => {
    assertVerticalRole(c, GRUPOS_MANAGE_ROLES);
    const released = await guarded(() => repoOf(c).releaseBlock(pid(c), requireUuid(c.req.param("id"), "id"), actorOf(c)));
    return c.json({ cuartosNocheLiberados: released });
  });

  app.post("/hoteles/:propertyId/grupos/bloqueos/:id/cancelar", async (c) => {
    assertVerticalRole(c, GRUPOS_MANAGE_ROLES);
    const reason = requireText((await readBody(c)).motivo, "motivo", 5, 300);
    const released = await guarded(() => repoOf(c).cancelBlock(pid(c), requireUuid(c.req.param("id"), "id"), reason, actorOf(c)));
    return c.json({ cuartosNocheLiberados: released });
  });

  return app;
}
