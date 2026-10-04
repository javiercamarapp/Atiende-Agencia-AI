// Voz de citas: rutas HTTP del agente de voz del negocio. La voz corre sobre @atiende/voice-core (LiveKit + Gemini Live, respaldo cascada OpenRouter,
// sin ElevenLabs ni gpt-live): el worker de telefonia ejecuta las tools de la llamada contra estas rutas (`transporteHttpCitas` en
// `@atiende/domain-citas`), y el panel de staff consulta el estado de la escalera y emite la sesion de vista previa.
//
// Rutas del worker (SIN `authMiddleware`/`originAllowed`: el worker no manda `Origin` ni `Authorization`, solo el secreto de plataforma
// `x-atiende-tool-secret` = VOICE_TOOL_SECRET; el negocio sale del `orgSlug` de la ruta):
//   GET  /v1/citas/:orgSlug/voz/contexto        prompt, pregrabados, "hoy" y si el rubro exige la guardia de crisis (todo lectura)
//   POST /v1/citas/:orgSlug/voz/:herramienta    las 9 herramientas (8 de agenda, las MISMAS que WhatsApp, y derivar_a_humano)
// El telefono de la llamada llega en el cuerpo, inyectado por el transporte del worker desde el SIP From (el ejecutor de voice-core quita cualquier
// telefono que escriba el modelo); la logica de cada tool vive en `@atiende/domain-citas` (`voz/tools-servidor.ts`), la misma que ejecuta el simulador.
//
// Las 4 rutas antiguas del agente de ElevenLabs (`/availability`, `/services`, `/providers`, `/customers/appointments`) se RETIRARON: ya no hay
// agente de ElevenLabs para citas.
//
// Rutas de staff (sesion + membership de la sucursal, solo owner/admin = STAFF_INVITE_ROLES):
//   GET  /v1/citas/properties/:propertyId/admin/voz/estado           estado HONESTO: escalera (credenciales por escalon), precio por minuto, vista previa disponible o no
//   POST /v1/citas/properties/:propertyId/admin/voz/preview/sesion   sesion de vista previa (token efimero de Gemini + token propio firmado); 503 honesto sin credenciales
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  STAFF_INVITE_ROLES,
  VozToolValidacionError,
  canonicalizarTelefonoCitas,
  consumeRateLimit,
  derivarAHumanoVoz,
  ejecutarToolVozCitas,
  esToolVozCitas,
  obtenerContextoLlamadaVoz,
} from "@atiende/domain-citas";
import type { CitasRepository } from "@atiende/domain-citas";
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
import { readJsonCapped, requestActor, secretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

const SECRETO_PREVIEW_MIN = 16;

async function resolveOrganizationOrNotFound(citasRepo: CitasRepository, orgSlug: string) {
  const org = await citasRepo.findOrganizationBySlug(orgSlug);
  if (!org || !org.isActive) throw Errors.notFound(`Negocio "${orgSlug}" no encontrado o inactivo.`);
  return org;
}

function requireVoiceToolSecret(deps: AppDeps, req: Request): void {
  if (!secretMatches(req, "x-atiende-tool-secret", deps.env.voiceToolSecret)) throw Errors.unauthorized();
}

export function citasVoiceToolsRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  // Contexto de UNA llamada, que el worker pide al contestar. Solo lectura, con el secreto de plataforma; el negocio inexistente o inactivo es 404.
  app.get("/v1/citas/:orgSlug/voz/contexto", async (c) => {
    requireVoiceToolSecret(deps, c.req.raw);
    const orgSlug = c.req.param("orgSlug");
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const org = await resolveOrganizationOrNotFound(citasRepo, orgSlug);
      const limited = await consumeRateLimit(citasRepo, "voice-contexto", requestActor(c.req.raw, orgSlug), 120, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();
      return c.json(await obtenerContextoLlamadaVoz(citasRepo, org));
    });
  });

  // POST /v1/citas/:orgSlug/voz/:herramienta. Cuerpo = los argumentos de la herramienta + `telefono` (numero de la llamada, del SIP From; obligatorio
  // para buscar/crear/cancelar/reagendar/modificar) + `llamada_id` opcional. Un cuerpo que no cumple el contrato es 400; una accion que el servidor no
  // puede hacer (p. ej. el llamante es anonimo) responde 200 con `{error, requiere_humano:true}` para que el agente derive a una persona.
  app.post("/v1/citas/:orgSlug/voz/:herramienta", async (c) => {
    requireVoiceToolSecret(deps, c.req.raw);
    const herramienta = c.req.param("herramienta");
    if (!esToolVozCitas(herramienta)) throw Errors.notFound("Herramienta de voz desconocida.");
    const orgSlug = c.req.param("orgSlug");
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 8 * 1024);
    const input: Record<string, unknown> = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const { telefono: telefonoCrudo, llamada_id: llamadaCruda, ...args } = input;
    if (telefonoCrudo !== undefined && typeof telefonoCrudo !== "string") throw Errors.validation("telefono: se esperaba un texto.");
    // Vacio = llamante anonimo (solo consultas); un valor que no es un numero valido es un 400, nunca se adivina.
    const hayTelefono = typeof telefonoCrudo === "string" && telefonoCrudo.trim() !== "";
    const telefono = hayTelefono ? (canonicalizarTelefonoCitas(telefonoCrudo) ?? "") : "";
    if (hayTelefono && !telefono) throw Errors.validation("telefono: no es un número válido.");
    const llamadaId = typeof llamadaCruda === "string" && llamadaCruda.trim() ? llamadaCruda.trim().slice(0, 64) : undefined;

    // Sub-Hono propio, sin authMiddleware/dbSession -- abre su propia sesion de sistema (`userId: null`), igual que el resto de rutas de sistema.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const org = await resolveOrganizationOrNotFound(citasRepo, orgSlug);
      // Rate limit por negocio y por numero: las consultas de citas de un numero ajeno no se pueden forzar por fuerza bruta.
      const limited = await consumeRateLimit(citasRepo, "voice-citas", requestActor(c.req.raw, `${orgSlug}:${telefono}`), 60, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();
      try {
        const ctx = { repo: citasRepo, organizationId: org.id, telefono, ...(llamadaId ? { llamadaId } : {}) };
        // `derivar_a_humano` va directo a su funcion: un cuerpo sin motivo es un 400 (el despacho en proceso del simulador, en cambio, lo devuelve como error al modelo).
        if (herramienta === "derivar_a_humano") return c.json(await derivarAHumanoVoz(ctx, { motivo: args.motivo, resumen: args.resumen }));
        const { resultado } = await ejecutarToolVozCitas(ctx, herramienta, args);
        return c.json(resultado);
      } catch (err) {
        if (err instanceof VozToolValidacionError) throw Errors.validation(err.message);
        throw err;
      }
    });
  });

  // ---- Rutas de staff (sesion + membership de la sucursal) ----
  const base = "/v1/citas/properties/:propertyId/admin/voz";
  for (const path of [`${base}/estado`, `${base}/preview/sesion`]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

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

  // Estado HONESTO de la voz: que escalones de la escalera tienen credencial, el precio por minuto de la plataforma y si la vista previa se puede
  // emitir. Nunca devuelve una llave ni el secreto de tools. El panel muestra "requiere ..." en vez de un control que no funciona.
  app.get(`${base}/estado`, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const motivoPreview = await motivoSinPreview();
    const escalera = estadoEscalera({ geminiApiKey: deps.env.geminiApiKey ?? null, openrouterApiKey: deps.env.llmProviders.openrouter?.apiKey ?? null, llm: deps.llmGateway ? { completar: () => Promise.reject(new Error("solo estado")) } : null });
    return c.json({
      escalera,
      precioMicroUsdPorMinuto: { "gemini-3.8-live": VOZ_PLATAFORMA.gemini.precioMicroUsdPorMinuto, "cascada-openrouter": VOZ_PLATAFORMA.cascada.precioMicroUsdPorMinuto },
      preview: { disponible: motivoPreview === null, motivo: motivoPreview },
    });
  });

  // Sesion de vista previa: el navegador habla con Gemini Live con un token EFIMERO de un solo uso (la llave de plataforma nunca sale del servidor). El
  // prompt es el del agente de citas (`obtenerContextoLlamadaVoz`, con la personalidad de C-15); la vista previa NO llama herramientas ni agenda nada.
  // Sin credencial o sin secreto del token: 503 "voz no configurada", nunca un falso exito.
  app.post(`${base}/preview/sesion`, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const propertyId = c.req.param("propertyId");
    const organizationId = c.get("organizationId");
    const actorUserId = c.get("userId");

    const raw = await readJsonCapped<{ voiceId?: unknown }>(c.req.raw, 4 * 1024);
    if (raw.voiceId !== undefined && typeof raw.voiceId !== "string") throw Errors.validation("voiceId: se esperaba un texto.");

    const motivo = await motivoSinPreview();
    if (motivo) throw Errors.serviceUnavailable(motivo);
    const provider = deps.voiceProvider!;
    const secreto = deps.env.voicePreviewTokenSecret!;

    // `consume_api_rate_limit` es de SOLO sistema (exige auth.uid() nulo): se consume en su propia sesion de sistema (commit propio), no en la
    // transaccion de staff del request.
    const allowed = await deps.engine.withAppSession({ userId: null }, async (db) => (await consumeRateLimit(deps.citasRepo(db), "voz-preview-sesion", requestActor(c.req.raw, actorUserId), 20, 600)).allowed);
    if (!allowed) throw Errors.tooManyRequests();

    const voiceId = raw.voiceId ?? VOZ_POR_DEFECTO;
    if (!provider.catalogoVoces().some((v) => v.id === voiceId)) throw Errors.validation("voiceId: no está en el catálogo de voces del proveedor.");

    const repo = deps.citasRepo(c.get("db"));
    const org = (await repo.findOrganizationById(organizationId)) ?? { id: organizationId, name: "el negocio" };
    const contexto = await obtenerContextoLlamadaVoz(repo, org);
    const sessionId = randomUUID();
    const ttlSegundos = PREVIEW_TOKEN_TTL_POR_DEFECTO_SEGUNDOS;
    let emitida;
    try {
      emitida = await provider.emitirSesionPreview({ organizationId, propertyId, sessionId, voiceId, comportamiento: contexto.instruccion, mensajeInicial: "", ttlSegundos });
    } catch (err) {
      if (err instanceof VozNoConfiguradaError) throw Errors.serviceUnavailable(err.message);
      if (err instanceof VozProveedorError) {
        logEvent(c, "error", "citas_voz_preview_proveedor_fallo", { organizationId, propertyId, estado: err.estado ?? null });
        throw Errors.serviceUnavailable("El proveedor de voz no pudo emitir la sesión de preview. Reintenta en unos minutos.");
      }
      throw err;
    }
    const { token: tokenPreview } = firmarPreviewToken(secreto, { sessionId, organizationId, propertyId, voiceId, proveedor: emitida.proveedor }, new Date(), ttlSegundos);
    logEvent(c, "info", "citas_voz_preview_emitido", { actorUserId, organizationId, propertyId, sessionId });
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
