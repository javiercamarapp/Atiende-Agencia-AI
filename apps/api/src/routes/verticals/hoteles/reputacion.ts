// Fase 11/13 hoteles (REQ-CRM-002/003, P1/F) — wiring HTTP de reputación/CRM. GAP
// REAL verificado antes de esta fase (auditoría 18-sep): el dominio puro
// (`@atiende/domain-hoteles::reputacion/*`) y el modelo de datos
// (`migrations/013_reputacion.sql`) ya existían desde Fase 11, pero CERO
// invocador real -- ni una ruta HTTP, ni un solo método de `HotelesRepository`
// para ninguna de sus 2 tablas. Esta fase agrega esos métodos (ver
// `packages/domain-hoteles/src/{repository,postgres-repository,in-memory-repository}.ts`)
// + una tabla nueva chica (`hoteles.guest_review_response`,
// `migrations/021_reputacion_respuestas.sql`) que faltaba para "responder" una
// reseña -- `guest_review_action` modela solo ACCIONES REGLADAS, nunca una
// respuesta libre de staff.
//
// Captura MANUAL (encuesta propia del staff, o una reseña pública copiada/pegada)
// o un futuro webhook -- NUNCA ingesta automática real de Google/Booking/
// TripAdvisor (REQ-CRM-001, "pendiente-credenciales", ver README del paquete y el
// comentario de cabecera de la migración): este repo no tiene esas credenciales,
// así que no se fabrica ni se simula ningún conector. Todo lo que NO depende de
// esa fuente externa (capturar, clasificar, listar, ver detalle, responder,
// resolver acciones, calcular el índice agregado) queda funcionando de punta a
// punta en esta ruta.
//
// "Resolver" una acción `ticket_mantenimiento` ejecutándola crea el ticket REAL
// contra `hoteles.maintenance_ticket` (reutiliza `insertMaintenanceTicket`, el
// mismo repositorio que housekeeping.ts) -- cierra el gap que la migración 013
// dejó documentado a propósito (`ticket_id` siempre null en esa fase, "ninguna
// ruta que cree el ticket real todavía"). Ejecutar `mensaje_proactivo`
// (requiere plantilla de WhatsApp aprobada) o `compensacion_reglada` (mueve
// dinero) sigue fuera de esta fase -- resolver esas dos solo registra la
// decisión de staff (ejecutada/descartada), nunca envía ni cobra nada por su
// cuenta, mismo límite que domain-hoteles/README.md §Fase 11 documenta.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  REPUTACION_SUBMIT_ROLES,
  REPUTACION_VIEW_ROLES,
  REPUTACION_ACTION_RESOLVE_ROLES,
  clasificarResena,
  calcularIndiceReputacion,
  GuestReviewActionAlreadyResolvedError,
  type AccionReputacion,
  type GuestReviewRecord,
  type GuestReviewActionRecord,
  type GuestReviewResponseRecord,
  type GuestReviewSource,
  type StayState,
  type ResenaClasificadaParaIndice,
  type ReviewTopicId,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const REVIEW_SOURCES: readonly GuestReviewSource[] = ["google", "booking", "tripadvisor", "expedia", "encuesta_propia", "otro"];
const STAY_STATES: readonly StayState[] = ["en_estancia", "post_estancia", "desconocido"];

function serializeReview(r: GuestReviewRecord) {
  return {
    id: r.id,
    guestId: r.guestId,
    folioId: r.folioId,
    source: r.source,
    externalId: r.externalId,
    texto: r.texto,
    idioma: r.idioma,
    calificacion: r.calificacion,
    stayState: r.stayState,
    isPublic: r.isPublic,
    topics: r.topics,
    sentiment: r.sentiment,
    sentimentScore: r.sentimentScore,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

function serializeAction(a: GuestReviewActionRecord) {
  return {
    id: a.id,
    reviewId: a.reviewId,
    actionType: a.actionType,
    status: a.status,
    ticketId: a.ticketId,
    detail: a.detail,
    reason: a.reason,
    resolvedBy: a.resolvedBy,
    resolvedAt: a.resolvedAt,
    createdAt: a.createdAt,
  };
}

function serializeResponse(r: GuestReviewResponseRecord) {
  return { id: r.id, reviewId: r.reviewId, texto: r.texto, createdBy: r.createdBy, createdAt: r.createdAt };
}

/** Separa `{tipo, razon}` (persistidos en columnas propias) del resto de la acción
 *  (persistido tal cual en `detail` jsonb) -- mismo criterio documentado en
 *  `migrations/013_reputacion.sql`: "Estructura de AccionReputacion... guardada
 *  tal cual". */
function toActionTypeAndDetail(accion: AccionReputacion): { actionType: AccionReputacion["tipo"]; detail: Record<string, unknown> } {
  const { tipo, razon: _razon, ...detail } = accion;
  return { actionType: tipo, detail };
}

interface CreateReviewBody {
  readonly texto?: unknown;
  readonly calificacion?: unknown;
  readonly source?: unknown;
  readonly externalId?: unknown;
  readonly stayState?: unknown;
  readonly guestId?: unknown;
  readonly folioId?: unknown;
  readonly idioma?: unknown;
  readonly isPublic?: unknown;
  readonly temasLocalesConfigurados?: Record<string, readonly string[]>;
}

export function hotelesReputacionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/reputacion/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/reputacion", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // ---- Captura + clasificación (REQ-CRM-002/003) ----
  app.post("/hoteles/:propertyId/reputacion/resenas", async (c) => {
    assertVerticalRole(c, REPUTACION_SUBMIT_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const userId = c.get("userId");
    const repo = deps.hotelesRepo(c.get("db"));

    const raw = await readJsonCapped<CreateReviewBody>(c.req.raw, 8 * 1024);
    if (typeof raw.texto !== "string" || raw.texto.trim().length === 0 || raw.texto.length > 4000) {
      throw Errors.validation("texto: se requiere un texto de reseña/encuesta no vacío, máximo 4000 caracteres.");
    }
    if (typeof raw.source !== "string" || !REVIEW_SOURCES.includes(raw.source as GuestReviewSource)) {
      throw Errors.validation(`source: se esperaba uno de ${REVIEW_SOURCES.join("|")}.`);
    }
    if (raw.calificacion !== undefined && (typeof raw.calificacion !== "number" || raw.calificacion < 1 || raw.calificacion > 5)) {
      throw Errors.validation("calificacion: se esperaba un número entre 1 y 5, o ausente.");
    }
    if (raw.stayState !== undefined && !STAY_STATES.includes(raw.stayState as StayState)) {
      throw Errors.validation(`stayState: se esperaba uno de ${STAY_STATES.join("|")}, o ausente.`);
    }
    if (raw.guestId !== undefined && typeof raw.guestId !== "string") throw Errors.validation("guestId: se esperaba un string, o ausente.");
    if (raw.folioId !== undefined && typeof raw.folioId !== "string") throw Errors.validation("folioId: se esperaba un string, o ausente.");
    if (raw.externalId !== undefined && typeof raw.externalId !== "string") throw Errors.validation("externalId: se esperaba un string, o ausente.");
    if (raw.isPublic !== undefined && typeof raw.isPublic !== "boolean") throw Errors.validation("isPublic: se esperaba un booleano, o ausente.");

    const clasificacion = clasificarResena({
      texto: raw.texto,
      calificacion: raw.calificacion as number | undefined,
      estanciaEstado: raw.stayState as StayState | undefined,
      huespedId: (raw.guestId as string | undefined) ?? null,
      temasLocalesConfigurados: raw.temasLocalesConfigurados,
    });

    const review = await repo.insertGuestReview({
      organizationId,
      propertyId,
      guestId: (raw.guestId as string | undefined) ?? null,
      folioId: (raw.folioId as string | undefined) ?? null,
      source: raw.source as GuestReviewSource,
      externalId: (raw.externalId as string | undefined) ?? null,
      texto: raw.texto,
      idioma: (raw.idioma as string | undefined) ?? "es",
      calificacion: (raw.calificacion as number | undefined) ?? null,
      stayState: (raw.stayState as StayState | undefined) ?? "desconocido",
      isPublic: (raw.isPublic as boolean | undefined) ?? true,
      topics: clasificacion.temas,
      sentiment: clasificacion.sentimiento.etiqueta,
      sentimentScore: clasificacion.sentimiento.puntaje,
      createdBy: userId,
    });

    const acciones: GuestReviewActionRecord[] = [];
    for (const accion of clasificacion.acciones) {
      const { actionType, detail } = toActionTypeAndDetail(accion);
      acciones.push(
        await repo.insertGuestReviewAction({
          organizationId,
          propertyId,
          reviewId: review.id,
          actionType,
          status: "pendiente",
          ticketId: null,
          detail,
          reason: accion.razon,
        }),
      );
    }

    return c.json({ resena: serializeReview(review), acciones: acciones.map(serializeAction) }, 201);
  });

  app.get("/hoteles/:propertyId/reputacion/resenas", async (c) => {
    assertVerticalRole(c, REPUTACION_VIEW_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const sentiment = c.req.query("sentiment");
    if (sentiment !== undefined && !["muy_negativo", "negativo", "neutral", "positivo", "muy_positivo"].includes(sentiment)) {
      throw Errors.validation("sentiment: valor inválido.");
    }
    const resenas = await repo.listGuestReviews(c.req.param("propertyId"), sentiment ? { sentiment: sentiment as GuestReviewRecord["sentiment"] } : undefined);
    return c.json(resenas.map(serializeReview));
  });

  app.get("/hoteles/:propertyId/reputacion/resenas/:reviewId", async (c) => {
    assertVerticalRole(c, REPUTACION_VIEW_ROLES);
    const propertyId = c.req.param("propertyId");
    const reviewId = c.req.param("reviewId");
    const repo = deps.hotelesRepo(c.get("db"));
    const resena = await repo.findGuestReview(propertyId, reviewId);
    if (!resena) throw Errors.notFound("Reseña no encontrada.");
    const [acciones, respuestas] = await Promise.all([repo.listGuestReviewActions(propertyId, reviewId), repo.listGuestReviewResponses(propertyId, reviewId)]);
    return c.json({ resena: serializeReview(resena), acciones: acciones.map(serializeAction), respuestas: respuestas.map(serializeResponse) });
  });

  // ---- Responder (staff -- texto libre, nunca publicado en ningún canal externo) ----
  app.post("/hoteles/:propertyId/reputacion/resenas/:reviewId/respuestas", async (c) => {
    assertVerticalRole(c, REPUTACION_SUBMIT_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const reviewId = c.req.param("reviewId");
    const userId = c.get("userId");
    const repo = deps.hotelesRepo(c.get("db"));

    const resena = await repo.findGuestReview(propertyId, reviewId);
    if (!resena) throw Errors.notFound("Reseña no encontrada.");

    const raw = await readJsonCapped<{ texto?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof raw.texto !== "string" || raw.texto.trim().length === 0 || raw.texto.length > 2000) {
      throw Errors.validation("texto: se requiere una respuesta no vacía, máximo 2000 caracteres.");
    }

    const respuesta = await repo.insertGuestReviewResponse({ organizationId, propertyId, reviewId, texto: raw.texto, createdBy: userId });
    return c.json(serializeResponse(respuesta), 201);
  });

  app.get("/hoteles/:propertyId/reputacion/resenas/:reviewId/respuestas", async (c) => {
    assertVerticalRole(c, REPUTACION_VIEW_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const respuestas = await repo.listGuestReviewResponses(c.req.param("propertyId"), c.req.param("reviewId"));
    return c.json(respuestas.map(serializeResponse));
  });

  // ---- Resolver una acción reglada (ejecutada/descartada) ----
  async function resolver(c: Context<CoreAuthHonoEnv>) {
    assertVerticalRole(c, REPUTACION_ACTION_RESOLVE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId")!;
    const actionId = c.req.param("actionId")!;
    const userId = c.get("userId");
    const repo = deps.hotelesRepo(c.get("db"));

    const raw = await readJsonCapped<{ status?: unknown; roomId?: unknown; estimatedCost?: unknown }>(c.req.raw, 4 * 1024);
    if (raw.status !== "ejecutada" && raw.status !== "descartada") {
      throw Errors.validation('status: se esperaba "ejecutada" o "descartada".');
    }

    const accion = await repo.findGuestReviewAction(propertyId, actionId);
    if (!accion) throw Errors.notFound("Acción de reputación no encontrada.");

    let ticketId: string | null = null;
    // Único caso de esta fase que SÍ ejecuta algo real: un ticket de mantenimiento
    // -- mensaje_proactivo (plantilla de WhatsApp) y compensacion_reglada (mueve
    // dinero) permanecen fuera de alcance (ver comentario de cabecera de este
    // archivo), "ejecutada" para esas dos solo registra la decisión de staff.
    if (raw.status === "ejecutada" && accion.actionType === "ticket_mantenimiento") {
      if (raw.roomId !== undefined && typeof raw.roomId !== "string") throw Errors.validation("roomId: se esperaba un string, o ausente.");
      if (raw.estimatedCost !== undefined && (typeof raw.estimatedCost !== "number" || raw.estimatedCost < 0)) {
        throw Errors.validation("estimatedCost: se esperaba un número no negativo, o ausente.");
      }
      const detail = accion.detail as { titulo?: string; descripcion?: string; severidad?: "alta" | "media" };
      const ticket = await repo.insertMaintenanceTicket({
        organizationId,
        propertyId,
        roomId: (raw.roomId as string | undefined) ?? null,
        title: detail.titulo ?? `Ticket de mantenimiento (reputación): ${accion.reason}`,
        description: detail.descripcion ?? accion.reason,
        origin: "huesped",
        severity: detail.severidad ?? "media",
        estimatedCost: (raw.estimatedCost as number | undefined) ?? 0,
        createdBy: userId,
      });
      ticketId = ticket.id;
    }

    try {
      const resolved = await repo.resolveGuestReviewAction(propertyId, actionId, userId, raw.status, ticketId);
      return resolved;
    } catch (err) {
      if (err instanceof GuestReviewActionAlreadyResolvedError) throw Errors.conflict(err.message);
      throw err;
    }
  }

  app.post("/hoteles/:propertyId/reputacion/acciones/:actionId/resolver", async (c) => {
    const resolved = await resolver(c);
    return c.json(serializeAction(resolved), 200);
  });

  // ---- Índice de reputación agregado (métricas) ----
  app.get("/hoteles/:propertyId/reputacion/indice", async (c) => {
    assertVerticalRole(c, REPUTACION_VIEW_ROLES);
    const propertyId = c.req.param("propertyId");
    const repo = deps.hotelesRepo(c.get("db"));

    const desde = c.req.query("desde");
    const hasta = c.req.query("hasta");
    if ((desde && !/^\d{4}-\d{2}-\d{2}$/.test(desde)) || (hasta && !/^\d{4}-\d{2}-\d{2}$/.test(hasta))) {
      throw Errors.validation("desde/hasta: se esperaba una fecha ISO yyyy-mm-dd.");
    }

    const resenas = await repo.listGuestReviews(propertyId);
    const enRango = resenas.filter((r) => (!desde || r.createdAt.slice(0, 10) >= desde) && (!hasta || r.createdAt.slice(0, 10) <= hasta));
    const parasIndice: ResenaClasificadaParaIndice[] = enRango.map((r) => ({
      sentimientoEtiqueta: r.sentiment,
      sentimientoPuntaje: r.sentimentScore,
      temas: r.topics.map((t) => ({ topic: t.topic as ReviewTopicId, esConocido: t.esConocido })),
      calificacion: r.calificacion,
    }));

    return c.json(calcularIndiceReputacion(parasIndice), 200);
  });

  return app;
}
