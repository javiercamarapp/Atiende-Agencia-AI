// Back office de plataforma — TERCERA y última pieza del "cerebro" de
// backoffice del superadmin: acciones sugeridas con confirmación + las dos
// automatizaciones seguras. Archivo NUEVO a propósito -- mismo criterio que
// `superadmin-salud.ts`/`superadmin-resumen.ts`: cada concern de plataforma
// en su propio archivo, montado por separado en `app.ts`.
//
// Autorización real: las funciones SQL que `deps.accionesRepo` consume YA
// verifican `auth.uid() = p_caller_id` + `core.is_platform_superadmin(p_caller_id)`
// por dentro -- el middleware de aquí (`requireSuperadmin`, MISMO patrón que
// el resto del back office) es defensa en profundidad. Rate-limit de
// categoría "admin" en las 3 mutaciones (crear/confirmar/cancelar intent) --
// MISMO criterio que `/superadmin/resumen/generar`/`/superadmin/break-glass/*`.
//
// Principio rector (repetido aquí a propósito, ver el comentario de cabecera
// completo en la migración): ninguna acción con efecto real se ejecuta
// porque el cliente HTTP mande un flag -- el servidor SIEMPRE crea el intent
// primero y exige un segundo POST explícito del MISMO superadmin para
// confirmarlo.
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import type { AutomationActionLogRow, OutboxDeadMessageRow, OutboxQueueName, SuperadminActionIntentRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import { esTipoIntentEjecutable, CATALOGO_ACCIONES } from "../superadmin-acciones/catalogo.ts";
import { calcularSugerencias, type ProspectoNecesitaSeguimiento } from "../superadmin-acciones/sugerencias.ts";
import { construirResumenCerrarProspecto, construirResumenEjecutarMantenimientoAhora, construirResumenReencolarMensajeMuerto } from "../superadmin-acciones/resumen.ts";
import type { AppDeps } from "../deps.ts";

const QUEUES_VALIDAS = new Set<OutboxQueueName>(["citas", "hoteles", "restaurantes", "despachos", "rentas", "licitaciones"]);
const ESTADOS_CIERRE_VALIDOS = new Set(["perdido", "descartado"]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const MUTACION_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;

function serializeIntent(i: SuperadminActionIntentRow) {
  return {
    id: i.id,
    tipo: i.tipo,
    payload: i.payload,
    resumen: i.resumen,
    estado: i.estado,
    creadoPor: i.creadoPor,
    creadoEn: i.creadoEn,
    venceEn: i.venceEn,
    confirmadoEn: i.confirmadoEn,
    ejecutadoEn: i.ejecutadoEn,
    resultado: i.resultado,
    error: i.error,
  };
}

function serializeAutomationLog(l: AutomationActionLogRow) {
  return { id: l.id, tipo: l.tipo, tabla: l.tabla, objetivoId: l.objetivoId, detalle: l.detalle, ejecutadoEn: l.ejecutadoEn, executedBy: l.executedBy };
}

function serializeMensajeMuerto(m: OutboxDeadMessageRow) {
  return { queue: m.queueName, id: m.id, organizationId: m.organizationId, organizationName: m.organizationName, channel: m.channel, eventType: m.eventType, error: m.error, createdAt: m.createdAt };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw Errors.validation("limit debe ser un entero >= 1.");
  return Math.min(parsed, MAX_LIMIT);
}

interface CrearIntentBody {
  readonly tipo?: unknown;
  readonly payload?: unknown;
}

async function componerResumenYPayload(deps: AppDeps, callerId: string, tipo: string, payload: Record<string, unknown>): Promise<{ readonly resumen: string; readonly payloadValidado: Record<string, unknown> }> {
  if (tipo === "reencolar_mensaje_muerto") {
    const queue = typeof payload.queue === "string" ? payload.queue : "";
    const mensajeId = typeof payload.mensajeId === "string" ? payload.mensajeId : "";
    if (!QUEUES_VALIDAS.has(queue as OutboxQueueName) || mensajeId.length === 0) throw Errors.validation("payload inválido para reencolar_mensaje_muerto: requiere queue (una de las 6 verticales) y mensajeId.");
    const detalle = await deps.accionesRepo.getOutboxDeadMessageForSuperadmin(callerId, queue as OutboxQueueName, mensajeId);
    if (!detalle) throw Errors.notFound("No hay un mensaje en estado dead con ese id en esa cola (ya lo movieron, ya se reencoló, o nunca existió).");
    return { resumen: construirResumenReencolarMensajeMuerto(detalle), payloadValidado: { queue, mensajeId } };
  }

  if (tipo === "cerrar_prospecto") {
    const prospectoId = typeof payload.prospectoId === "string" ? payload.prospectoId : "";
    const estadoDestino = typeof payload.estado === "string" ? payload.estado : "";
    if (prospectoId.length === 0 || !ESTADOS_CIERRE_VALIDOS.has(estadoDestino)) throw Errors.validation("payload inválido para cerrar_prospecto: requiere prospectoId y estado en (perdido, descartado).");
    const prospectos = await deps.coreRepo.listProspectosForSuperadmin(callerId);
    const prospecto = prospectos.find((p) => p.id === prospectoId);
    if (!prospecto) throw Errors.notFound("No se encontró ese prospecto.");
    return { resumen: construirResumenCerrarProspecto(prospecto.empresa, prospecto.estado, estadoDestino as "perdido" | "descartado"), payloadValidado: { prospectoId, estado: estadoDestino } };
  }

  if (tipo === "ejecutar_mantenimiento_ahora") {
    return { resumen: construirResumenEjecutarMantenimientoAhora(), payloadValidado: {} };
  }

  throw Errors.validation(`Tipo de acción desconocido o no disponible: ${tipo}. Ver el catálogo en GET /superadmin/acciones/catalogo.`);
}

export function superadminAccionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/superadmin/acciones", authMiddleware(deps.env));
  app.use("/superadmin/acciones/*", authMiddleware(deps.env));
  app.use("/superadmin/acciones", async (c, next) => {
    if (!(await deps.coreRepo.isPlatformSuperadmin(c.get("userId")))) throw Errors.forbidden("Este panel es exclusivo del back office de plataforma.");
    await next();
  });
  app.use("/superadmin/acciones/*", async (c, next) => {
    if (!(await deps.coreRepo.isPlatformSuperadmin(c.get("userId")))) throw Errors.forbidden("Este panel es exclusivo del back office de plataforma.");
    await next();
  });

  // Catálogo completo (incluidas las acciones "no disponible") -- puramente
  // informativo, sin I/O.
  app.get("/superadmin/acciones/catalogo", (c) => c.json({ catalogo: CATALOGO_ACCIONES }));

  // Sugerencias deterministas -- a partir de mensajes muertos reales y
  // prospectos YA marcados `necesita_seguimiento_desde` por la
  // automatización (nunca recalculado aquí, ver el comentario de
  // `superadmin-acciones/sugerencias.ts`).
  app.get("/superadmin/acciones/sugerencias", async (c) => {
    const callerId = c.get("userId");
    const [mensajesMuertos, prospectos] = await Promise.all([deps.accionesRepo.listOutboxMensajesMuertosForSuperadmin(callerId, 50), deps.coreRepo.listProspectosForSuperadmin(callerId)]);
    const prospectosNecesitanSeguimiento: readonly ProspectoNecesitaSeguimiento[] = prospectos
      .filter((p) => p.necesitaSeguimientoDesde !== null)
      .map((p) => ({ id: p.id, empresa: p.empresa, vertical: p.vertical, necesitaSeguimientoDesde: p.necesitaSeguimientoDesde as string }));
    const sugerencias = calcularSugerencias({ mensajesMuertos, prospectosNecesitanSeguimiento, ahora: new Date() });
    return c.json({ sugerencias });
  });

  app.get("/superadmin/acciones/mensajes-muertos", async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const mensajes = await deps.accionesRepo.listOutboxMensajesMuertosForSuperadmin(c.get("userId"), limit);
    return c.json({ mensajes: mensajes.map(serializeMensajeMuerto) });
  });

  // Bitácora de intents (pendientes + ejecutados/fallidos/vencidos/cancelados)
  // -- visible a CUALQUIER superadmin, filtrable en el frontend por `estado`.
  app.get("/superadmin/acciones/intents", async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const intents = await deps.accionesRepo.listIntentsForSuperadmin(c.get("userId"), limit);
    return c.json({ intents: intents.map(serializeIntent) });
  });

  // Bitácora de las dos automatizaciones (cron o "ejecutar ahora").
  app.get("/superadmin/acciones/automatizaciones", async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const log = await deps.accionesRepo.listAutomationActionLogForSuperadmin(c.get("userId"), limit);
    return c.json({ automatizaciones: log.map(serializeAutomationLog) });
  });

  // Primer POST -- crea el intent, NUNCA ejecuta nada real.
  app.post("/superadmin/acciones/intents", async (c) => {
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:acciones-crear-intent:${requestActor(c.req.raw, callerId)}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiadas solicitudes de creación de acciones en poco tiempo.");

    const raw = (await c.req.json().catch(() => ({}))) as CrearIntentBody;
    const tipo = typeof raw.tipo === "string" ? raw.tipo : "";
    if (!esTipoIntentEjecutable(tipo)) throw Errors.validation(`Tipo de acción desconocido o no disponible: "${tipo}". Ver el catálogo en GET /superadmin/acciones/catalogo.`);
    const payload = raw.payload !== null && typeof raw.payload === "object" ? (raw.payload as Record<string, unknown>) : {};

    const { resumen, payloadValidado } = await componerResumenYPayload(deps, callerId, tipo, payload);
    const intent = await deps.accionesRepo.crearIntent(callerId, tipo, payloadValidado, resumen, 5);
    return c.json({ intent: serializeIntent(intent) }, 201);
  });

  // Segundo POST -- confirma y ejecuta (o marca `failed`/`expired`).
  app.post("/superadmin/acciones/intents/:id/confirmar", async (c) => {
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:acciones-confirmar-intent:${requestActor(c.req.raw, callerId)}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiadas confirmaciones de acciones en poco tiempo.");

    let intent: SuperadminActionIntentRow;
    try {
      intent = await deps.accionesRepo.confirmarIntent(callerId, c.req.param("id"));
    } catch (err) {
      throw Errors.notFound(err instanceof Error ? err.message : "No se pudo confirmar el intent.");
    }
    if (intent.estado === "expired") throw Errors.conflict("Este intent ya venció -- créalo de nuevo desde la sugerencia u otra pantalla.");
    if (intent.estado !== "executed" && intent.estado !== "failed") throw Errors.conflict(`Este intent ya no es confirmable (estado actual: ${intent.estado}).`);
    return c.json({ intent: serializeIntent(intent) });
  });

  app.post("/superadmin/acciones/intents/:id/cancelar", async (c) => {
    const callerId = c.get("userId");
    try {
      const intent = await deps.accionesRepo.cancelarIntent(callerId, c.req.param("id"));
      return c.json({ intent: serializeIntent(intent) });
    } catch (err) {
      throw Errors.conflict(err instanceof Error ? err.message : "No se pudo cancelar el intent.");
    }
  });

  return app;
}
