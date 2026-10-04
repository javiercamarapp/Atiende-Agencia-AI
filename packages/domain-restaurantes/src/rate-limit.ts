// Port literal de consumeRateLimit/actorHash/requestActor de
// restaurantes/supabase/functions/_shared/http-security.ts, sobre el repositorio en
// vez de un cliente supabase-js directo.
import { createHash, createHmac } from "node:crypto";
import type { RestaurantesRepository } from "./repository.ts";

let advertidoSinLlave = false;

/** Llave del servidor para seudonimizar telefonos e IP (`ACTOR_HASH_KEY`). Sin ella se conserva el sha256 anterior (ver abajo). */
function llaveDeSeudonimo(): string | null {
  const key = process.env.ACTOR_HASH_KEY?.trim();
  return key && key.length >= 16 ? key : null;
}

/**
 * Seudonimo de un telefono o de una IP (QA R1 seguridad-08). Con `ACTOR_HASH_KEY` configurada es un HMAC-SHA256: sin la llave del
 * servidor el espacio de telefonos de Mexico (~10^10) no se puede recorrer para revertirlo. Sin la llave (despliegue que aun no la
 * define) se conserva el sha256 plano de antes -- mismos valores que ya hay guardados, nada se rompe -- y se avisa una vez en el log.
 * Cambiar la llave (o definirla por primera vez) cambia los seudonimos: los topes por ventana se reinician y el aviso de privacidad
 * se vuelve a mostrar una vez por titular. Ver docs/CREDENCIALES.md.
 */
export function actorHash(actor: string): string {
  const key = llaveDeSeudonimo();
  if (key) return createHmac("sha256", key).update(actor).digest("hex");
  if (!advertidoSinLlave) {
    advertidoSinLlave = true;
    console.warn("restaurantes: ACTOR_HASH_KEY no esta definida (>= 16 caracteres): los telefonos se seudonimizan con sha256 plano. Defínela (docs/CREDENCIALES.md).");
  }
  return legacyActorHash(actor);
}

/** sha256 plano: el seudonimo que se guardaba antes de `ACTOR_HASH_KEY`. Solo para reconocer filas ya guardadas. */
export function legacyActorHash(actor: string): string {
  return createHash("sha256").update(actor).digest("hex");
}

/** El último salto de X-Forwarded-For evita que un prefijo controlado por el caller
 * fabrique un bucket nuevo por request; cf-connecting-ip (proxy confiable) tiene
 * prioridad cuando está presente. */
export function requestActor(headers: { get(name: string): string | null }, secondary = ""): string {
  const connectingIp = headers.get("cf-connecting-ip")?.trim();
  const forwarded = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return `${connectingIp || forwarded || "unknown"}:${secondary.slice(0, 128)}`;
}

export async function consumeRateLimit(
  repo: RestaurantesRepository,
  scope: string,
  actor: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<{ readonly allowed: boolean }> {
  const allowed = await repo.consumeRateLimit(scope, actorHash(actor), maxRequests, windowSeconds);
  return { allowed };
}
