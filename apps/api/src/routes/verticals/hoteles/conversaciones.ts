// H-20 -- bandeja de conversaciones de WhatsApp con handoff a humano (hoteles).
//   GET  /hoteles/:propertyId/conversaciones?estado=&noLeidas=1&huespedId=&limit=&offset=   bandeja (filtros por estado y no leidas)
//   GET  /hoteles/:propertyId/conversaciones/:id                     detalle: mensajes, responsable, handoff, notas (PII minimizada segun rol)
//   POST /hoteles/:propertyId/conversaciones/:id/leer                pone en cero los no leidos
//   POST /hoteles/:propertyId/conversaciones/:id/tomar               una persona toma la conversacion (el agente calla); concurrente -> uno gana (409)
//   POST /hoteles/:propertyId/conversaciones/:id/devolver-al-agente  vuelve a atenderla el agente
//   POST /hoteles/:propertyId/conversaciones/:id/cerrar              cierra (se reabre sola si el huesped vuelve a escribir)
//   POST /hoteles/:propertyId/conversaciones/:id/notas               nota interna
//   POST /hoteles/:propertyId/conversaciones/:id/responder           respuesta humana: se ENCOLA en messaging_outbox (sin credenciales de Meta queda pendiente_envio)
//
// Roles: owner, gm, frontdesk, reservations (los que gestionan reservas). La base (migracion 043) es la autoridad: rol, property,
// transicion y responsable; esta capa da defensa en profundidad, mejores mensajes y la minimizacion de PII por rol: owner/gm ven el
// telefono completo; frontdesk/reservations lo ven enmascarado y el texto sin correos ni numeros largos.
//
// REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: las lecturas responden `disponible: false` con lista vacia y las escrituras 503
// honesto (SAVEPOINT en `PostgresConversacionesRepository`), nunca un 500. Misma forma que restaurantes para que PL-14 la absorba.
import { Hono } from "hono";
import type { Context } from "hono";
import { ApiError, assertVerticalRole, authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  CONVERSACIONES_PII_ROLES,
  CONVERSACIONES_ROLES,
  CONVERSACION_FILTROS,
  ConversacionesConflictoError,
  ConversacionesNoDisponibleError,
  ConversacionesNoEncontradaError,
  ConversacionesRechazadaError,
  ConversacionesValidacionError,
  PostgresConversacionesRepository,
  claveTelefonoConversacion,
  enmascararTelefono,
  minimizarTextoPii,
  motivoHandoffTexto,
  validarTextoConversacion,
  type ConversacionActor,
  type ConversacionDetalle,
  type ConversacionFiltro,
  type ConversacionItem,
  type ConversacionesRepository,
  type HotelRole,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toApiError(err: unknown): unknown {
  if (err instanceof ConversacionesNoDisponibleError) return Errors.serviceUnavailable(err.message);
  if (err instanceof ConversacionesNoEncontradaError) return Errors.notFound(err.message);
  if (err instanceof ConversacionesConflictoError) return new ApiError(409, err.codigo, err.message);
  if (err instanceof ConversacionesRechazadaError) return Errors.forbidden(err.message);
  if (err instanceof ConversacionesValidacionError) return Errors.validation(err.message);
  return err;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

function parseEntero(value: string | undefined, campo: string, min: number, max: number, porDefecto: number): number {
  if (value === undefined || value === "") return porDefecto;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw Errors.validation(`${campo}: se esperaba un entero entre ${min} y ${max}.`);
  return n;
}

/** Minimizacion de PII por rol: owner/gm ven todo; el resto, telefono enmascarado y texto sin correos ni numeros largos. */
function vista(role: string) {
  const completo = (CONVERSACIONES_PII_ROLES as readonly string[]).includes(role);
  return {
    telefono: (t: string) => (completo ? t : enmascararTelefono(t)),
    texto: <T extends string | null>(t: T): T => (completo || t === null ? t : (minimizarTextoPii(t) as T)),
    completo,
  };
}

function serializeItem(i: ConversacionItem, v: ReturnType<typeof vista>) {
  return {
    id: i.id,
    telefono: v.telefono(i.telefono),
    estado: i.modo,
    porAtender: i.modo === "humano" && i.responsableId === null,
    responsable: i.responsableId === null ? null : { id: i.responsableId, nombre: i.responsableNombre },
    tomadaEn: i.tomadaEn,
    motivo: i.motivo,
    motivoTexto: motivoHandoffTexto(i.motivo),
    derivadaEn: i.handoffEn,
    noLeidos: i.noLeidos,
    ultimoMensajeDelHuespedEn: i.ultimoEntranteEn,
    actividadEn: i.actividadEn,
    vistaPrevia: v.texto(i.vistaPrevia),
    ultimoRol: i.ultimoRol,
    huesped: i.huespedId === null ? null : { id: i.huespedId, nombre: i.huespedNombre },
  };
}

function serializeDetalle(d: ConversacionDetalle, v: ReturnType<typeof vista>, userId: string) {
  return {
    ...serializeItem(d, v),
    cerradaEn: d.cerradaEn,
    derivaciones: d.handoffN,
    esResponsable: d.responsableId === userId,
    totalMensajes: d.totalMensajes,
    mensajes: d.mensajes.map((m) => ({ rol: m.rol, origen: m.origen, texto: v.texto(m.texto), creadoEn: m.creadoEn, envio: m.envio })),
    notas: d.notas.map((n) => ({ id: n.id, autor: n.autorNombre, autorId: n.autorId, texto: v.texto(n.texto), creadaEn: n.creadaEn })),
  };
}

export function hotelesConversacionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/conversaciones", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/conversaciones/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  const repoOf = (c: Context<CoreAuthHonoEnv>): ConversacionesRepository =>
    deps.hotelesConversacionesRepo ? deps.hotelesConversacionesRepo(c.get("db")) : new PostgresConversacionesRepository(c.get("db"));

  function contexto(c: Context<CoreAuthHonoEnv>): { propertyId: string; actor: ConversacionActor; role: string } {
    assertVerticalRole(c, CONVERSACIONES_ROLES);
    const role = c.get("verticalRole") as HotelRole;
    return { propertyId: c.req.param("propertyId") ?? "", actor: { userId: c.get("userId"), role }, role };
  }

  function idOf(c: Context<CoreAuthHonoEnv>): string {
    const id = c.req.param("id") ?? "";
    if (!UUID_RE.test(id)) throw Errors.notFound("Conversación no encontrada.");
    return id;
  }

  app.get("/hoteles/:propertyId/conversaciones", async (c) => {
    const { propertyId, actor, role } = contexto(c);
    const estado = c.req.query("estado");
    if (estado !== undefined && estado !== "" && !(CONVERSACION_FILTROS as readonly string[]).includes(estado)) {
      throw Errors.validation(`estado: debe ser uno de ${CONVERSACION_FILTROS.join(", ")}.`);
    }
    const noLeidas = c.req.query("noLeidas");
    if (noLeidas !== undefined && noLeidas !== "" && noLeidas !== "0" && noLeidas !== "1") throw Errors.validation("noLeidas: 0 o 1.");
    const limit = parseEntero(c.req.query("limit"), "limit", 1, 100, 25);
    const offset = parseEntero(c.req.query("offset"), "offset", 0, 1_000_000, 0);
    // Enlace desde la ficha del huesped: el telefono lo resuelve el servidor desde el huesped DE ESTA property (el cliente nunca manda un telefono).
    let telefonoClave: string | null = null;
    const huespedId = c.req.query("huespedId");
    if (huespedId !== undefined && huespedId !== "") {
      if (!UUID_RE.test(huespedId)) throw Errors.validation("huespedId: se esperaba un UUID.");
      const guest = await deps.hotelesRepo(c.get("db")).findGuestById(propertyId, huespedId);
      if (!guest) throw Errors.notFound("Huésped no encontrado.");
      telefonoClave = claveTelefonoConversacion(guest.phone);
      if (telefonoClave === null) {
        return c.json({ disponible: true, total: 0, siguiente: null, items: [], sinTelefono: true });
      }
    }
    const lectura = await guarded(() =>
      repoOf(c).listar(actor, propertyId, { modo: (estado || null) as ConversacionFiltro | null, soloNoLeidas: noLeidas === "1", telefonoClave, limit, offset }),
    );
    const v = vista(role);
    return c.json({
      disponible: lectura.disponible,
      total: lectura.total,
      siguiente: offset + limit < lectura.total ? offset + limit : null,
      sinTelefono: false,
      items: lectura.items.map((i) => serializeItem(i, v)),
    });
  });

  app.get("/hoteles/:propertyId/conversaciones/:id", async (c) => {
    const { propertyId, actor, role } = contexto(c);
    const id = idOf(c);
    const lectura = await guarded(() => repoOf(c).detalle(actor, propertyId, id));
    if (!lectura.disponible) throw Errors.serviceUnavailable("Las conversaciones con handoff todavía no están disponibles en esta base de datos.");
    if (!lectura.valor) throw Errors.notFound("Conversación no encontrada.");
    c.header("Cache-Control", "no-store");
    return c.json(serializeDetalle(lectura.valor, vista(role), actor.userId));
  });

  app.post("/hoteles/:propertyId/conversaciones/:id/leer", async (c) => {
    const { propertyId, actor } = contexto(c);
    const id = idOf(c);
    await guarded(() => repoOf(c).leer(actor, propertyId, id));
    return c.json({ id, noLeidos: 0 });
  });

  app.post("/hoteles/:propertyId/conversaciones/:id/tomar", async (c) => {
    const { propertyId, actor } = contexto(c);
    const id = idOf(c);
    const body = await readJsonCapped<{ reasignar?: unknown }>(c.req.raw, 1024);
    if (body.reasignar !== undefined && typeof body.reasignar !== "boolean") throw Errors.validation("reasignar: booleano.");
    const r = await guarded(() => repoOf(c).tomar(actor, propertyId, id, body.reasignar === true));
    logEvent(c, "info", "hoteles_conversacion_tomada", { actorUserId: actor.userId, propertyId, conversationId: id, reasignada: body.reasignar === true });
    return c.json({ id, estado: r.modo, responsableId: r.responsableId, tomadaEn: r.tomadaEn }, 201);
  });

  app.post("/hoteles/:propertyId/conversaciones/:id/devolver-al-agente", async (c) => {
    const { propertyId, actor } = contexto(c);
    const id = idOf(c);
    const modo = await guarded(() => repoOf(c).devolver(actor, propertyId, id));
    logEvent(c, "info", "hoteles_conversacion_devuelta", { actorUserId: actor.userId, propertyId, conversationId: id });
    return c.json({ id, estado: modo });
  });

  app.post("/hoteles/:propertyId/conversaciones/:id/cerrar", async (c) => {
    const { propertyId, actor } = contexto(c);
    const id = idOf(c);
    const modo = await guarded(() => repoOf(c).cerrar(actor, propertyId, id));
    logEvent(c, "info", "hoteles_conversacion_cerrada", { actorUserId: actor.userId, propertyId, conversationId: id });
    return c.json({ id, estado: modo });
  });

  app.post("/hoteles/:propertyId/conversaciones/:id/notas", async (c) => {
    const { propertyId, actor } = contexto(c);
    const id = idOf(c);
    const body = await readJsonCapped<{ texto?: unknown }>(c.req.raw, 8 * 1024);
    const texto = await guarded(async () => validarTextoConversacion(body.texto, "texto"));
    const notaId = await guarded(() => repoOf(c).agregarNota(actor, propertyId, id, texto));
    return c.json({ id: notaId }, 201);
  });

  app.post("/hoteles/:propertyId/conversaciones/:id/responder", async (c) => {
    const { propertyId, actor } = contexto(c);
    const id = idOf(c);
    const body = await readJsonCapped<{ texto?: unknown }>(c.req.raw, 8 * 1024);
    const texto = await guarded(async () => validarTextoConversacion(body.texto, "texto"));
    const r = await guarded(() => repoOf(c).responder(actor, propertyId, id, texto));
    // Sin PII en el log: ni telefono ni texto.
    logEvent(c, "info", "hoteles_conversacion_respuesta_humana", { actorUserId: actor.userId, propertyId, conversationId: id, outboxId: r.outboxId });
    return c.json({ encolado: true, outboxId: r.outboxId, envio: r.envio }, 201);
  });

  return app;
}
