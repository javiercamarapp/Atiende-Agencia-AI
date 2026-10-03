// C-11 -- bandeja de conversaciones de WhatsApp de citas con handoff a humano (migracion 031). Patron probado de restaurantes R-21
// (routes/verticals/restaurantes/conversaciones-admin.ts), reducido al canal de WhatsApp de citas. Por sucursal (`:propertyId`):
//   GET  .../admin/conversaciones                              bandeja: ultimo mensaje, estado, cita vinculada y marca de crisis
//   GET  .../admin/conversaciones/:conversationId              detalle (mensajes, toma, notas internas)
//   POST .../admin/conversaciones/:conversationId/tomar        el humano toma la conversacion (el agente CALLA)
//   POST .../admin/handoffs/:handoffId/devolver | cerrar       devolver al agente / resolver
//   POST .../admin/handoffs/:handoffId/notas                   nota interna (tope 2000 caracteres)
//   POST .../admin/handoffs/:handoffId/responder               respuesta humana por el outbox de WhatsApp (nunca habla con Meta)
//
// Autorizacion: owner/admin/staff (los tres roles de citas) en todo. RLS y las funciones SQL de la migracion 031 son la autoridad (alcance
// por organizacion y por `membership.property_ids`); esta capa da defensa en profundidad y mejores mensajes. Base SIN migrar: lecturas ->
// `disponible: false` con lista vacia; escrituras -> 503. Privacidad: el telefono del cliente sale ENMASCARADO (***1234) y los registros
// de log solo llevan ids.
// Las respuestas humanas fuera de la ventana de 24 h de Meta requieren plantilla HSM (PL-31): el despachador las deja en `dead`.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  CITAS_ROLES,
  ConversacionesConflictoError,
  ConversacionesNoDisponibleError,
  ConversacionesRechazadaError,
  ConversacionesValidacionError,
  HANDOFF_ESTADOS,
  HandoffYaTomadoError,
  NOTA_MAX,
  RESPUESTA_MAX,
  SinNumeroWhatsappError,
  STAFF_INVITE_ROLES,
} from "@atiende/domain-citas";
import type { BandejaItem, ConversacionesRepository, HandoffEstado } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { enmascararTelefono } from "./avisos.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseEntero(value: string | undefined, campo: string, min: number, max: number, porDefecto: number): number {
  if (value === undefined || value === "") return porDefecto;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw Errors.validation(`${campo}: se esperaba un entero entre ${min} y ${max}.`);
  return n;
}

function parseUuid(value: string | undefined, campo: string): string {
  if (!value || !UUID_RE.test(value)) throw Errors.notFound(`${campo} no encontrado.`);
  return value;
}

function parseTexto(raw: unknown, campo: string, max: number): string {
  if (typeof raw !== "string" || raw.trim().length < 1 || raw.trim().length > max) throw Errors.validation(`${campo}: texto de 1 a ${max} caracteres.`);
  return raw.trim();
}

/** Traduce los errores del repositorio a HTTP; cualquier otro se repropaga. */
function aHttp(err: unknown): never {
  if (err instanceof ConversacionesNoDisponibleError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof HandoffYaTomadoError) throw Errors.conflict(err.message);
  if (err instanceof SinNumeroWhatsappError) throw Errors.conflict(err.message);
  if (err instanceof ConversacionesConflictoError) throw Errors.conflict(err.message);
  if (err instanceof ConversacionesRechazadaError) throw Errors.forbidden(err.message);
  if (err instanceof ConversacionesValidacionError) throw Errors.validation(err.message);
  throw err;
}

function serializeItem(i: BandejaItem, userId: string) {
  return {
    conversationId: i.conversationId,
    telefono: enmascararTelefono(i.telefono),
    vistaPrevia: i.vistaPrevia,
    actividadEn: i.actividadAt,
    estado: i.estado,
    handoffId: i.handoffId,
    motivo: i.motivo,
    crisis: i.crisis,
    solicitadaEn: i.solicitadaAt,
    ultimoClienteEn: i.ultimoClienteAt,
    tomadaPor: i.tomadaPor,
    tomadaPorNombre: i.tomadaPorNombre,
    tomadaEn: i.tomadaAt,
    esMia: i.estado === "tomada" && i.tomadaPor === userId,
    cita: i.citaId ? { id: i.citaId, iniciaEn: i.citaInicio, estado: i.citaEstado } : null,
  };
}

export function citasConversacionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/citas/properties/:propertyId/admin";
  const paths = {
    bandeja: `${base}/conversaciones`,
    detalle: `${base}/conversaciones/:conversationId`,
    tomar: `${base}/conversaciones/:conversationId/tomar`,
    devolver: `${base}/handoffs/:handoffId/devolver`,
    cerrar: `${base}/handoffs/:handoffId/cerrar`,
    notas: `${base}/handoffs/:handoffId/notas`,
    responder: `${base}/handoffs/:handoffId/responder`,
  };
  for (const path of Object.values(paths)) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  function repo(c: Context<CoreAuthHonoEnv>): ConversacionesRepository {
    if (!deps.citasConversacionesRepo) throw Errors.serviceUnavailable("Las conversaciones con handoff no están disponibles en este despliegue.");
    return deps.citasConversacionesRepo(c.get("db"));
  }

  /** owner/admin pueden devolver o cerrar la toma de otra persona (la base lo vuelve a exigir): el panel lo usa solo para mostrar los botones. */
  function puedeGestionar(c: Context<CoreAuthHonoEnv>): boolean {
    return STAFF_INVITE_ROLES.includes((c.get("verticalRole") ?? "") as never);
  }

  /** `requirePropertyMembership` ya fijo organizacion y sucursal reales del staff; aqui solo se exige el rol de citas. */
  function contexto(c: Context<CoreAuthHonoEnv>): { organizationId: string; propertyId: string } {
    assertVerticalRole(c, CITAS_ROLES);
    return { organizationId: c.get("organizationId"), propertyId: c.req.param("propertyId") ?? "" };
  }

  app.get(paths.bandeja, async (c) => {
    const { organizationId, propertyId } = contexto(c);
    const estado = c.req.query("estado");
    if (estado !== undefined && estado !== "" && !(HANDOFF_ESTADOS as readonly string[]).includes(estado)) throw Errors.validation(`estado: debe ser uno de ${HANDOFF_ESTADOS.join(", ")}.`);
    const limit = parseEntero(c.req.query("limit"), "limit", 1, 100, 25);
    const offset = parseEntero(c.req.query("offset"), "offset", 0, 1_000_000, 0);
    try {
      const lectura = await repo(c).listarBandeja(organizationId, propertyId, { estado: (estado || null) as HandoffEstado | null, limit, offset });
      return c.json({
        disponible: lectura.disponible,
        total: lectura.valor.total,
        nextOffset: offset + limit < lectura.valor.total ? offset + limit : null,
        puedeGestionar: puedeGestionar(c),
        items: lectura.valor.items.map((i) => serializeItem(i, c.get("userId"))),
      });
    } catch (err) {
      return aHttp(err);
    }
  });

  app.get(paths.detalle, async (c) => {
    const { organizationId, propertyId } = contexto(c);
    const conversationId = parseUuid(c.req.param("conversationId"), "Conversación");
    try {
      const lectura = await repo(c).detalle(organizationId, propertyId, conversationId);
      if (!lectura.disponible) throw Errors.serviceUnavailable("Las conversaciones con handoff todavía no están disponibles en esta base de datos.");
      if (!lectura.valor) throw Errors.notFound("Conversación no encontrada.");
      const d = lectura.valor;
      return c.json({
        conversationId: d.conversationId,
        telefono: enmascararTelefono(d.telefono),
        citaId: d.citaId,
        puedeGestionar: puedeGestionar(c),
        mensajes: d.mensajes.map((m) => ({ rol: m.rol, texto: m.texto })),
        handoff: d.handoff
          ? {
              handoffId: d.handoff.handoffId, estado: d.handoff.estado, solicitadoPor: d.handoff.solicitadoPor, motivo: d.handoff.motivo, crisis: d.handoff.crisis,
              solicitadaEn: d.handoff.solicitadaAt, ultimoClienteEn: d.handoff.ultimoClienteAt, tomadaPor: d.handoff.tomadaPor, tomadaPorNombre: d.handoff.tomadaPorNombre, tomadaEn: d.handoff.tomadaAt,
              esMia: d.handoff.estado === "tomada" && d.handoff.tomadaPor === c.get("userId"),
            }
          : null,
        notas: d.notas.map((n) => ({ id: n.id, autor: n.autorNombre, autorId: n.autorId, texto: n.texto, creadoEn: n.createdAt })),
      });
    } catch (err) {
      return aHttp(err);
    }
  });

  app.post(paths.tomar, async (c) => {
    const { organizationId, propertyId } = contexto(c);
    const conversationId = parseUuid(c.req.param("conversationId"), "Conversación");
    try {
      const handoffId = await repo(c).tomar(organizationId, propertyId, conversationId);
      logEvent(c, "info", "citas_handoff_tomado", { actorUserId: c.get("userId"), organizationId, propertyId, conversationId, handoffId });
      return c.json({ handoffId, estado: "tomada" }, 201);
    } catch (err) {
      return aHttp(err);
    }
  });

  for (const [accion, path] of [["devolver", paths.devolver], ["cerrar", paths.cerrar]] as const) {
    app.post(path, async (c) => {
      const { organizationId, propertyId } = contexto(c);
      const handoffId = parseUuid(c.req.param("handoffId"), "Handoff");
      try {
        const r = repo(c);
        const hecho = accion === "devolver" ? await r.devolver(organizationId, propertyId, handoffId) : await r.cerrar(organizationId, propertyId, handoffId);
        logEvent(c, "info", `citas_handoff_${accion}`, { actorUserId: c.get("userId"), organizationId, propertyId, handoffId, hecho });
        return c.json({ handoffId, estado: accion === "devolver" ? "devuelta" : "cerrada", cambio: hecho });
      } catch (err) {
        return aHttp(err);
      }
    });
  }

  app.post(paths.notas, async (c) => {
    const { organizationId, propertyId } = contexto(c);
    const handoffId = parseUuid(c.req.param("handoffId"), "Handoff");
    const body = await readJsonCapped<{ texto?: unknown }>(c.req.raw, 8 * 1024);
    const texto = parseTexto(body.texto, "texto", NOTA_MAX);
    try {
      const id = await repo(c).agregarNota(organizationId, propertyId, handoffId, texto);
      logEvent(c, "info", "citas_handoff_nota", { actorUserId: c.get("userId"), organizationId, propertyId, handoffId });
      return c.json({ id }, 201);
    } catch (err) {
      return aHttp(err);
    }
  });

  app.post(paths.responder, async (c) => {
    const { organizationId, propertyId } = contexto(c);
    const handoffId = parseUuid(c.req.param("handoffId"), "Handoff");
    const body = await readJsonCapped<{ texto?: unknown }>(c.req.raw, 8 * 1024);
    const texto = parseTexto(body.texto, "texto", RESPUESTA_MAX);
    try {
      const outboxId = await repo(c).responder(organizationId, propertyId, handoffId, texto);
      logEvent(c, "info", "citas_handoff_respuesta_humana", { actorUserId: c.get("userId"), organizationId, propertyId, handoffId });
      return c.json({ encolado: true, outboxId }, 201);
    } catch (err) {
      return aHttp(err);
    }
  });

  return app;
}
