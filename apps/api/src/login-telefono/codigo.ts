// Primitivas criptograficas del login del repartidor por WhatsApp (docs/LOGIN-CHOFER-WHATSAPP.md). Todo puro y determinista dado el secreto
// y la entropia inyectada, para probarlo sin red ni reloj.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const CODIGO_DIGITOS = 6;
export const CODIGO_TTL_SEGUNDOS = 300;
export const CODIGO_MAX_INTENTOS = 5;

/** Codigo de 6 digitos con ceros a la izquierda, uniforme (sin sesgo de modulo) y de fuente criptografica. */
export function generarCodigo(aleatorio: (maxExclusivo: number) => number = (n) => randomInt(0, n)): string {
  return String(aleatorio(10 ** CODIGO_DIGITOS)).padStart(CODIGO_DIGITOS, "0");
}

/** Sal de 16 bytes en hex (32 caracteres). */
export function generarSal(bytes: (n: number) => Buffer = randomBytes): string {
  return bytes(16).toString("hex");
}

/** Llave de servidor DERIVADA del secreto JWT con separacion de dominio: no se reutiliza el secreto tal cual para otro proposito. */
export function derivarLlave(secreto: string): Buffer {
  return createHmac("sha256", secreto).update("atiende:login-chofer:v1").digest();
}

/** HMAC-SHA256 hex del codigo con su sal. Es lo UNICO que se guarda del codigo. */
export function hashCodigo(llave: Buffer, sal: string, codigo: string): string {
  return createHmac("sha256", llave).update(`${sal}:${codigo}`).digest("hex");
}

/** Pseudonimo irreversible (sin la llave) de un dato personal para auditoria y limites: telefono o IP. */
export function pseudonimo(llave: Buffer, ambito: "tel" | "ip", valor: string): string {
  return createHmac("sha256", llave).update(`${ambito}:${valor}`).digest("hex");
}

/** Comparacion en tiempo constante de dos hex de igual longitud; longitudes distintas -> false sin filtrar tiempo util. */
export function iguales(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** El codigo tecleado: exactamente 6 digitos (se ignoran espacios intermedios que mete el teclado, p. ej. "123 456"). */
export function normalizarCodigoIngresado(entrada: unknown): string | null {
  if (typeof entrada !== "string" || entrada.length > 16) return null;
  const limpio = entrada.replace(/\s+/g, "");
  return /^\d{6}$/.test(limpio) ? limpio : null;
}
