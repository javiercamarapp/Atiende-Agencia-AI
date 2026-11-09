// Presets de formato del kit de graficas de la consola (`KpiTile`, `HBars`, `AreaChartSimple`...), el
// equivalente de `admin/ui/formato-preset.ts` de Likida. Un preset de texto en vez de un callback para que
// la pagina que arma la tarjeta solo pase datos; todos formatean con separador de miles `es-MX` y NUNCA
// calculan ni redondean dinero (solo muestran la cifra que el backend ya calculo).
import { idiomaActivo } from "../i18n/activo.ts";
import { crearFormatos } from "../i18n/formato.ts";

export type FormatoPreset = "numero" | "entero" | "mxn" | "usd" | "usd4" | "porcentaje" | "porcentajeSigno";

/**
 * Miles con decimales fijos: el formateador numerico canonico (lo reutilizan los presets y <Cifra>, lib/cifra.ts). Delega en
 * `crearFormatos(idiomaActivo())` (i18n, P2-4): es-MX en espanol -- byte a byte lo de siempre -- y en-US con la consola en ingles.
 */
export function numeroEsMx(v: number, decimales: number): string {
  return crearFormatos(idiomaActivo()).numero(v, { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
}

function miles(v: number, decimales: 0 | 2 | 4): string {
  return numeroEsMx(v, decimales);
}

export function resolverFormato(preset: FormatoPreset = "numero"): (v: number) => string {
  switch (preset) {
    case "mxn":
      return (v) => `$${miles(v, 2)}`;
    case "usd":
      return (v) => `US$${miles(v, 2)}`;
    // Costos unitarios (US$0.0042 por operacion): con 2 decimales un costo por operacion se veria como US$0.00.
    case "usd4":
      return (v) => `US$${miles(v, 4)}`;
    case "porcentaje":
      return (v) => `${Math.round(v)}%`;
    // Con signo explicito en positivos: "+22%" / "-8%", nunca "22%" ambiguo.
    case "porcentajeSigno":
      return (v) => `${v >= 0 ? "+" : ""}${Math.round(v)}%`;
    case "entero":
      return (v) => miles(Math.round(v), 0);
    case "numero":
    default:
      return (v) => crearFormatos(idiomaActivo()).numero(v, { maximumFractionDigits: 2 });
  }
}
