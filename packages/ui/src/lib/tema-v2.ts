// Bandera visual de Atiende DS v2 (PR-1 del plan de diseño-ux).
//
// Mientras <html> no lleve data-theme="v2", los tokens de index.css reproducen
// el aspecto de producción de siempre. Activarla cambia paleta, tipografía
// (Manrope/Lora autoalojadas), escala de texto y alto de controles de TODA la
// app, así que solo debe encenderse para revisión (parámetro ?ds=v2) hasta
// que las verticales estén migradas; la bandera se retira en PR-12.
//
// Sin referencias a tipos DOM globales a propósito: el typecheck de la raíz
// compila este archivo junto a apps/api (tipos de Node) y un `lib: dom` global
// choca con ellos. Las dependencias del navegador se piden por interfaz mínima.

export const ATRIBUTO_TEMA = "data-theme";
export const VALOR_TEMA_V2 = "v2";
export const CLAVE_TEMA_V2 = "atiende-ds";

export interface RaizTema {
  setAttribute(nombre: string, valor: string): void;
  removeAttribute(nombre: string): void;
  getAttribute(nombre: string): string | null;
}
export type AlmacenTema = {
  getItem(clave: string): string | null;
  setItem(clave: string, valor: string): void;
  removeItem(clave: string): void;
};

interface EntornoNavegador {
  document?: { documentElement: RaizTema };
  location?: { search: string };
  localStorage?: AlmacenTema;
}

function entorno(): EntornoNavegador {
  return globalThis as unknown as EntornoNavegador;
}

function raizPorDefecto(): RaizTema | null {
  return entorno().document?.documentElement ?? null;
}

export function temaV2Activo(raiz: RaizTema | null = raizPorDefecto()): boolean {
  return raiz?.getAttribute(ATRIBUTO_TEMA) === VALOR_TEMA_V2;
}

export function activarTemaV2(raiz: RaizTema | null = raizPorDefecto()): void {
  raiz?.setAttribute(ATRIBUTO_TEMA, VALOR_TEMA_V2);
}

export function desactivarTemaV2(raiz: RaizTema | null = raizPorDefecto()): void {
  if (raiz && temaV2Activo(raiz)) raiz.removeAttribute(ATRIBUTO_TEMA);
}

function almacenPorDefecto(): AlmacenTema | null {
  try {
    return entorno().localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Decide la bandera al arrancar. `?ds=v2` la enciende y la recuerda en
 * localStorage; `?ds=off` la apaga y olvida. Sin parámetro se respeta lo
 * recordado. Nunca lanza (localStorage puede estar bloqueado) y fuera del
 * navegador (sin document) no hace nada.
 */
export function inicializarTemaV2(
  opciones: {
    busqueda?: string;
    almacen?: AlmacenTema | null;
    raiz?: RaizTema | null;
  } = {},
): boolean {
  const busqueda = opciones.busqueda ?? entorno().location?.search ?? "";
  const almacen = opciones.almacen === undefined ? almacenPorDefecto() : opciones.almacen;
  const raiz = opciones.raiz === undefined ? raizPorDefecto() : opciones.raiz;
  const pedido = new URLSearchParams(busqueda).get("ds");
  let guardado: string | null = null;
  try {
    guardado = almacen?.getItem(CLAVE_TEMA_V2) ?? null;
  } catch {
    guardado = null;
  }
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
