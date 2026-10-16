// Autenticacion y aislamiento de las herramientas de voz de restaurantes (endurecimiento de
// aislamiento entre numeros y sucursales; defensa en profundidad). Tres formas de presentarse, de la
// mas a la menos acotada:
//
//   1. TOKEN POR LLAMADA (`x-atiende-call-token`): firmado, expira, ligado a organizacion + sucursal +
//      callId + telefono del llamante. La sucursal y el telefono salen del token.
//   2. SECRETO POR SUCURSAL (`x-atiende-tool-secret`): se compara su hash contra
//      `restaurantes.voice_branch_secret` (rotable); fija la sucursal pero no el telefono.
//   3. SECRETO GLOBAL LEGADO (`x-atiende-tool-secret` == VOICE_TOOL_SECRET): camino anterior, se sigue
//      aceptando para no romper integraciones existentes (con aviso en log). Sin token no hay telefono
//      ni estado de llamada confiables.
//
// `VOICE_REQUIRE_CALL_TOKEN=true` cierra 2 y 3 para las herramientas (solo emiten tokens).
//
// Los rechazos se devuelven como respuesta (no como excepcion) para que la bitacora del rechazo
// quede confirmada con la transaccion del request en vez de revertirse con ella.
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { actorHash, consumeRateLimit } from "@atiende/domain-restaurantes";
import type { RestaurantesRepository, VoiceToolAuditOutcome } from "@atiende/domain-restaurantes";
import { constantTimeEqual } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { VOICE_CALL_TOKEN_HEADER, verifyVoiceCallToken, voiceCallTokenKey } from "../../../voice-call-token.ts";

export const VOICE_SECRET_HEADER = "x-atiende-tool-secret";

export interface VoiceCaller {
  readonly kind: "call_token" | "branch_secret" | "legacy_secret";
  /** Sucursal fijada por el token o por el secreto de sucursal (null = legado, sin sucursal fija). */
  readonly propertyId: string | null;
  readonly callId: string | null;
  /** Telefono canonico de 10 digitos tomado del token (null sin token). */
  readonly phone: string | null;
  /** El telefono del token lo dicto el cliente (no viene de la telefonia): no se le entregan datos personales asociados a ese numero. */
  readonly phoneDeclared?: boolean;
}

export type VoiceAuthResult = { readonly ok: true; readonly caller: VoiceCaller } | { readonly ok: false; readonly response: Response };

export function hashVoiceSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** ¿Trae la request alguna credencial de voz (token de llamada o secreto)? Verificacion barata previa a leer el body. */
export function hasVoiceCredentials(c: Context): boolean {
  return Boolean(c.req.header(VOICE_CALL_TOKEN_HEADER) || c.req.header(VOICE_SECRET_HEADER));
}

let legacyWarned = false;
function warnLegacyOnce(): void {
  if (legacyWarned) return;
  legacyWarned = true;
  console.warn(
    "voz restaurantes: una herramienta se autenticó con el secreto GLOBAL legado (VOICE_TOOL_SECRET) sin token de llamada -- camino de compatibilidad. " +
      "Migra a secretos por sucursal + token por llamada y activa VOICE_REQUIRE_CALL_TOKEN=true.",
  );
}

export async function auditVoice(
  repo: RestaurantesRepository,
  org: { readonly id: string },
  caller: Pick<VoiceCaller, "propertyId" | "callId" | "phone"> | null,
  tool: string,
  outcome: VoiceToolAuditOutcome,
  detail: string | null,
): Promise<void> {
  await repo.recordVoiceToolAudit({
    organizationId: org.id,
    propertyId: caller?.propertyId ?? null,
    callId: caller?.callId ?? null,
    tool,
    outcome,
    phoneHash: caller?.phone ? actorHash(caller.phone) : null,
    detail,
  });
}

function deny(c: Context, status: 401 | 403 | 429, code: string, message: string): Response {
  return c.json({ code, message }, status);
}

export interface AuthenticateOptions {
  readonly tool: string;
  /** "required": solo el token de llamada; "legacy_ok": token, secreto por sucursal o secreto legado. */
  readonly accept: "required" | "legacy_ok";
  /** Emision del token: solo secretos (nunca un token) y aunque VOICE_REQUIRE_CALL_TOKEN este activo. */
  readonly secretOnly?: boolean;
}

export async function authenticateVoiceTool(
  deps: AppDeps,
  c: Context,
  repo: RestaurantesRepository,
  org: { readonly id: string },
  opts: AuthenticateOptions,
): Promise<VoiceAuthResult> {
  const token = c.req.header(VOICE_CALL_TOKEN_HEADER);
  const secret = c.req.header(VOICE_SECRET_HEADER);

  if (token && !opts.secretOnly) {
    const verified = verifyVoiceCallToken(voiceCallTokenKey(deps.env.internalSecret), token);
    if (!verified.ok) {
      await auditVoice(repo, org, null, opts.tool, "denied", `token_${verified.reason}`);
      return { ok: false, response: deny(c, 401, "unauthorized", "Token de llamada inválido o expirado.") };
    }
    // Un token de OTRA organizacion nunca vale aqui (aislamiento entre restaurantes).
    if (verified.claims.org !== org.id) {
      await auditVoice(repo, org, null, opts.tool, "denied", "token_otra_organizacion");
      return { ok: false, response: deny(c, 401, "unauthorized", "Token de llamada inválido o expirado.") };
    }
    return { ok: true, caller: { kind: "call_token", propertyId: verified.claims.prop, callId: verified.claims.call, phone: verified.claims.ph, phoneDeclared: verified.claims.decl === true } };
  }

  if (!secret) {
    await auditVoice(repo, org, null, opts.tool, "denied", "sin_credencial");
    return { ok: false, response: deny(c, 401, "unauthorized", "Credenciales inválidas o token ausente/expirado.") };
  }

  const secretsAllowed = opts.secretOnly === true || (opts.accept === "legacy_ok" && deps.env.voiceRequireCallToken !== true);
  if (!secretsAllowed) {
    await auditVoice(repo, org, null, opts.tool, "denied", "se_requiere_token_de_llamada");
    return { ok: false, response: deny(c, 401, "unauthorized", "Esta herramienta requiere el token de la llamada.") };
  }

  // 2) secreto por sucursal (base migrada)
  const match = await repo.verifyVoiceBranchSecret(org.id, hashVoiceSecret(secret));
  if (match.status === "match") {
    return { ok: true, caller: { kind: "branch_secret", propertyId: match.propertyId, callId: null, phone: null } };
  }
  // 3) secreto global legado (base sin migrar, o secreto que no es de ninguna sucursal)
  if (constantTimeEqual(secret, deps.env.voiceToolSecret)) {
    warnLegacyOnce();
    return { ok: true, caller: { kind: "legacy_secret", propertyId: null, callId: null, phone: null } };
  }
  await auditVoice(repo, org, null, opts.tool, "denied", "secreto_invalido");
  return { ok: false, response: deny(c, 401, "unauthorized", "Credenciales inválidas o token ausente/expirado.") };
}

/**
 * Limites por llamada y por sucursal (la IP que ve la API es la del proveedor de voz, no sirve como
 * identidad). Sin token ni sucursal fija (legado) devuelve `null` y el llamador conserva su limite por IP.
 */
export async function enforceVoiceLimits(
  c: Context,
  repo: RestaurantesRepository,
  org: { readonly id: string },
  caller: VoiceCaller,
  tool: string,
): Promise<Response | null> {
  if (caller.callId) {
    const perCall = await consumeRateLimit(repo, "voice-call", `${org.id}:${caller.callId}`, 120, 600);
    if (!perCall.allowed) {
      await auditVoice(repo, org, caller, tool, "rate_limited", "limite_por_llamada");
      return c.json({ code: "too_many_requests", message: "Demasiadas solicitudes en esta llamada." }, 429, { "Retry-After": "60" });
    }
  }
  if (caller.propertyId) {
    const perBranch = await consumeRateLimit(repo, "voice-branch", `${org.id}:${caller.propertyId}`, 600, 60);
    if (!perBranch.allowed) {
      await auditVoice(repo, org, caller, tool, "rate_limited", "limite_por_sucursal");
      return c.json({ code: "too_many_requests", message: "Demasiadas solicitudes para esta sucursal." }, 429, { "Retry-After": "60" });
    }
  }
  return null;
}
