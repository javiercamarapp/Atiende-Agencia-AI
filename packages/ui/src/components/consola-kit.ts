// Kit visual de la consola (SA-L-03): graficas y tarjetas portadas de Likida. Barril propio para que `index.ts` sume
// una sola linea y los lotes paralelos no choquen ahi. El odometro (`Odometro`), el rotulo mono (`SectionLabel`) y la
// pildora "Ver ->" (`PillLink`) ya viven en `resumen-piezas.ts`.
export * from "./graficas.js";
export * from "./KpiTile.js";
export * from "./ChartCard.js";
export * from "./GlobalFilter.js";
export { resolverFormato, type FormatoPreset } from "../lib/formato-preset.js";
