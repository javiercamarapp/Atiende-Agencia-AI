import * as React from "react";

/**
 * Ambito visual de una vertical (UNI-R0b). Pone `data-ambito="<vertical>"` en <html> mientras el componente esta montado:
 * asi lo heredan tambien los portales de Radix (modales, menus, listas, toasts), que se pintan en <body>, fuera del shell.
 * index.css y la variante `rest:` del preset de Tailwind reaccionan SOLO a "restaurantes"; las demas verticales no llaman
 * a este hook y su aspecto no cambia. Al desmontar se quita (si no lo cambio otra vertical entretanto).
 */
export const ATRIBUTO_AMBITO = "data-ambito";

export function useAmbitoVertical(vertical: string): void {
  React.useLayoutEffect(() => {
    if (typeof document === "undefined") return undefined;
    const raiz = document.documentElement;
    const previo = raiz.getAttribute(ATRIBUTO_AMBITO);
    raiz.setAttribute(ATRIBUTO_AMBITO, vertical);
    return () => {
      if (raiz.getAttribute(ATRIBUTO_AMBITO) === vertical) {
        if (previo === null) raiz.removeAttribute(ATRIBUTO_AMBITO);
        else raiz.setAttribute(ATRIBUTO_AMBITO, previo);
      }
    };
  }, [vertical]);
}
