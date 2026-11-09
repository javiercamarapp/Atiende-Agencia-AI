// Credenciales de Meta (WhatsApp Cloud API) por organizacion, vista del SUPERADMIN (migracion 0090).
//
//   GET  /superadmin/organizaciones/:id/whatsapp-meta                              credenciales (solo metadatos) y numeros de la org
//   POST /superadmin/organizaciones/:id/whatsapp-meta/credenciales                 registrar una app de Meta (step-up MFA)
//   PUT  /superadmin/organizaciones/:id/whatsapp-meta/credenciales/:cid            rotar secreto, token, verify token o etiqueta (step-up)
//   POST /superadmin/organizaciones/:id/whatsapp-meta/credenciales/:cid/revocar    revocar: borra los sobres y libera sus numeros (step-up)
//   PUT  /superadmin/organizaciones/:id/whatsapp-meta/numeros                      asignar numero -> sucursal y credencial (step-up)
//
// Autenticacion, gateo de superadmin, zona CFO y step-up montados una vez en routes/superadmin.ts sobre `/superadmin/*`; la autoridad
// real sigue en SQL (caller-binding + superadmin no restringido; bitacora append-only core.whatsapp_meta_evento). Los secretos son de
// SOLO ESCRITURA: llegan en el cuerpo, se cifran aqui (AES-256-GCM, AAD de la credencial) y ninguna respuesta ni log los devuelve; el
// verify token se guarda como SHA-256. Sin WHATSAPP_CREDENTIALS_KEY: GET `disponible: false` y escrituras 503. Base sin migrar: igual.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import { aadCredencialMeta, asignarNumero, hashVerifyToken, listarParaSuperadmin, registrarCredencial, revocarCredencial, rotarCredencial } from "../whatsapp-credenciales/index.ts";
import type { ResultadoEscritura, WhatsAppMetaDeps } from "../whatsapp-credenciales/index.ts";
import type { AppDeps } from "../deps.ts";

export const WHATSAPP_META_SIN_LLAVE = "Las credenciales de Meta por organización no están activas en este despliegue: falta configurar WHATSAPP_CREDENTIALS_KEY en la API.";
export const WHATSAPP_META_NO_MIGRADA = "Las credenciales de Meta por organización todavía no están disponibles en esta base (falta aplicar la migración 0090_whatsapp_credenciales_meta).";

const MUTACION_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_META_RE = /^[0-9]{5,32}$/;
const APP_SECRET_RE = /^[A-Za-z0-9]{16,128}$/;
const ACCESS_TOKEN_RE = /^[A-Za-z0-9_\-.|]{20,2048}$/;
const VERIFY_TOKEN_RE = /^[\x21-\x7e]{16,256}$/;

const texto = (v: unknown): string | undefined => (typeof v === "string" ? v.trim() : undefined);

function orgDe(c: Context<CoreAuthHonoEnv>): string {
  const id = c.req.param("id") ?? "";
  if (!UUID_RE.test(id)) throw Errors.validation("El id de la organización no es válido.");
  return id;
}

function credDe(c: Context<CoreAuthHonoEnv>): string {
  const id = c.req.param("cid") ?? "";
  if (!UUID_RE.test(id)) throw Errors.validation("El id de la credencial no es válido.");
  return id;
}

function metaDe(deps: AppDeps): WhatsAppMetaDeps {
  if (!deps.whatsappMeta) throw Errors.serviceUnavailable(WHATSAPP_META_SIN_LLAVE);
  return deps.whatsappMeta;
}

async function limitar(c: Context<CoreAuthHonoEnv>): Promise<void> {
  const allowed = await rateLimit(`admin:whatsapp-meta:${requestActor(c.req.raw, c.get("userId"))}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
  if (!allowed) throw Errors.tooManyRequests("Demasiados cambios de credenciales de WhatsApp en poco tiempo.");
}

/** Traduce el resultado de una escritura SQL a la respuesta HTTP (sin repetir el mensaje interno de Postgres). */
function exigirOk<T>(r: ResultadoEscritura<T>): T {
  if (r.estado === "ok") return r.valor;
  if (r.estado === "no_migrada") throw Errors.serviceUnavailable(WHATSAPP_META_NO_MIGRADA);
  switch (r.sqlstate) {
    case "P0002":
      throw Errors.notFound("La organización, la sucursal o la credencial no existe, es de otra organización o ya está revocada.");
    case "23505":
      throw Errors.conflict("Esa app, WABA o número ya está registrado en otra organización.");
    case "42501":
      throw Errors.forbidden("Solo un superadmin con permisos de escritura puede cambiar credenciales de WhatsApp.");
    default:
      throw Errors.validation("Los datos no son válidos para esta operación.");
  }
}

interface RegistroBody {
  readonly etiqueta?: unknown;
  readonly appId?: unknown;
  readonly wabaId?: unknown;
  readonly appSecret?: unknown;
  readonly accessToken?: unknown;
  readonly verifyToken?: unknown;
}

interface RotarBody {
  readonly etiqueta?: unknown;
  readonly appSecret?: unknown;
  readonly accessToken?: unknown;
  readonly verifyToken?: unknown;
  readonly quitarVerifyToken?: unknown;
}

function validarEtiqueta(v: string | undefined): string {
  if (!v || v.length > 80) throw Errors.validation("La etiqueta es obligatoria (1 a 80 caracteres).");
  return v;
}
function validarSecreto(v: string | undefined): string {
  if (!v || !APP_SECRET_RE.test(v)) throw Errors.validation("El secreto de la app debe ser alfanumérico (16 a 128 caracteres), como lo muestra Meta en Configuración básica.");
  return v;
}
function validarToken(v: string | undefined): string {
  if (!v || !ACCESS_TOKEN_RE.test(v)) throw Errors.validation("El token del usuario de sistema no tiene un formato válido (20 a 2048 caracteres, sin espacios).");
  return v;
}
function validarVerifyToken(v: string | undefined): string {
  if (!v || !VERIFY_TOKEN_RE.test(v)) throw Errors.validation("El verify token debe medir de 16 a 256 caracteres visibles, sin espacios.");
  return v;
}

export function superadminWhatsappMetaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const ruta = "/superadmin/organizaciones/:id/whatsapp-meta";

  app.get(ruta, async (c) => {
    const organizationId = orgDe(c);
    if (!deps.whatsappMeta) return c.json({ disponible: false, motivo: "sin_llave", mensaje: WHATSAPP_META_SIN_LLAVE, credenciales: [], numeros: [] });
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => listarParaSuperadmin(db, callerId, organizationId));
    if (!r.disponible) return c.json({ disponible: false, motivo: "no_migrada", mensaje: WHATSAPP_META_NO_MIGRADA, credenciales: [], numeros: [] });
    return c.json({ disponible: true, credenciales: r.credenciales, numeros: r.numeros });
  });

  app.post(`${ruta}/credenciales`, async (c) => {
    const organizationId = orgDe(c);
    const meta = metaDe(deps);
    await limitar(c);
    const raw = (await c.req.json().catch(() => ({}))) as RegistroBody;
    const etiqueta = validarEtiqueta(texto(raw.etiqueta));
    const appId = texto(raw.appId) ?? "";
    const wabaId = texto(raw.wabaId) ?? "";
    if (!ID_META_RE.test(appId)) throw Errors.validation("El App ID son solo dígitos (5 a 32).");
    if (!ID_META_RE.test(wabaId)) throw Errors.validation("El ID de la cuenta de WhatsApp Business (WABA) son solo dígitos (5 a 32).");
    const appSecret = validarSecreto(texto(raw.appSecret));
    const accessToken = validarToken(texto(raw.accessToken));
    const verifyToken = texto(raw.verifyToken) ? validarVerifyToken(texto(raw.verifyToken)) : null;

    const callerId = c.get("userId");
    const credencialId = randomUUID();
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) =>
      registrarCredencial(db, {
        callerId,
        credencialId,
        organizationId,
        etiqueta,
        appId,
        wabaId,
        appSecretCifrado: meta.cifrador.cifrar(appSecret, aadCredencialMeta(credencialId, organizationId, "app_secret")),
        accessTokenCifrado: meta.cifrador.cifrar(accessToken, aadCredencialMeta(credencialId, organizationId, "access_token")),
        verifyTokenHash: verifyToken ? hashVerifyToken(verifyToken) : null,
      }),
    );
    exigirOk(r);
    meta.resolutor.invalidar();
    return c.json({ credencial: { id: credencialId, etiqueta, appId, wabaId, tieneVerifyToken: verifyToken !== null, activa: true } }, 201);
  });

  app.put(`${ruta}/credenciales/:cid`, async (c) => {
    const organizationId = orgDe(c);
    const credencialId = credDe(c);
    const meta = metaDe(deps);
    await limitar(c);
    const raw = (await c.req.json().catch(() => ({}))) as RotarBody;
    const etiqueta = texto(raw.etiqueta) ? validarEtiqueta(texto(raw.etiqueta)) : null;
    const appSecret = texto(raw.appSecret) ? validarSecreto(texto(raw.appSecret)) : null;
    const accessToken = texto(raw.accessToken) ? validarToken(texto(raw.accessToken)) : null;
    const verifyToken = texto(raw.verifyToken) ? validarVerifyToken(texto(raw.verifyToken)) : null;
    const quitarVerifyToken = raw.quitarVerifyToken === true;
    if (quitarVerifyToken && verifyToken) throw Errors.validation("No se puede poner y quitar el verify token a la vez.");
    if (!etiqueta && !appSecret && !accessToken && !verifyToken && !quitarVerifyToken) throw Errors.validation("No hay nada que cambiar.");

    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) =>
      rotarCredencial(db, {
        callerId,
        credencialId,
        organizationId,
        etiqueta,
        appSecretCifrado: appSecret ? meta.cifrador.cifrar(appSecret, aadCredencialMeta(credencialId, organizationId, "app_secret")) : null,
        accessTokenCifrado: accessToken ? meta.cifrador.cifrar(accessToken, aadCredencialMeta(credencialId, organizationId, "access_token")) : null,
        verifyTokenHash: verifyToken ? hashVerifyToken(verifyToken) : null,
        quitarVerifyToken,
      }),
    );
    exigirOk(r);
    meta.resolutor.invalidar();
    return c.json({ rotada: true, campos: [etiqueta && "etiqueta", appSecret && "appSecret", accessToken && "accessToken", verifyToken && "verifyToken", quitarVerifyToken && "verifyTokenQuitado"].filter(Boolean) });
  });

  app.post(`${ruta}/credenciales/:cid/revocar`, async (c) => {
    const organizationId = orgDe(c);
    const credencialId = credDe(c);
    const meta = metaDe(deps);
    await limitar(c);
    const raw = (await c.req.json().catch(() => ({}))) as { readonly motivo?: unknown };
    const motivo = texto(raw.motivo) ?? "";
    if (motivo.length < 10 || motivo.length > 500) throw Errors.validation("El motivo es obligatorio (10 a 500 caracteres).");
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => revocarCredencial(db, { callerId, credencialId, organizationId, motivo }));
    const liberados = exigirOk(r);
    meta.resolutor.invalidar();
    return c.json({ revocada: true, numerosLiberados: liberados });
  });

  app.put(`${ruta}/numeros`, async (c) => {
    const organizationId = orgDe(c);
    const meta = metaDe(deps);
    await limitar(c);
    const raw = (await c.req.json().catch(() => ({}))) as { readonly phoneNumberId?: unknown; readonly credencialId?: unknown; readonly propertyId?: unknown };
    const phoneNumberId = texto(raw.phoneNumberId) ?? "";
    if (!ID_META_RE.test(phoneNumberId)) throw Errors.validation("El phone_number_id son solo dígitos (5 a 32), como lo muestra Meta en Configuración de la API.");
    const credencialId = raw.credencialId === null || raw.credencialId === undefined || raw.credencialId === "" ? null : texto(raw.credencialId) ?? "";
    if (credencialId !== null && !UUID_RE.test(credencialId)) throw Errors.validation("La credencial no es válida.");
    const propertyId = raw.propertyId === null || raw.propertyId === undefined || raw.propertyId === "" ? null : texto(raw.propertyId) ?? "";
    if (propertyId !== null && !UUID_RE.test(propertyId)) throw Errors.validation("La sucursal no es válida.");
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => asignarNumero(db, { callerId, organizationId, phoneNumberId, credencialId, propertyId }));
    exigirOk(r);
    meta.resolutor.invalidar();
    return c.json({ asignado: true, phoneNumberId, credencialId, propertyId });
  });

  return app;
}
