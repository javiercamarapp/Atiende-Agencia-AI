// Bandera visual de Atiende DS v2 (PR-1 del plan de diseño-ux).
//
// Mientras <html> no lleve data-theme="v2", los tokens de index.css reproducen
// el aspecto de producción de siempre. Activarla cambia paleta, tipografía
// (Manrope/Lora autoalojadas), escala de texto y alto de controles de TODA la
// app, así que solo debe encenderse para revisión (parámetro ?ds=v2) hasta
// que las verticales estén migradas; la bandera se retira en PR-12.

export const ATRIBUTO_TEMA = "data-theme";
export const VALOR_TEMA_V2 = "v2";
export const CLAVE_TEMA_V2 = "atiende-ds";

type RaizTema = Pick<HTMLElement, "setAttribute" | "removeAttribute" | "getAttribute">;

export function temaV2Activo(raiz: RaizTema = document.documentElement): boolean {
  return raiz.getAttribute(ATRIBUTO_TEMA) === VALOR_TEMA_V2;
}

export function activarTemaV2(raiz: RaizTema = document.documentElement): void {
  raiz.setAttribute(ATRIBUTO_TEMA, VALOR_TEMA_V2);
}

export function desactivarTemaV2(raiz: RaizTema = document.documentElement): void {
  if (temaV2Activo(raiz)) raiz.removeAttribute(ATRIBUTO_TEMA);
}

/**
 * Decide la bandera al arrancar. `?ds=v2` la enciende y la recuerda en
 * localStorage; `?ds=off` la apaga y olvida. Sin parámetro se respeta lo
 * recordado. Nunca lanza (localStorage puede estar bloqueado).
 */
export function inicializarTemaV2(
  opciones: {
    busqueda?: string;
    almacen?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
    raiz?: RaizTema;
  } = {},
): boolean {
  const busqueda = opciones.busqueda ?? (typeof window === "undefined" ? "" : window.location.search);
  let almacen: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = null;
  try {
    almacen = opciones.almacen === undefined ? (typeof window === "undefined" ? null : window.localStorage) : opciones.almacen;
  } catch {
    almacen = null;
  }
  const raiz = opciones.raiz ?? document.documentElement;
  const pedido = new URLSearchParams(busqueda).get("ds");
  const guardado = (() => {
    try {
      return almacen?.getItem(CLAVE_TEMA_V2) ?? null;
    } catch {
      return null;
    }
  })();
  const activar = pedido === VALOR_TEMA_V2 || (pedido !== "off" && guardado === VALOR_TEMA_V2);
  try {
    if (pedido === VALOR_TEMA_V2) almacen?.setItem(CLAVE_TEMA_V2, VALOR_TEMA_V2);
    else if (pedido === "off") almacen?.removeItem(CLAVE_TEMA_V2);
  } catch {
    // sin persistencia: la bandera solo vale para esta carga
  }
  if (activar) activarTemaV2(raiz);
  else desactivarTemaV2(raiz);
  return activar;
}
