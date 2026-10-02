// Presets de formato del kit de graficas de la consola (`KpiTile`, `HBars`, `AreaChartSimple`...), el
// equivalente de `admin/ui/formato-preset.ts` de Likida. Un preset de texto en vez de un callback para que
// la pagina que arma la tarjeta solo pase datos; todos formatean con separador de miles `es-MX` y NUNCA
// calculan ni redondean dinero (solo muestran la cifra que el backend ya calculo).
export type FormatoPreset = "numero" | "entero" | "mxn" | "usd" | "porcentaje" | "porcentajeSigno";

function miles(v: number, decimales: 0 | 2): string {
  return v.toLocaleString("es-MX", { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
}

export function resolverFormato(preset: FormatoPreset = "numero"): (v: number) => string {
  switch (preset) {
    case "mxn":
      return (v) => `$${miles(v, 2)}`;
    case "usd":
      return (v) => `US$${miles(v, 2)}`;
    case "porcentaje":
      return (v) => `${Math.round(v)}%`;
    // Con signo explicito en positivos: "+22%" / "-8%", nunca "22%" ambiguo.
    case "porcentajeSigno":
      return (v) => `${v >= 0 ? "+" : ""}${Math.round(v)}%`;
    case "entero":
      return (v) => miles(Math.round(v), 0);
    case "numero":
    default:
      return (v) => v.toLocaleString("es-MX", { maximumFractionDigits: 2 });
  }
}
