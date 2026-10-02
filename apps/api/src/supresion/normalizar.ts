// Normalizacion y hash de contactos para la lista de supresion de plataforma (SA-L-46, core.supresion_contacto).
// Un MISMO contacto debe dar el MISMO hash sin importar el formato con que llegue: "+52 55 1234 5678",
// "5512345678", "044 55 1234 5678", "+52 1 55 1234 5678" o "525512345678" -> "+525512345678".
//
// El valor en claro NUNCA sale de este modulo hacia la base ni hacia los logs: solo el hash.
//
// HUECO DECLARADO (ver docs/SUPRESION.md): SHA-256 con prefijo fijo de dominio es invertible por
// enumeracion en telefonos (10 digitos). La mitigacion hoy es de acceso (la tabla no se lee directo);
// la mejora pendiente es un HMAC con llave propia de plataforma (version `v2`).
import { createHash } from "node:crypto";

export type TipoContacto = "telefono" | "correo";

/** Prefijo de separacion de dominio del hash. NO cambiarlo sin migrar la lista (invalida todo lo registrado). */
export const PREFIJO_HASH_SUPRESION = "atiende:supresion:v1:";

/**
 * Telefono -> E.164 con lada MX (+52) por defecto, o `null` si no se puede interpretar.
 *  - Ignora espacios, guiones, puntos y parentesis.
 *  - "00" inicial -> "+"; "044"/"045" (celular local) y "01" (larga distancia) se descartan.
 *  - 10 digitos -> +52 + 10 digitos. "52"/"521" + 10 digitos -> +52 + 10 digitos (el "1" movil historico
 *    de WhatsApp se descarta para que 521... y 52... den el mismo hash).
 *  - Otros paises (con "+" o 11-15 digitos sin patron MX) se conservan tal cual como "+<digitos>".
 */
export function normalizarTelefono(valor: string): string | null {
  if (typeof valor !== "string") return null;
  const limpio = valor.trim().replace(/[\s().-]/gu, "");
  if (limpio === "" || !/^\+?\d+$/u.test(limpio)) return null;
  let digitos = limpio.startsWith("+") ? limpio.slice(1) : limpio;
  const conMas = limpio.startsWith("+");
  if (!conMas) {
    if (digitos.startsWith("00")) digitos = digitos.slice(2);
    else if (/^04[45]\d{10}$/u.test(digitos)) digitos = digitos.slice(3);
    else if (/^01\d{10}$/u.test(digitos)) digitos = digitos.slice(2);
  }
  if (/^\d{10}$/u.test(digitos) && !conMas) return `+52${digitos}`;
  if (/^521\d{10}$/u.test(digitos)) return `+52${digitos.slice(3)}`;
  if (/^52\d{10}$/u.test(digitos)) return `+${digitos}`;
  // Cualquier otro numero internacional: E.164 admite hasta 15 digitos; menos de 8 no es un telefono real.
  if (/^[1-9]\d{7,14}$/u.test(digitos)) return `+${digitos}`;
  return null;
}

/** Correo -> minusculas y sin espacios, o `null` si no tiene forma `x@y` (no valida el dominio a fondo). */
export function normalizarCorreo(valor: string): string | null {
  if (typeof valor !== "string") return null;
  const limpio = valor.replace(/\s+/gu, "").toLowerCase();
  if (limpio.length > 254 || !/^[^@]+@[^@]+$/u.test(limpio)) return null;
  return limpio;
}

export function normalizarContacto(tipo: TipoContacto, valor: string): string | null {
  return tipo === "telefono" ? normalizarTelefono(valor) : normalizarCorreo(valor);
}

/** SHA-256 en hex de `atiende:supresion:v1:<tipo>:<valor normalizado>` (64 caracteres en minuscula). */
export function hashearNormalizado(tipo: TipoContacto, valorNormalizado: string): string {
  return createHash("sha256").update(`${PREFIJO_HASH_SUPRESION}${tipo}:${valorNormalizado}`, "utf8").digest("hex");
}

/** Normaliza y hashea; `null` si el valor no es un contacto interpretable. */
export function hashearContacto(tipo: TipoContacto, valor: string): string | null {
  const normalizado = normalizarContacto(tipo, valor);
  return normalizado === null ? null : hashearNormalizado(tipo, normalizado);
}
