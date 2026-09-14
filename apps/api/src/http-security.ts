// Port de restaurantes/supabase/functions/_shared/http-security.ts a Hono/Node — el
// contrato Fetch API `Request` es el mismo estándar web que usaba el origen en Deno,
// así que la lógica porta casi literal; solo `Deno.env.get(...)` se reemplaza por
// parámetros explícitos (ApiEnv, ya cargado por apps/api/src/env.ts) en vez de leer
// variables de entorno globales dentro de esta lógica.
import { Errors } from "./errors.ts";

export function originAllowed(origin: string | null, allowed: readonly string[]): boolean {
  return origin === null || allowed.includes(origin);
}

export function constantTimeEqual(actual: string | null | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const encoder = new TextEncoder();
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  const length = Math.max(actualBytes.length, expectedBytes.length);
  let difference = actualBytes.length ^ expectedBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (actualBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
}

export function secretMatches(req: Request, header: string, expected: string): boolean {
  return constantTimeEqual(req.headers.get(header), expected);
}

/**
 * Variante de `secretMatches` para rutas internas que además deben aceptar un
 * disparo real de Vercel Cron (ver `vercel.json::crons` y
 * `routes/verticals/citas/{email-dispatch,reminders,google-calendar-sync}.ts`).
 * Vercel SIEMPRE invoca un Cron Job con GET y solo sabe mandar el secreto como
 * `Authorization: Bearer <CRON_SECRET>` (la variable de entorno `CRON_SECRET` del
 * dashboard de Vercel) — nunca puede mandar el header custom
 * `x-atiende-internal-secret` que usa una invocación manual/de test. En vez de
 * mantener dos secretos en paralelo, el operador configura `CRON_SECRET` en
 * Vercel con el MISMO valor que `INTERNAL_SECRET`; esta función acepta
 * cualquiera de las dos formas de mandar ese único secreto.
 */
export function schedulerSecretMatches(req: Request, expected: string): boolean {
  if (secretMatches(req, "x-atiende-internal-secret", expected)) return true;
  const authorization = req.headers.get("authorization");
  if (!authorization) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return false;
  return constantTimeEqual(match[1], expected);
}

/** El último salto de X-Forwarded-For evita que un prefijo controlado por el caller
 * fabrique un bucket nuevo por request; cf-connecting-ip (proxy confiable) tiene
 * prioridad cuando está presente. */
export function requestActor(req: Request, secondary = ""): string {
  const connectingIp = req.headers.get("cf-connecting-ip")?.trim();
  const forwarded = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return `${connectingIp || forwarded || "unknown"}:${secondary.slice(0, 128)}`;
}

/** Lee y parsea JSON con un límite explícito de bytes — port literal de readJson. */
export async function readJsonCapped<T = unknown>(req: Request, maxBytes = 64 * 1024): Promise<T> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > maxBytes) {
    throw Errors.payloadTooLarge();
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw Errors.payloadTooLarge();
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw Errors.validation("JSON inválido");
  }
}
