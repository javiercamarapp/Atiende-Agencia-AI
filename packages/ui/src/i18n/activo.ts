import { LOCALE_POR_IDIOMA, type Idioma } from "./tipos.ts";

/**
 * Idioma EFECTIVO de la consola fuera de React, para los formateadores sin hook (`formatMoney`, `resolverFormato`, `<Cifra>`,
 * `lib/formato-fecha` de apps/web): asi el dinero, los numeros y las fechas siguen al idioma del marco y no quedan fijos en es-MX
 * con la interfaz en ingles. Lo fija `IdiomaProvider` en cada render (antes de pintar a sus hijos); sin proveedor (pruebas, codigo
 * sin React) vale "es", que da exactamente el formato de siempre.
 */
let actual: Idioma = "es";

export function idiomaActivo(): Idioma {
  return actual;
}

/** "es-MX" / "en-US". */
export function localeActivo(): string {
  return LOCALE_POR_IDIOMA[actual];
}

export function fijarIdiomaActivo(idioma: Idioma): void {
  actual = idioma;
}
