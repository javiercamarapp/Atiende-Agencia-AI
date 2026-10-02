// H-29 (migracion 039) -- configuracion editable del canal de WhatsApp y del agente de voz desde el panel.
//   GET  /hoteles/:propertyId/mensajeria                    estado de ambos canales (solo owner/gm)
//   PUT  /hoteles/:propertyId/mensajeria/whatsapp           numero (phone_number_id de Meta) y habilitado
//   PUT  /hoteles/:propertyId/mensajeria/voz                encender/apagar la voz (no toca el secreto)
//   POST /hoteles/:propertyId/mensajeria/voz/rotar-secreto  genera un secreto NUEVO en el servidor y lo entrega UNA vez
//
// SIN SECRETOS EN CLARO: ninguna respuesta de lectura contiene el secreto de voz (la base ni siquiera deja leerlo al
// cliente: GRANT por columna). Solo la rotacion lo devuelve, una vez, con `cache-control: no-store`. La plataforma usa UNA
// Meta App compartida: no se guarda ningun token de envio por hotel. Hueco conocido: no se verifica contra la API de Meta
// que el numero pertenezca al hotel (exige el token de envio); defensa en profundidad = solo owner/gm, numero unico por
// propiedad, trazabilidad (updated_by/updated_at) y aviso in-app al cambiar el numero.
//
// REGLA DURA DE COMPATIBILIDAD: contra la base sin 039 las lecturas responden "no configurado" y las escrituras 503.
import type { Context } from "hono";
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { emitirNotificacion } from "@atiende/db";
import {
  MENSAJERIA_CONFIG_ROLES,
  MensajeriaConflictError,
  MensajeriaInvalidInputError,
  MensajeriaUnavailableError,
  PostgresMensajeriaConfigRepository,
  generateVoiceSecret,
  parseWhatsAppChannelInput,
  type MensajeriaConfigRepository,
  type VoiceAgentStatus,
  type WhatsAppChannelStatus,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const BODY_MAX_BYTES = 4 * 1024;

function toApiError(err: unknown): unknown {
  if (err instanceof MensajeriaUnavailableError) return Errors.serviceUnavailable(err.message);
  if (err instanceof MensajeriaConflictError) return Errors.conflict(err.message);
  if (err instanceof MensajeriaInvalidInputError) return Errors.validation(err.message);
  return err;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

function serializeWhatsApp(s: WhatsAppChannelStatus) {
  return { configurado: s.configurado, phoneNumberId: s.phoneNumberId, habilitado: s.enabled, actualizadoEn: s.updatedAt };
}
function serializeVoice(s: VoiceAgentStatus) {
  return { configurado: s.configurado, habilitado: s.enabled, secretoConfigurado: s.secretoConfigurado, actualizadoEn: s.updatedAt };
}

export function hotelesMensajeriaConfigRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.use("/hoteles/:propertyId/mensajeria", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/mensajeria/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  const repoFor = (c: Context<CoreAuthHonoEnv>): MensajeriaConfigRepository => {
    const db = c.get("db");
    return deps.hotelesMensajeriaConfigRepo ? deps.hotelesMensajeriaConfigRepo(db) : new PostgresMensajeriaConfigRepository(db);
  };

  async function body(c: Context<CoreAuthHonoEnv>): Promise<Record<string, unknown>> {
    const raw = await readJsonCapped<unknown>(c.req.raw, BODY_MAX_BYTES);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("Cuerpo invalido: se esperaba un objeto.");
    return raw as Record<string, unknown>;
  }

  app.get("/hoteles/:propertyId/mensajeria", async (c) => {
    assertVerticalRole(c, MENSAJERIA_CONFIG_ROLES);
    const propertyId = c.req.param("propertyId");
    const repo = repoFor(c);
    const [whatsapp, voz] = await Promise.all([guarded(() => repo.getWhatsAppChannel(propertyId)), guarded(() => repo.getVoiceAgent(propertyId))]);
    return c.json({ whatsapp: serializeWhatsApp(whatsapp), voz: serializeVoice(voz) });
  });

  app.put("/hoteles/:propertyId/mensajeria/whatsapp", async (c) => {
    assertVerticalRole(c, MENSAJERIA_CONFIG_ROLES);
    const propertyId = c.req.param("propertyId");
    const input = await guarded(async () => parseWhatsAppChannelInput(await body(c)));
    const repo = repoFor(c);
    const before = await guarded(() => repo.getWhatsAppChannel(propertyId));
    const saved = await guarded(() => repo.saveWhatsAppChannel(propertyId, input, c.get("userId")));
    // Cambio de numero = evento de seguridad (el numero decide a que propiedad llegan los mensajes de los huespedes).
    if (before.phoneNumberId !== saved.phoneNumberId) {
      await emitirNotificacion(c.get("db"), {
        evento: "hoteles.canal.whatsapp_actualizado",
        organizationId: c.get("organizationId"),
        propertyId,
        clave: `${propertyId}:${new Date().toISOString().slice(0, 10)}`,
      });
    }
    return c.json(serializeWhatsApp(saved));
  });

  app.put("/hoteles/:propertyId/mensajeria/voz", async (c) => {
    assertVerticalRole(c, MENSAJERIA_CONFIG_ROLES);
    const raw = await body(c);
    if (typeof raw.habilitado !== "boolean") throw Errors.validation("habilitado: se esperaba true o false.");
    const status = await guarded(() => repoFor(c).setVoiceEnabled(c.req.param("propertyId"), raw.habilitado as boolean));
    if (!status) throw Errors.conflict("La voz aun no tiene secreto: genera uno primero (rotar-secreto).");
    return c.json(serializeVoice(status));
  });

  app.post("/hoteles/:propertyId/mensajeria/voz/rotar-secreto", async (c) => {
    assertVerticalRole(c, MENSAJERIA_CONFIG_ROLES);
    const raw = await body(c);
    if (raw.habilitado !== undefined && typeof raw.habilitado !== "boolean") throw Errors.validation("habilitado: se esperaba true o false.");
    const propertyId = c.req.param("propertyId");
    const repo = repoFor(c);
    // Sin `habilitado` explicito se conserva el estado actual (una rotacion no enciende ni apaga la voz por accidente).
    const habilitado = typeof raw.habilitado === "boolean" ? raw.habilitado : (await guarded(() => repo.getVoiceAgent(propertyId))).enabled;
    const secret = generateVoiceSecret();
    const status = await guarded(() => repo.rotateVoiceSecret(propertyId, c.get("organizationId"), secret, habilitado));
    // Unica vez que el secreto sale del servidor. Nunca se escribe en bitacora ni se cachea.
    c.header("cache-control", "no-store");
    return c.json({ ...serializeVoice(status), secreto: secret, aviso: "Guarda este secreto ahora en la configuracion de tu agente de voz: no se vuelve a mostrar." });
  });

  return app;
}
