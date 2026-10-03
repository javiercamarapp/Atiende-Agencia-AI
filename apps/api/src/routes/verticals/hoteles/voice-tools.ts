// Voz de hoteles: rutas HTTP del agente de voz de la property. La voz corre sobre @atiende/voice-core (LiveKit + Gemini Live, respaldo cascada OpenRouter,
// sin ElevenLabs ni gpt-live): el worker de telefonia ejecuta las tools de la llamada contra estas rutas (`transporteHttpHoteles` en
// `@atiende/domain-hoteles`), y el panel de staff consulta el estado de la escalera y emite la sesion de vista previa.
//
// Rutas de tool (worker, SIN `authMiddleware`/`originAllowed`: el worker no manda `Origin` ni `Authorization`, solo el secreto dedicado
// `x-atiende-tool-secret`):
//   POST /v1/hoteles/:propertyId/voz/tickets-fnb                 crear_ticket_huesped_fnb
//   POST /v1/hoteles/:propertyId/voz/contacto-no-operativo       registrar_contacto_no_operativo
//   POST /v1/hoteles/:propertyId/voz/reservas/:herramienta       las 6 herramientas de reservas (H-25), las MISMAS que WhatsApp
// El telefono de la llamada llega en el cuerpo, inyectado por el transporte del worker desde el SIP From (el ejecutor de voice-core quita cualquier
// telefono que escriba el modelo); la logica de cada tool vive en `@atiende/domain-hoteles` (`voz/tools-servidor.ts`), la misma que ejecuta el simulador.
//
// Divergencia deliberada de restaurantes (diseno §1/§5.1): el secreto NO es compartido de plataforma, es dedicado POR PROPERTY
// (`hoteles.voice_agent_config.tool_webhook_secret`, H-H05) -- el aislamiento por tenant es el eje de seguridad central de este vertical.
//
// Rutas de staff (sesion + membership de la property, solo ADMIN_ROLES):
//   POST /hoteles/:propertyId/voz/config                rota o crea el secreto dedicado (se devuelve UNA vez)
//   GET  /hoteles/:propertyId/voz/estado                estado HONESTO: escalera (credenciales por escalon), precio por minuto, vista previa disponible o no
//   POST /hoteles/:propertyId/voz/preview/sesion        sesion de vista previa (token efimero de Gemini + token propio firmado); 503 honesto sin credenciales
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  ADMIN_ROLES,
  PostgresReservasAgenteRepository,
  VozToolValidacionError,
  consumeRateLimit,
  crearTicketFnbVoz,
  ejecutarReservasVoz,
  instruccionVozHotel,
  isReservasToolName,
  localDateIn,
  registrarContactoNoOperativoVoz,
} from "@atiende/domain-hoteles";
import type { HotelesRepository } from "@atiende/domain-hoteles";
import {
  PREVIEW_TOKEN_TTL_POR_DEFECTO_SEGUNDOS,
  VOZ_PLATAFORMA,
  VOZ_POR_DEFECTO,
  VozNoConfiguradaError,
  VozProveedorError,
  estadoEscalera,
  firmarPreviewToken,
} from "@atiende/voice-core";
import { Errors } from "../../../errors.ts";
import { constantTimeEqual, readJsonCapped, requestActor } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

const SECRETO_PREVIEW_MIN = 16;

/** Secreto dedicado POR PROPERTY (diseno §1/§5.1) -- a diferencia de `requireVoiceToolSecret` de restaurantes (un solo valor de plataforma en
 * `deps.env`), aqui cada property tiene el suyo en `hoteles.voice_agent_config`, verificado en tiempo constante con la misma primitiva que el
 * resto del app (`constantTimeEqual`). */
async function requireVoiceAgentConfig(repo: HotelesRepository, propertyId: string, req: Request): Promise<{ organizationId: string }> {
  const config = await repo.findVoiceAgentConfig(propertyId);
  if (!config || !config.enabled) throw Errors.serviceUnavailable("El agente de voz no está configurado o está deshabilitado para esta property.");
  if (!constantTimeEqual(req.headers.get("x-atiende-tool-secret"), config.toolWebhookSecret)) throw Errors.unauthorized();
  return { organizationId: config.organizationId };
}

/** Un cuerpo que no cumple el contrato de la herramienta es un 400, nunca un 500. */
async function validando<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof VozToolValidacionError) throw Errors.validation(err.message);
    throw err;
  }
}

interface CrearTicketFnbBody {
  readonly mensaje?: unknown;
  readonly habitacion?: unknown;
  readonly alergia_declarada?: unknown;
}

interface ContactoNoOperativoBody {
  readonly motivo?: unknown;
  readonly resumen?: unknown;
  readonly telefono?: unknown;
}

interface RotateVoiceConfigBody {
  readonly enabled?: unknown;
}

export function hotelesVoiceToolsRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  // §1 -- POST /v1/hoteles/:propertyId/voz/tickets-fnb (crear_ticket_huesped_fnb). Mismo camino que `POST /hoteles/:propertyId/pedidos-fnb`, pero
  // sin sesion de staff (actor system:voz, createdBy:null). NUNCA responde afirmando que el platillo es seguro: eso exige confirmacion humana de cocina
  // (REQ-AB-004).
  app.post("/v1/hoteles/:propertyId/voz/tickets-fnb", async (c) => {
    const propertyId = c.req.param("propertyId");

    // Tool de voz, sin sesion de staff -- abre su propia sesion de sistema (`userId: null`), igual que las rutas publicas/de sistema de otras verticales.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.hotelesRepo(db);
      const { organizationId } = await requireVoiceAgentConfig(repo, propertyId, c.req.raw);

      const limited = await consumeRateLimit(repo, "voice-tickets-fnb", requestActor(c.req.raw, propertyId), 60, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      const body = await readJsonCapped<CrearTicketFnbBody>(c.req.raw, 8 * 1024);
      const order = await validando(() => crearTicketFnbVoz(repo, { organizationId, propertyId, mensaje: body.mensaje, habitacion: body.habitacion, alergiaDeclarada: body.alergia_declarada }));
      return c.json(order);
    });
  });

  // §1 -- POST /v1/hoteles/:propertyId/voz/contacto-no-operativo (registrar_contacto_no_operativo) -- mismo tool que usa el agente de WhatsApp, expuesto
  // tambien por voz para que un mensaje que no sea F&B siempre quede registrado para seguimiento humano.
  app.post("/v1/hoteles/:propertyId/voz/contacto-no-operativo", async (c) => {
    const propertyId = c.req.param("propertyId");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.hotelesRepo(db);
      const { organizationId } = await requireVoiceAgentConfig(repo, propertyId, c.req.raw);

      const limited = await consumeRateLimit(repo, "voice-contacto-no-operativo", requestActor(c.req.raw, propertyId), 60, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      const body = await readJsonCapped<ContactoNoOperativoBody>(c.req.raw, 4 * 1024);
      const contacto = await validando(() => registrarContactoNoOperativoVoz(repo, { organizationId, propertyId, motivo: body.motivo, resumen: body.resumen, telefono: body.telefono }));
      return c.json(contacto);
    });
  });

  // H-25 -- agente de reservas por VOZ: disponibilidad, cotizacion, pre-reserva (hold), estado, cancelacion y handoff, con las MISMAS herramientas y la
  // MISMA logica que el agente de WhatsApp (`executeReservasTool`, via `ejecutarReservasVoz`). POST /v1/hoteles/:propertyId/voz/reservas/:herramienta, con
  // el secreto dedicado por property. Cuerpo = los argumentos de la herramienta + `telefono` (numero de la llamada, del SIP From; obligatorio para
  // apartar/estado/cancelar) + `llamada_id` opcional (idempotencia de reintentos dentro de la llamada). Si el hotel no habilito los holds en su politica,
  // o la base no tiene la migracion 037, responde 200 con `{error, requiere_humano:true}` (nunca un 500) para que el agente derive a una persona. La
  // respuesta trae SOLO campos tipados: los precios los fija la base; ninguna ruta acepta un precio del agente.
  app.post("/v1/hoteles/:propertyId/voz/reservas/:herramienta", async (c) => {
    const propertyId = c.req.param("propertyId");
    const herramienta = c.req.param("herramienta");
    if (!isReservasToolName(herramienta)) throw Errors.notFound("Herramienta de voz desconocida.");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.hotelesRepo(db);
      const { organizationId } = await requireVoiceAgentConfig(repo, propertyId, c.req.raw);

      const limited = await consumeRateLimit(repo, "voice-reservas", requestActor(c.req.raw, propertyId), 60, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 8 * 1024);
      const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
      const reservas = deps.hotelesReservasAgenteRepo ? deps.hotelesReservasAgenteRepo(db) : new PostgresReservasAgenteRepository(db);
      const telefono = typeof input.telefono === "string" ? input.telefono : "";
      const llamadaId = typeof input.llamada_id === "string" ? input.llamada_id : undefined;
      return c.json(await ejecutarReservasVoz({ hotelesRepo: repo, reservas, organizationId, propertyId, telefono, ...(llamadaId ? { llamadaId } : {}) }, herramienta, input));
    });
  });

  // ---- Rutas de staff (sesion + membership de la property) ----
  for (const path of ["/hoteles/:propertyId/voz/config", "/hoteles/:propertyId/voz/estado", "/hoteles/:propertyId/voz/preview/sesion"]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  // Endpoint de rotacion (diseno §1/§5.1) -- SI requiere sesion de staff, solo ADMIN_ROLES (owner/gm): rota o crea el secreto dedicado de voz de esta
  // property. El secreto nuevo se genera server-side (nunca se acepta uno mandado por el cliente) y se devuelve UNA sola vez en la respuesta -- igual
  // criterio que cualquier rotacion de API key real.
  app.post("/hoteles/:propertyId/voz/config", async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const propertyId = c.req.param("propertyId");
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<RotateVoiceConfigBody>(c.req.raw, 1 * 1024);
    const enabled = raw.enabled !== false;
    const newSecret = randomUUID() + randomUUID();
    await deps.hotelesRepo(c.get("db")).upsertVoiceAgentConfig(propertyId, organizationId, newSecret, enabled);
    return c.json({ toolWebhookSecret: newSecret, enabled });
  });

  /** Por que la vista previa no se puede emitir AHORA (null = se puede). Mismas condiciones que `POST .../preview/sesion`, sin abrir nada ni gastar. */
  async function motivoSinPreview(): Promise<string | null> {
    const provider = deps.voiceProvider;
    if (!provider) return "Voz no configurada: no hay proveedor de voz en este despliegue (requiere GEMINI_API_KEY).";
    const salud = await provider.salud();
    if (!salud.ok) return salud.detalle;
    const secreto = deps.env.voicePreviewTokenSecret;
    if (!secreto || secreto.length < SECRETO_PREVIEW_MIN) return "Voz no configurada: falta VOICE_PREVIEW_TOKEN_SECRET.";
    return null;
  }

  // Estado HONESTO de la voz de la property: que escalones de la escalera tienen credencial, el precio por minuto de la plataforma y si la vista previa se
  // puede emitir. Nunca devuelve una llave ni el secreto de tools. El panel muestra "requiere ..." en vez de un control que no funciona.
  app.get("/hoteles/:propertyId/voz/estado", async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const propertyId = c.req.param("propertyId");
    const config = await deps.hotelesRepo(c.get("db")).findVoiceAgentConfig(propertyId).catch(() => null);
    const escalera = estadoEscalera({ geminiApiKey: deps.env.geminiApiKey ?? null, openrouterApiKey: deps.env.llmProviders.openrouter?.apiKey ?? null, llm: deps.llmGateway ? { completar: () => Promise.reject(new Error("solo estado")) } : null });
    return c.json({
      agente: { configurado: config !== null, habilitado: config?.enabled === true },
      escalera,
      precioMicroUsdPorMinuto: { "gemini-3.8-live": VOZ_PLATAFORMA.gemini.precioMicroUsdPorMinuto, "cascada-openrouter": VOZ_PLATAFORMA.cascada.precioMicroUsdPorMinuto },
      preview: { disponible: (await motivoSinPreview()) === null, motivo: await motivoSinPreview() },
    });
  });

  // Sesion de vista previa: el navegador habla con Gemini Live con un token EFIMERO de un solo uso (la llave de plataforma nunca sale del servidor). El
  // prompt es el del agente de hoteles (`instruccionVozHotel`); la vista previa NO llama herramientas ni aparta nada. Sin credencial o sin secreto del
  // token: 503 "voz no configurada", nunca un falso exito.
  app.post("/hoteles/:propertyId/voz/preview/sesion", async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const propertyId = c.req.param("propertyId");
    const organizationId = c.get("organizationId");
    const actorUserId = c.get("userId");

    const raw = await readJsonCapped<{ voiceId?: unknown }>(c.req.raw, 4 * 1024);
    if (raw.voiceId !== undefined && typeof raw.voiceId !== "string") throw Errors.validation("voiceId: se esperaba un texto.");

    const motivo = await motivoSinPreview();
    if (motivo) throw Errors.serviceUnavailable(motivo);
    const provider = deps.voiceProvider!;
    const secreto = deps.env.voicePreviewTokenSecret!;

    const repo = deps.hotelesRepo(c.get("db"));
    const limited = await consumeRateLimit(repo, "voz-preview-sesion", requestActor(c.req.raw, actorUserId), 20, 600);
    if (!limited.allowed) throw Errors.tooManyRequests();

    const voiceId = raw.voiceId ?? VOZ_POR_DEFECTO;
    if (!provider.catalogoVoces().some((v) => v.id === voiceId)) throw Errors.validation("voiceId: no está en el catálogo de voces del proveedor.");

    const propiedad = await repo.findPropertyById(propertyId);
    const timezone = (await repo.findPropertyTimezone(propertyId).catch(() => null)) ?? "America/Mexico_City";
    const sessionId = randomUUID();
    const ttlSegundos = PREVIEW_TOKEN_TTL_POR_DEFECTO_SEGUNDOS;
    let emitida;
    try {
      emitida = await provider.emitirSesionPreview({
        organizationId,
        propertyId,
        sessionId,
        voiceId,
        comportamiento: instruccionVozHotel({ hotelName: propiedad?.name ?? "el hotel", hoy: localDateIn(timezone, new Date()), timezone }),
        mensajeInicial: "",
        ttlSegundos,
      });
    } catch (err) {
      if (err instanceof VozNoConfiguradaError) throw Errors.serviceUnavailable(err.message);
      if (err instanceof VozProveedorError) {
        logEvent(c, "error", "hoteles_voz_preview_proveedor_fallo", { organizationId, propertyId, estado: err.estado ?? null });
        throw Errors.serviceUnavailable("El proveedor de voz no pudo emitir la sesión de preview. Reintenta en unos minutos.");
      }
      throw err;
    }
    const { token: tokenPreview } = firmarPreviewToken(secreto, { sessionId, organizationId, propertyId, voiceId, proveedor: emitida.proveedor }, new Date(), ttlSegundos);
    logEvent(c, "info", "hoteles_voz_preview_emitido", { actorUserId, organizationId, propertyId, sessionId });
    return c.json(
      {
        sesionId: sessionId,
        proveedor: emitida.proveedor,
        modelo: emitida.modelo,
        voiceId,
        websocketUrl: emitida.websocketUrl,
        tokenProveedor: emitida.tokenProveedor,
        tokenPreview,
        expiraEn: emitida.expiraEn,
      },
      201,
    );
  });

  return app;
}
