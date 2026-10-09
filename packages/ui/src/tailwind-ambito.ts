import plugin from "tailwindcss/plugin";

/**
 * Plugin de Tailwind con la variante `rest:` = "solo dentro del ambito restaurantes" (UNI-R0b).
 * `useAmbitoVertical("restaurantes")` pone data-ambito="restaurantes" en <html>; `:where()` deja la especificidad en 0, asi
 * `rest:` no pisa a hover:/focus:/aria-* ni a las clases que pase quien llama. Se registra en el tailwind.config de la app
 * (no en el preset, cuyo contrato de plugins es uno solo: ver tokens-likida.spec.ts).
 */
export const VARIANTE_REST = ':where(html[data-ambito="restaurantes"]) &';

export default plugin(({ addVariant }) => {
  addVariant("rest", VARIANTE_REST);
});
