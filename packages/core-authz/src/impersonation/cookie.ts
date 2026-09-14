// LA COOKIE FIRMADA DE SELECCIÓN DE ORGANIZACIÓN — puerto generalizado del
// patrón real del proyecto origen: `firmarSeleccion`/`validarSeleccion` en
// ~/proyecto-origen/src/lib/auth/admin-context.ts (formato `v1.<id>.<expira>.<hmac>`,
// HMAC-SHA256, comparación en tiempo constante — el mismo criterio que
// `verificarFirma` de ~/proyecto-origen/src/lib/correo/firma_entrante.ts).
//
// POR QUÉ COOKIE Y NO QUERY STRING: un query param no es fuente de
// autorización — se comparte en un link, se guarda en un bookmark, y nadie
// audita cuándo cambió. La cookie es httpOnly (el llamador HTTP la marca así
// al escribirla; este módulo no depende de un framework y no la escribe él
// mismo, ver comentario de `IMPERSONATION_COOKIE_NAME` abajo).
//
// POR QUÉ LA LLAVE SE INYECTA (no `process.env` aquí dentro): mismo criterio
// que `core-auth` (ver `CoreAuthEnv` en packages/core-auth/src/types.ts,
// "este paquete no lee process.env directamente, para quedar testeable sin
// variables globales"). `apps/api` es quien lee la variable de entorno y la
// pasa como `secret` — ver `IMPERSONATION_COOKIE_SECRET_ENV_HINT` abajo para
// cuál debe ser esa variable.
import { createHmac, timingSafeEqual } from "node:crypto";
import { ImpersonationSigningKeyMissingError, InvalidOrganizationIdError } from "./errors.ts";

/** Nombre de la cookie. Prefijo propio del monorepo para no chocar con las
 *  de Supabase Auth ni con las de sesión de `core-auth`. */
export const IMPERSONATION_COOKIE_NAME = "atiende_impersonation_org";

/**
 * TTL de una selección: 12 horas (una jornada de trabajo larga). Al expirar,
 * el superadmin vuelve a elegir explícitamente — el costo es un clic; el
 * beneficio es que "qué organización estoy mirando" nunca sea un residuo de
 * ayer. Mismo TTL que `TTL_SELECCION_MS` en admin-context.ts del proyecto origen.
 */
export const IMPERSONATION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * DOCUMENTACIÓN, no lectura directa: el nombre que la variable de entorno
 * DEBE tener cuando `apps/api` la lea para construir el `secret` que se pasa
 * a `signImpersonationSelection`/`verifyImpersonationSelection`.
 *
 * Requisito NO NEGOCIABLE (mandato de la tarea, y AUDITORÍA 18-B13 del proyecto origen
 * como precedente real del error contrario): esta llave es DEDICADA a firmar
 * SOLO esta cookie. Nunca debe ser:
 *   - la service-role key de Supabase (ni de este monorepo ni de ningún
 *     proyecto Supabase conectado) — mezclar el material de acceso total a
 *     la base con la firma de una cookie de sesión hace que rotar la
 *     service-role key (lo primero que se hace ante una fuga) tire también
 *     todas las selecciones de impersonación vivas, y viceversa: rotar esta
 *     llave por higiene no debería tocar el acceso a la base.
 *   - el `jwtSecret` de `core-auth` (`CoreAuthEnv.jwtSecret`) ni ningún otro
 *     secreto que el monorepo ya use para otro propósito.
 * La ausencia de esta variable es un estado DECLARADO (ver
 * `ImpersonationSigningKeyMissingError`), nunca uno que otro secreto tapa.
 */
export const IMPERSONATION_COOKIE_SECRET_ENV_HINT = "CORE_AUTHZ_IMPERSONATION_COOKIE_SECRET";

/** Una selección de organización ya verificada: el HMAC cuadró y no expiró. */
export interface ImpersonationSelection {
  readonly organizationId: string;
  readonly expiresAtMs: number;
}

function assertSigningKey(secret: string | null | undefined): asserts secret is string {
  if (!secret || !secret.trim()) throw new ImpersonationSigningKeyMissingError();
}

/** Comparación en tiempo constante — mismo patrón que `igualEnTiempoConstante`
 *  en admin-context.ts: longitudes distintas se rechazan ANTES de comparar
 *  (timingSafeEqual exige buffers del mismo tamaño), nunca lanzando. */
function signaturesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function hmacFor(organizationId: string, expiresAtMs: number, secret: string): string {
  return createHmac("sha256", secret).update(`${organizationId}.${expiresAtMs}`, "utf8").digest("base64url");
}

/**
 * Firma una selección de organización. Formato `v1.<organizationId>.<expiraMs>.<hmac>`.
 *
 * `nowMs` se inyecta (por default `Date.now()`) para poder probar los bordes
 * de expiración sin depender del reloj real — mismo criterio que `ahoraMs` en
 * `firmarSeleccion` del proyecto origen.
 *
 * Lanza `ImpersonationSigningKeyMissingError` si no hay llave (fail-closed:
 * nunca produce una cookie "firmada" con una llave vacía) e
 * `InvalidOrganizationIdError` si `organizationId` viene vacío.
 */
export function signImpersonationSelection(
  organizationId: string,
  secret: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  assertSigningKey(secret);
  if (!organizationId) throw new InvalidOrganizationIdError();
  const expiresAtMs = nowMs + IMPERSONATION_TTL_MS;
  const signature = hmacFor(organizationId, expiresAtMs, secret);
  return `v1.${organizationId}.${expiresAtMs}.${signature}`;
}

/**
 * Valida el valor crudo de la cookie y devuelve la selección, o `null` si la
 * firma no cuadra, expiró, el formato no es el esperado, o no hay llave con
 * qué validar. TODO camino dudoso es `null`: una selección ilegible es una
 * NO-selección (fail-closed), jamás una organización adivinada — mismo
 * criterio que `validarSeleccion` del proyecto origen.
 *
 * Deliberadamente NO lanza cuando falta la llave (a diferencia de firmar):
 * "no puedo validar nada ahora mismo" y "no hay selección" tienen el mismo
 * efecto correcto para el llamador (`resolveImpersonatedOrganization` más
 * abajo trata ambos como "sin selección" y falla cerrado igual).
 */
export function verifyImpersonationSelection(
  cookieValue: string | null | undefined,
  secret: string | null | undefined,
  nowMs: number = Date.now(),
): ImpersonationSelection | null {
  if (!cookieValue) return null;
  if (!secret || !secret.trim()) return null;

  const parts = cookieValue.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const organizationId = parts[1];
  const expiresRaw = parts[2];
  const signature = parts[3];
  if (!organizationId || !expiresRaw || !signature) return null;

  const expiresAtMs = Number(expiresRaw);
  if (!Number.isFinite(expiresAtMs)) return null;
  if (nowMs > expiresAtMs) return null;

  const expected = hmacFor(organizationId, expiresAtMs, secret);
  if (!signaturesMatch(signature, expected)) return null;

  return { organizationId, expiresAtMs };
}
