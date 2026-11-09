// Reglas condicionales del prompt de voz (dieta del prompt, 7-nov-2026). La instruccion de la llamada lleva solo las reglas que aplican a todo pedido;
// las que solo aplican a un tema (kilos, gringas, combo del martes, rellamada...) llegan aparte en `AperturaLlamada.reglasCondicionales` y la sesion las
// agrega a la conversacion la primera vez que el cliente toca el tema. Un escalon que no sabe hacerlo las recibe TODAS en la instruccion
// (`instruccionConReglasFijas`, lo aplica la escalera), asi que ninguna regla se pierde al caer de escalon.
import type { ReglaCondicional } from "../sesion.ts";

/** Texto del cliente como lo esperan los patrones: sin acentos (NFD sin diacriticos) y en minusculas. */
export function normalizarParaReglas(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Tope del largo de un patron: lo que manda la API se compila en el worker. */
const PATRON_MAX = 400;

function coincide(patron: string, texto: string): boolean {
  if (patron.length === 0 || patron.length > PATRON_MAX) return false;
  try {
    return new RegExp(patron, "i").test(texto);
  } catch {
    return false; // patron invalido: nunca activa (ni tumba el turno)
  }
}

/** Reglas cuyo patron coincide con lo que dijo el cliente y que aun no estan activas (`yaActivas` no se modifica: quien llama las agrega). */
export function reglasActivadas(reglas: readonly ReglaCondicional[] | undefined, textoCliente: string, yaActivas: ReadonlySet<string>): { id: string; texto: string }[] {
  if (!reglas || reglas.length === 0 || textoCliente.trim() === "") return [];
  const t = normalizarParaReglas(textoCliente);
  return reglas.filter((r) => !yaActivas.has(r.id) && coincide(r.patron, t)).map((r) => ({ id: r.id, texto: r.texto }));
}

/** Titulo con el que la sesion presenta las reglas recien activadas al modelo. */
export const TITULO_REGLAS_CONDICIONALES = "# REGLAS QUE APLICAN DESDE AHORA EN ESTA LLAMADA";

/** Instruccion con TODAS las reglas por tema anexadas al final (escalones sin soporte de reglas condicionales). */
export function instruccionConReglasFijas(instruccion: string, reglas: readonly ReglaCondicional[] | undefined): string {
  if (!reglas || reglas.length === 0) return instruccion;
  return `${instruccion}\n\n# REGLAS POR TEMA (aplican cuando el cliente toca el tema)\n${reglas.map((r) => r.texto).join("\n")}`;
}
