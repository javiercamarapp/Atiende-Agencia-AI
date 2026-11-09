// Alta autoservicio -- WhatsApp Embedded Signup por sucursal: el dueño conecta SU numero de WhatsApp Business desde el panel, sin que
// la plataforma lo de de alta a mano en su WABA. Detras de configuracion: sin `WHATSAPP_EMBEDDED_SIGNUP=true` y las credenciales de la
// app de Meta (ver docs/restaurantes/WHATSAPP-EMBEDDED-SIGNUP.md) responde «no disponible aún» con la lista de lo que falta.
//
//   GET  /v1/restaurantes/:propertyId/admin/config/sucursales/:branchId/whatsapp/embedded-signup
//        -> { disponible, faltantes[], appId, configId, graphApiVersion } (appId y configId son publicos: los usa el SDK de Facebook).
//   POST mismo path, body { code, wabaId, phoneNumberId } (lo que devuelve el flujo de Meta en el navegador)
//        -> canjea el code, comprueba que el numero es de ese WABA, da acceso al usuario de sistema de la plataforma, suscribe la app
//           a los webhooks, registra el numero con un PIN nuevo de 6 digitos y guarda el ruteo (restaurantes.whatsapp_branch_channel,
//           el mismo que ya usa el webhook). Devuelve el PIN UNA vez para que el dueño lo guarde (nunca se registra ni se guarda).
//
// Seguridad: owner/admin (STAFF_INVITE_ROLES) de la sucursal dentro de su alcance; el token del negocio vive solo en memoria durante la
// llamada (MetaEmbeddedSignupClient), nunca se guarda ni se registra; todo mensaje de error de Meta va redactado. Tope 10 intentos por
// hora por organizacion. Bitacora `configuracion.whatsapp_embedded_signup`.
import { randomInt } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { RestaurantesConfigUnavailableError, STAFF_INVITE_ROLES, WhatsappNumberInUseError } from "@atiende/domain-restaurantes";
import { EmbeddedSignupError, MetaEmbeddedSignupClient } from "@atiende/whatsapp-gateway";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import type { ApiEnv } from "../../../env.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";

export const EMBEDDED_SIGNUP_INTENTOS_POR_HORA = 10;

/** Variables de entorno que faltan para habilitar Embedded Signup (solo NOMBRES, nunca valores). Vacio = disponible. */
export function faltantesEmbeddedSignup(env: ApiEnv): string[] {
  const faltan: string[] = [];
  if (env.whatsappEmbeddedSignup !== true) faltan.push("WHATSAPP_EMBEDDED_SIGNUP");
  if (!env.metaAppId) faltan.push("META_APP_ID");
  if (!env.whatsappEsConfigId) faltan.push("WHATSAPP_ES_CONFIG_ID");
  if (!env.whatsappSystemUserId) faltan.push("WHATSAPP_SYSTEM_USER_ID");
  if (!env.whatsappAccessToken) faltan.push("WHATSAPP_ACCESS_TOKEN");
  if (!env.whatsappAppSecret) faltan.push("WHATSAPP_APP_SECRET");
  return faltan;
}

const MENSAJE_PASO: Record<EmbeddedSignupError["paso"], string> = {
  canje: "Meta no aceptó la autorización (el código venció o ya se usó). Vuelve a conectar el número.",
  numeros: "El número elegido no pertenece a la cuenta de WhatsApp Business que autorizaste.",
  asignar_usuario: "No pudimos obtener acceso a tu cuenta de WhatsApp Business. Revisa que aceptaste todos los permisos.",
  suscribir: "No pudimos suscribir tu número a los mensajes. Intenta de nuevo en unos minutos.",
  registrar: "Meta no permitió registrar el número (puede estar en uso en la app de WhatsApp o en otro proveedor).",
};

export function restaurantesWhatsappEmbeddedSignupRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/v1/restaurantes/:propertyId/admin/config/sucursales/:branchId/whatsapp/embedded-signup";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function resolveBranch(c: Context<CoreAuthHonoEnv>) {
    const organizationId = c.get("organizationId");
    const branchId = c.req.param("branchId") ?? "";
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null && !scope.includes(branchId)) throw Errors.forbidden("No tienes acceso a esta sucursal.");
    const repo = deps.restaurantesRepo(c.get("db"));
    const branch = await repo.findBranchById(organizationId, branchId);
    if (!branch) throw Errors.notFound("Sucursal no encontrada.");
    return { organizationId, branch, repo };
  }

  app.get(path, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    await resolveBranch(c);
    const faltantes = faltantesEmbeddedSignup(deps.env);
    return c.json({
      disponible: faltantes.length === 0,
      faltantes,
      appId: faltantes.length === 0 ? deps.env.metaAppId : null,
      configId: faltantes.length === 0 ? deps.env.whatsappEsConfigId : null,
      graphApiVersion: deps.env.whatsappGraphApiVersion ?? "v21.0",
    });
  });

  app.post(path, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, branch, repo } = await resolveBranch(c);
    const faltantes = faltantesEmbeddedSignup(deps.env);
    if (faltantes.length > 0) throw Errors.serviceUnavailable(`Conectar tu número con Meta no está disponible aún: requiere configurar ${faltantes.join(", ")}.`);
    const raw = await readJsonCapped<{ code?: unknown; wabaId?: unknown; phoneNumberId?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof raw.code !== "string" || !/^[A-Za-z0-9_\-.#]{10,2048}$/.test(raw.code)) throw Errors.validation("Autorización de Meta inválida.");
    if (typeof raw.wabaId !== "string" || !/^\d{5,32}$/.test(raw.wabaId)) throw Errors.validation("wabaId inválido.");
    if (typeof raw.phoneNumberId !== "string" || !/^\d{5,32}$/.test(raw.phoneNumberId)) throw Errors.validation("phoneNumberId inválido.");
    if (!(await rateLimit(`restaurantes:whatsapp-es:${organizationId}`, EMBEDDED_SIGNUP_INTENTOS_POR_HORA, 60 * 60_000, { category: "auth:token-issue" }))) {
      throw Errors.tooManyRequests("Demasiados intentos de conexión. Intenta de nuevo en una hora.");
    }

    const cliente = new MetaEmbeddedSignupClient({
      appId: deps.env.metaAppId as string,
      appSecret: deps.env.whatsappAppSecret as string,
      ...(deps.env.whatsappGraphApiVersion ? { apiVersion: deps.env.whatsappGraphApiVersion } : {}),
    });
    const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    let conexion;
    try {
      conexion = await cliente.conectar({ code: raw.code, wabaId: raw.wabaId, phoneNumberId: raw.phoneNumberId, systemUserId: deps.env.whatsappSystemUserId as string, pin });
    } catch (err) {
      if (err instanceof EmbeddedSignupError) {
        // El mensaje ya viene redactado (sin tokens ni secretos); el `code` nunca se registra.
        logEvent(c, "warn", "restaurantes_whatsapp_es_fallo", { organizationId, branchId: branch.propertyId, paso: err.paso, httpStatus: err.httpStatus ?? null, graphCode: err.graphCode ?? null, detalle: err.message });
        throw Errors.conflict(MENSAJE_PASO[err.paso]);
      }
      throw err;
    }

    const anterior = (await repo.listWhatsappBranchChannels(organizationId)).find((n) => n.propertyId === branch.propertyId);
    try {
      await repo.upsertWhatsappBranchChannel(organizationId, branch.propertyId, conexion.phoneNumberId);
    } catch (err) {
      if (err instanceof WhatsappNumberInUseError) throw Errors.conflict(err.message);
      if (err instanceof RestaurantesConfigUnavailableError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }
    logEvent(c, "info", "restaurantes_whatsapp_es_conectado", { actorUserId: c.get("userId"), organizationId, branchId: branch.propertyId });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.whatsapp_embedded_signup",
      entityType: "configuracion",
      entityId: branch.propertyId,
      campo: "phoneNumberId",
      antes: anterior?.phoneNumberId ?? null,
      despues: `${conexion.phoneNumberId} (WABA ${conexion.wabaId})`,
    });
    return c.json({ phoneNumberId: conexion.phoneNumberId, numero: conexion.displayPhoneNumber, nombreVerificado: conexion.verifiedName, pin }, 201);
  });

  return app;
}
