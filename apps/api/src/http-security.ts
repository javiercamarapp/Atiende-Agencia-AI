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
 * Gate de rutas internas de scheduler que ahora aceptan DOS formas de probar el
 * mismo secreto compartido (`expected`, el mismo valor que `ApiEnv.internalSecret`):
 *
 *   1. `x-atiende-internal-secret: <secreto>` — invocación manual/curl/tests, el
 *      mecanismo que ya existía (ver `secretMatches` de arriba).
 *   2. `Authorization: Bearer <secreto>` — Vercel Cron Jobs NO permiten configurar
 *      headers custom en `vercel.json` (solo `path`/`schedule`); lo único que Vercel
 *      agrega automáticamente a la request GET que dispara es
 *      `Authorization: Bearer $CRON_SECRET` cuando esa env var existe en el proyecto
 *      (ver https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
 *      Por eso el operador debe configurar `CRON_SECRET` en Vercel con EL MISMO
 *      valor que `INTERNAL_SECRET` — nunca se introduce un segundo secreto en
 *      código, solo se acepta la forma en que el scheduler externo puede mandarlo.
 *
 * Ninguna de las dos formas se vuelve obligatoria: un curl manual sigue funcionando
 * exactamente igual que antes con el header custom, sin tocar `Authorization`.
 *
 * Usada tanto por las rutas internas de citas (email-dispatch/reminders/
 * google-calendar-sync) como por las de licitaciones (discover-tenders/
 * deadline-reminders/alert-notifications/email-dispatch) — mismo problema,
 * mismo secreto compartido, una sola función.
 */
export function internalOrCronSecretMatches(req: Request, expected: string): boolean {
  if (secretMatches(req, "x-atiende-internal-secret", expected)) return true;
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return constantTimeEqual(auth.slice("Bearer ".length), expected);
}

/** El último salto de X-Forwarded-For evita que un prefijo controlado por el caller
 * fabrique un bucket nuevo por request; cf-connecting-ip (proxy confiable) tiene
 * prioridad cuando está presente. */
export function requestActor(req: Request, secondary = ""): string {
  const connectingIp = req.headers.get("cf-connecting-ip")?.trim();
  const forwarded = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return `${connectingIp || forwarded || "unknown"}:${secondary.slice(0, 128)}`;
}

/** Lee el body crudo (texto) con un límite explícito de bytes — mismo candado que
 * `readJsonCapped` (content-length declarado Y tamaño real, por si el header
 * miente), reutilizado también por rutas que reciben texto plano en vez de JSON
 * (p. ej. `POST /despachos/:propertyId/cfdi/importar-xml`, un CFDI XML crudo). */
export async function readTextCapped(req: Request, maxBytes: number): Promise<string> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > maxBytes) {
    throw Errors.payloadTooLarge();
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw Errors.payloadTooLarge();
  }
  return raw;
}

/** Lee y parsea JSON con un límite explícito de bytes — port literal de readJson. */
export async function readJsonCapped<T = unknown>(req: Request, maxBytes = 64 * 1024): Promise<T> {
  const raw = await readTextCapped(req, maxBytes);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw Errors.validation("JSON inválido");
  }
}
