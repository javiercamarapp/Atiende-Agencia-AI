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

/**
 * Hallazgo de revisión real (ronda r5, bloqueante 1 del PR #167): esta función
 * confiaba PRIMERO en `cf-connecting-ip` asumiendo un proxy Cloudflare delante
 * de Vercel -- verificado contra el código real, NO es el caso (`vercel.json`
 * no tiene ninguna evidencia de Cloudflare, el despliegue es Vercel directo).
 * Un header que el propio cliente puede escribir libremente y que Vercel deja
 * pasar intacto hasta el handler NO es una fuente de identidad para un
 * rate-limit evaluado ANTES de cualquier prueba de identidad (ver
 * `routes/billing.ts`, límite pre-firma de Stripe): cualquiera sin
 * credenciales podía (a) evadir el límite rotando `cf-connecting-ip` en cada
 * request, o (b) escribir la IP de un tercero legítimo para agotarle su
 * propio cupo (denegación de servicio dirigida).
 *
 * Fuente por defecto: el ÚLTIMO salto de `X-Forwarded-For` -- es el único que
 * un caller sin acceso a la red de Vercel no puede fabricar (Vercel APPENDA la
 * IP real del cliente al final de la cadena que reenvía al handler, sin
 * importar qué haya escrito el cliente antes; ver
 * https://vercel.com/docs/edge-network/headers#x-forwarded-for), con
 * `X-Real-IP` (también inyectado por Vercel, nunca por el cliente) como
 * respaldo. `cf-connecting-ip` NUNCA se usa por defecto -- solo si un
 * operador declara explícitamente, vía `TRUSTED_PROXY_IP_HEADER`, qué proxy
 * confiable está de verdad delante de Vercel (p. ej. si en el futuro se pone
 * Cloudflare enfrente de este despliegue); la sola PRESENCIA del header nunca
 * lo activa.
 */
const TRUSTED_PROXY_IP_HEADER = process.env.TRUSTED_PROXY_IP_HEADER?.trim().toLowerCase() || null;

export function requestActor(req: Request, secondary = ""): string {
  const trustedProxyIp = TRUSTED_PROXY_IP_HEADER ? req.headers.get(TRUSTED_PROXY_IP_HEADER)?.trim() : undefined;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  const realIp = req.headers.get("x-real-ip")?.trim();
  return `${trustedProxyIp || forwarded || realIp || "unknown"}:${secondary.slice(0, 128)}`;
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
