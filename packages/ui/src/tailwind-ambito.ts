/**
 * Plugin de Tailwind con la variante `rest:` = "solo dentro del ambito restaurantes y fuera del sidebar" (UNI-R0b).
 * `useAmbitoVertical("restaurantes")` pone data-ambito="restaurantes" en <html>; el <aside> del Sidebar (y el portal de su selector de sucursal)
 * llevan data-ambito-base y quedan fuera. Todo va en `:where()`: especificidad 0, asi `rest:` no pisa a hover:/focus:/aria-* ni a las clases
 * que pase quien llama. Se registra en el tailwind.config de la app (no en el preset, cuyo contrato de plugins es uno solo: ver tokens-likida.spec.ts).
 * Objeto con `handler` (forma admitida por Tailwind) para no depender del modulo `tailwindcss/plugin` (sin tipos en el tsconfig raiz).
 */
export const VARIANTE_REST = ':where(html[data-ambito="restaurantes"]) &:where(:not([data-ambito-base], [data-ambito-base] *))';

const ambito = {
  handler: ({ addVariant }: { addVariant: (nombre: string, definicion: string) => void }): void => {
    addVariant("rest", VARIANTE_REST);
  },
};

export default ambito;
