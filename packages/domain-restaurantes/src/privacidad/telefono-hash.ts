// Seudonimos de un mismo telefono en todos los formatos con que cada canal lo guarda (QA R1 seguridad-08/10).
//
// WhatsApp trae el numero como "+521...", la voz como "+52..." (sin el 1) y los pedidos guardan 10 digitos. La voz guarda solo
// `caller_hash` (seudonimo de los digitos del identificador de llamada). Para proteger o suprimir los datos de UN titular en todos
// los canales, la base necesita comparar contra todos esos seudonimos; como la llave del seudonimo vive en el servidor (HMAC), el
// servidor los calcula y se los pasa a las funciones SQL de privacidad. Se incluyen tambien los sha256 planos de antes de la llave,
// porque las filas anteriores a `ACTOR_HASH_KEY` se guardaron asi.
import { actorHash, legacyActorHash } from "../rate-limit.ts";

/** Variantes de digitos de un telefono: completo, 10 nacionales, +52 y +521. Vacio si no hay un minimo de 7 digitos. */
export function variantesDeDigitos(phone: string): string[] {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return [];
  const nacional = digits.slice(-10);
  return [...new Set([digits, nacional, `52${nacional}`, `521${nacional}`])];
}

/** Todos los seudonimos (con llave del servidor y sha256 plano) de las variantes del telefono, sin repetir. */
export function seudonimosDeTelefono(phone: string): string[] {
  const out = new Set<string>();
  for (const d of variantesDeDigitos(phone)) {
    out.add(actorHash(d));
    out.add(legacyActorHash(d));
  }
  return [...out];
}
