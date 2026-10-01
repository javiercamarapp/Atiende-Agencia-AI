// R-21: bandeja de conversaciones por sucursal (WhatsApp y voz), handoff a humano, turnos de personal,
// notas internas y registro de callbacks (migracion 028). Por sucursal (`:propertyId`):
//   GET  .../admin/conversaciones                              bandeja + cobertura de turno + escalacion
//   GET  .../admin/conversaciones/:canal/:conversationId       detalle (mensajes/transcripcion, toma, notas)
//   POST .../admin/conversaciones/:canal/:conversationId/tomar el humano toma la conversacion (el agente calla)
//   POST .../admin/handoffs/:handoffId/devolver | cerrar       devolver al agente / resolver
//   POST .../admin/handoffs/:handoffId/notas                   nota interna
//   POST .../admin/handoffs/:handoffId/responder               respuesta humana por WhatsApp (outbox)
//   GET  .../admin/turnos   PUT .../admin/turnos               turnos de personal y quien esta de guardia
//   GET  .../admin/callbacks   POST .../admin/callbacks/:callbackId/intentos   registro de callbacks
//
// Autorizacion: owner/admin/staff (`MANAGER_ROLES`; el repartidor nunca) en todo; los turnos solo se
// escriben como owner/admin (`STAFF_INVITE_ROLES`). RLS y las funciones SQL de la migracion 028 son la
// autoridad (alcance por `membership.property_ids`); esta capa da defensa en profundidad y mejores mensajes.
// Base SIN migrar: lecturas -> `disponible: false` con listas vacias; escrituras -> 503.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  CALLBACK_RESULTADOS,
  CONVERSACION_CANALES,
  ConversacionesNoDisponibleError,
  ConversacionesRechazadaError,
  ConversacionesValidacionError,
  HANDOFF_ESTADOS,
  HandoffYaTomadoError,
  MANAGER_ROLES,
  NOTA_MAX,
  RESPUESTA_MAX,
  SinNumeroWhatsappError,
  STAFF_INVITE_ROLES,
  calcularCobertura,
  calcularEscalacion,
  validarTurnos,
} from "@atiende/domain-restaurantes";
import type { BandejaItem, CallbackResultado, ConversacionCanal, ConversacionesRepository, HandoffEstado } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseEntero(value: string | undefined, campo: string, min: number, max: number, porDefecto: number): number {
  if (value === undefined || value === "") return porDefecto;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw Errors.validation(`${campo}: se esperaba un entero entre ${min} y ${max}.`);
  return n;
}

function parseCanal(value: string | undefined): ConversacionCanal {
  if (!value || !(CONVERSACION_CANALES as readonly string[]).includes(value)) throw Errors.validation(`canal: debe ser uno de ${CONVERSACION_CANALES.join(", ")}.`);
  return value as ConversacionCanal;
}

function parseUuid(value: string | undefined, campo: string): string {
  if (!value || !UUID_RE.test(value)) throw Errors.notFound(`${campo} no encontrado.`);
  return value;
}

function parseTexto(raw: unknown, campo: string, max: number): string {
  if (typeof raw !== "string" || raw.trim().length < 1 || raw.length > max) throw Errors.validation(`${campo}: texto de 1 a ${max} caracteres.`);
  return raw.trim();
}

/** Traduce los errores del repositorio a HTTP; cualquier otro se repropaga. */
function aHttp(err: unknown): never {
  if (err instanceof ConversacionesNoDisponibleError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof HandoffYaTomadoError) throw Errors.conflict(err.message);
  if (err instanceof SinNumeroWhatsappError) throw Errors.conflict(err.message);
  if (err instanceof ConversacionesRechazadaError) throw Errors.forbidden(err.message);
  if (err instanceof ConversacionesValidacionError) throw Errors.validation(err.message);
  throw err;
}

export function restaurantesConversacionesAdminRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/restaurantes/:propertyId/admin";
  const paths = {
    bandeja: `${base}/conversaciones`,
    detalle: `${base}/conversaciones/:canal/:conversationId`,
    tomar: `${base}/conversaciones/:canal/:conversationId/tomar`,
    devolver: `${base}/handoffs/:handoffId/devolver`,
    cerrar: `${base}/handoffs/:handoffId/cerrar`,
    notas: `${base}/handoffs/:handoffId/notas`,
    responder: `${base}/handoffs/:handoffId/responder`,
    turnos: `${base}/turnos`,
    callbacks: `${base}/callbacks`,
    intentos: `${base}/callbacks/:callbackId/intentos`,
  };
  for (const path of Object.values(paths)) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  function repo(c: Context<CoreAuthHonoEnv>): ConversacionesRepository {
    if (!deps.conversacionesRepo) throw Errors.serviceUnavailable("Las conversaciones con handoff no están disponibles en este despliegue.");
    return deps.conversacionesRepo(c.get("db"));
  }

  /** La sucursal debe existir en ESTA organizacion y estar dentro del alcance del staff. */
  async function resolverSucursal(c: Context<CoreAuthHonoEnv>, roles: readonly string[] = MANAGER_ROLES): Promise<{ organizationId: string; propertyId: string }> {
    assertVerticalRole(c, roles);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    await resolveEffectivePropertyIds(deps, c, organizationId, propertyId);
    return { organizationId, propertyId };
  }

  async function zonaDe(c: Context<CoreAuthHonoEnv>, organizationId: string, propertyId: string): Promise<string | null> {
    // Degrada a `null` (default de plataforma) contra la base sin la migración 022; nunca lanza.
    void organizationId;
    return (await deps.restaurantesRepo(c.get("db")).findBranchZonaHoraria(propertyId)).zonaHoraria;
  }

  function serializeItem(i: BandejaItem, escalacion: ReturnType<typeof calcularEscalacion>) {
    return {
      canal: i.canal,
      conversationId: i.conversationId,
      telefono: i.telefono,
      vistaPrevia: i.vistaPrevia,
      actividadEn: i.actividadAt,
      estado: i.estado,
      handoffId: i.handoffId,
      motivo: i.motivo,
      solicitadaEn: i.solicitadaAt,
      ultimoClienteEn: i.ultimoClienteAt,
      tomadaPor: i.tomadaPor,
      tomadaPorNombre: i.tomadaPorNombre,
      tomadaEn: i.tomadaAt,
      resultadoVoz: i.resultadoVoz,
      escalacion: escalacion
        ? { nivel: escalacion.nivel, minutosEspera: escalacion.minutosEspera, sinCobertura: escalacion.sinCobertura, avisarAdministracion: escalacion.avisarAdministracion, destinatarios: escalacion.destinatarios.map((d) => ({ userId: d.userId, nombre: d.nombre, orden: d.orden })) }
        : null,
    };
  }

  function serializeCobertura(co: ReturnType<typeof calcularCobertura>) {
    return {
      sinCobertura: co.sinCobertura,
      turnosVigentes: co.turnosVigentes.map((t) => ({ id: t.id, nombre: t.nombre, inicia: t.inicia, termina: t.termina })),
      guardia: co.guardia.map((g) => ({ userId: g.userId, nombre: g.nombre, turno: g.turnoNombre, orden: g.orden })),
    };
  }

  app.get(paths.bandeja, async (c) => {
    const { organizationId, propertyId } = await resolverSucursal(c);
    const estado = c.req.query("estado");
    if (estado !== undefined && estado !== "" && !(HANDOFF_ESTADOS as readonly string[]).includes(estado)) throw Errors.validation(`estado: debe ser uno de ${HANDOFF_ESTADOS.join(", ")}.`);
    const canalRaw = c.req.query("canal");
    const canal = canalRaw ? parseCanal(canalRaw) : null;
    const limit = parseEntero(c.req.query("limit"), "limit", 1, 100, 25);
    const offset = parseEntero(c.req.query("offset"), "offset", 0, 1_000_000, 0);
    const r = repo(c);
    try {
      const lectura = await r.listarBandeja(organizationId, propertyId, { estado: (estado || null) as HandoffEstado | null, canal, limit, offset });
      const turnos = await r.listarTurnos(organizationId, propertyId);
      const ahora = new Date();
      const cobertura = calcularCobertura(turnos.valor, ahora, await zonaDe(c, organizationId, propertyId));
      return c.json({
        disponible: lectura.disponible,
        total: lectura.valor.total,
        nextOffset: offset + limit < lectura.valor.total ? offset + limit : null,
        cobertura: serializeCobertura(cobertura),
        items: lectura.valor.items.map((i) => serializeItem(i, calcularEscalacion({ estado: i.estado, solicitadaAt: i.solicitadaAt }, cobertura, ahora))),
      });
    } catch (err) {
      return aHttp(err);
    }
  });

  app.get(paths.detalle, async (c) => {
    const { organizationId, propertyId } = await resolverSucursal(c);
    const canal = parseCanal(c.req.param("canal"));
    const conversationId = parseUuid(c.req.param("conversationId"), "Conversación");
    try {
      const lectura = await repo(c).detalle(organizationId, propertyId, canal, conversationId);
      if (!lectura.disponible) throw Errors.serviceUnavailable("Las conversaciones con handoff todavía no están disponibles en esta base de datos.");
      if (!lectura.valor) throw Errors.notFound("Conversación no encontrada.");
      const d = lectura.valor;
      return c.json({
        canal: d.canal,
        conversationId: d.conversationId,
        transcripcionDisponible: d.transcripcionDisponible,
        mensajes: d.mensajes.map((m) => ({ rol: m.rol, texto: m.texto, creadoEn: m.createdAt })),
        handoff: d.handoff
          ? { handoffId: d.handoff.handoffId, estado: d.handoff.estado, solicitadoPor: d.handoff.solicitadoPor, motivo: d.handoff.motivo, solicitadaEn: d.handoff.solicitadaAt, ultimoClienteEn: d.handoff.ultimoClienteAt, tomadaPor: d.handoff.tomadaPor, tomadaPorNombre: d.handoff.tomadaPorNombre, tomadaEn: d.handoff.tomadaAt }
          : null,
        notas: d.notas.map((n) => ({ id: n.id, autor: n.autorNombre, autorId: n.autorId, texto: n.texto, creadoEn: n.createdAt })),
      });
    } catch (err) {
      return aHttp(err);
    }
  });

  app.post(paths.tomar, async (c) => {
    const { organizationId, propertyId } = await resolverSucursal(c);
    const canal = parseCanal(c.req.param("canal"));
    const conversationId = parseUuid(c.req.param("conversationId"), "Conversación");
    try {
      const handoffId = await repo(c).tomar(organizationId, propertyId, canal, conversationId);
      logEvent(c, "info", "restaurantes_handoff_tomado", { actorUserId: c.get("userId"), organizationId, propertyId, canal, handoffId });
      return c.json({ handoffId, estado: "tomada" }, 201);
    } catch (err) {
      return aHttp(err);
    }
  });

  for (const [accion, path] of [["devolver", paths.devolver], ["cerrar", paths.cerrar]] as const) {
    app.post(path, async (c) => {
      const { organizationId, propertyId } = await resolverSucursal(c);
      const handoffId = parseUuid(c.req.param("handoffId"), "Handoff");
      try {
        const r = repo(c);
        const hecho = accion === "devolver" ? await r.devolver(organizationId, propertyId, handoffId) : await r.cerrar(organizationId, propertyId, handoffId);
        logEvent(c, "info", `restaurantes_handoff_${accion}`, { actorUserId: c.get("userId"), organizationId, propertyId, handoffId, hecho });
        return c.json({ handoffId, estado: accion === "devolver" ? "devuelta" : "cerrada", cambio: hecho });
      } catch (err) {
        return aHttp(err);
      }
    });
  }

  app.post(paths.notas, async (c) => {
    const { organizationId, propertyId } = await resolverSucursal(c);
    const handoffId = parseUuid(c.req.param("handoffId"), "Handoff");
    const body = await readJsonCapped<{ texto?: unknown }>(c.req.raw, 8 * 1024);
    const texto = parseTexto(body.texto, "texto", NOTA_MAX);
    try {
      const id = await repo(c).agregarNota(organizationId, propertyId, handoffId, texto);
      return c.json({ id }, 201);
    } catch (err) {
      return aHttp(err);
    }
  });

  app.post(paths.responder, async (c) => {
    const { organizationId, propertyId } = await resolverSucursal(c);
    const handoffId = parseUuid(c.req.param("handoffId"), "Handoff");
    const body = await readJsonCapped<{ texto?: unknown }>(c.req.raw, 8 * 1024);
    const texto = parseTexto(body.texto, "texto", RESPUESTA_MAX);
    try {
      const outboxId = await repo(c).responderWhatsapp(organizationId, propertyId, handoffId, texto);
      logEvent(c, "info", "restaurantes_handoff_respuesta_humana", { actorUserId: c.get("userId"), organizationId, propertyId, handoffId });
      return c.json({ encolado: true, outboxId }, 201);
    } catch (err) {
      return aHttp(err);
    }
  });

  app.get(paths.turnos, async (c) => {
    const { organizationId, propertyId } = await resolverSucursal(c);
    try {
      const lectura = await repo(c).listarTurnos(organizationId, propertyId);
      const cobertura = calcularCobertura(lectura.valor, new Date(), await zonaDe(c, organizationId, propertyId));
      return c.json({
        disponible: lectura.disponible,
        turnos: lectura.valor.map((t) => ({ id: t.id, nombre: t.nombre, dias: t.dias, inicia: t.inicia, termina: t.termina, miembros: t.miembros.map((m) => ({ userId: m.userId, nombre: m.nombre, orden: m.orden })) })),
        cobertura: serializeCobertura(cobertura),
      });
    } catch (err) {
      return aHttp(err);
    }
  });

  app.put(paths.turnos, async (c) => {
    const { organizationId, propertyId } = await resolverSucursal(c, STAFF_INVITE_ROLES);
    const body = await readJsonCapped<{ turnos?: unknown }>(c.req.raw, 32 * 1024);
    let turnos;
    try {
      turnos = validarTurnos(body.turnos);
    } catch (err) {
      return aHttp(err);
    }
    try {
      await repo(c).reemplazarTurnos(organizationId, propertyId, turnos);
    } catch (err) {
      return aHttp(err);
    }
    logEvent(c, "info", "restaurantes_admin_turnos_actualizados", { actorUserId: c.get("userId"), organizationId, propertyId, turnos: turnos.length });
    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.turnos_actualizados",
      entityType: "configuracion",
      entityId: propertyId,
      campo: "turnos",
      antes: null,
      despues: JSON.stringify(turnos.map((t) => ({ nombre: t.nombre, inicia: t.inicia, termina: t.termina, miembros: t.miembros.length }))).slice(0, 500),
    });
    const lectura = await repo(c).listarTurnos(organizationId, propertyId);
    return c.json({ disponible: lectura.disponible, turnos: lectura.valor });
  });

  app.get(paths.callbacks, async (c) => {
    const { organizationId, propertyId } = await resolverSucursal(c);
    const soloAbiertos = c.req.query("soloAbiertos") === "1";
    try {
      const lectura = await repo(c).listarCallbacks(organizationId, propertyId, soloAbiertos);
      return c.json({
        disponible: lectura.disponible,
        items: lectura.valor.map((cb) => ({
          id: cb.id, sucursalId: cb.propertyId, nombre: cb.customerName, telefono: cb.customerPhone, motivo: cb.reason, mensaje: cb.message, origen: cb.source, resuelto: cb.resolved, creadoEn: cb.createdAt,
          intentos: cb.intentos.map((i) => ({ id: i.id, resultado: i.resultado, nota: i.nota, proximoIntentoEn: i.proximoIntentoAt, autor: i.autor, creadoEn: i.creadoAt })),
        })),
      });
    } catch (err) {
      return aHttp(err);
    }
  });

  app.post(paths.intentos, async (c) => {
    const { organizationId } = await resolverSucursal(c);
    const callbackId = parseUuid(c.req.param("callbackId"), "Callback");
    const body = await readJsonCapped<{ resultado?: unknown; nota?: unknown; proximoIntentoEn?: unknown }>(c.req.raw, 8 * 1024);
    if (typeof body.resultado !== "string" || !(CALLBACK_RESULTADOS as readonly string[]).includes(body.resultado)) {
      throw Errors.validation(`resultado: debe ser uno de ${CALLBACK_RESULTADOS.join(", ")}.`);
    }
    if (body.nota !== undefined && body.nota !== null && (typeof body.nota !== "string" || body.nota.length > 1000)) throw Errors.validation("nota: texto de hasta 1000 caracteres.");
    let proximo: string | null = null;
    if (body.proximoIntentoEn !== undefined && body.proximoIntentoEn !== null) {
      const t = typeof body.proximoIntentoEn === "string" ? new Date(body.proximoIntentoEn) : null;
      if (!t || Number.isNaN(t.getTime())) throw Errors.validation("proximoIntentoEn: fecha ISO válida.");
      proximo = t.toISOString();
    }
    try {
      const id = await repo(c).registrarIntentoCallback(organizationId, callbackId, { resultado: body.resultado as CallbackResultado, nota: (body.nota as string | null | undefined) ?? null, proximoIntentoAt: proximo });
      logEvent(c, "info", "restaurantes_callback_intento", { actorUserId: c.get("userId"), organizationId, callbackId, resultado: body.resultado });
      return c.json({ id }, 201);
    } catch (err) {
      return aHttp(err);
    }
  });

  return app;
}
