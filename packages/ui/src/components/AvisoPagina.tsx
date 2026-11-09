// Ranura de avisos de pagina (auditoria R2 #5): los banners globales del panel (p. ej. «agregados por validar» de restaurantes) van
// DEBAJO del encabezado de la pantalla (antetitulo + H1 + descripcion juntos), como en Rovaq, y no entre el antetitulo y el contenido.
//
// Quien pinta el aviso lo envuelve en `AvisoPagina`: su estado y sus sondeos siguen montados donde se declara (el shell de la vertical) y
// solo el marcado viaja por portal a la ranura. La ranura la pone el `PageHeader` o el `ResumenLayout` de la pantalla justo despues de su
// encabezado; si la pantalla no trae uno, el `VerticalShell` la pone despues de su propio encabezado de respaldo.
import * as React from "react";
import { createPortal } from "react-dom";

interface RanuraAvisos {
  /** Nodo donde se pintan los avisos ahora mismo (ranura de la pagina si existe; si no, la del shell). */
  readonly destino: HTMLElement | null;
  /** Una pagina ofrece su ranura; devuelve la funcion que la retira. Gana la primera que se registra. */
  readonly registrar: (el: HTMLElement) => () => void;
}

const RanuraAvisosContext = React.createContext<RanuraAvisos | null>(null);

/** Estado de la ranura para el `VerticalShell`: devuelve el contexto y el `ref` de su ranura de respaldo. */
export function useRanuraAvisosShell(): { readonly valor: RanuraAvisos; readonly refShell: (el: HTMLElement | null) => void } {
  const [ranuraShell, fijarRanuraShell] = React.useState<HTMLElement | null>(null);
  const [ranuraPagina, fijarRanuraPagina] = React.useState<HTMLElement | null>(null);
  const registrar = React.useCallback((el: HTMLElement) => {
    fijarRanuraPagina((actual) => actual ?? el);
    return () => fijarRanuraPagina((actual) => (actual === el ? null : actual));
  }, []);
  const valor = React.useMemo<RanuraAvisos>(() => ({ destino: ranuraPagina ?? ranuraShell, registrar }), [ranuraPagina, ranuraShell, registrar]);
  return { valor, refShell: fijarRanuraShell };
}

export const RanuraAvisosProvider = RanuraAvisosContext.Provider;

/** Ranura que una pantalla pone despues de su encabezado (la usan `PageHeader` y `ResumenLayout`). Fuera de un shell no pinta nada. */
export function RanuraAvisosPagina() {
  const ctx = React.useContext(RanuraAvisosContext);
  const ref = React.useRef<HTMLDivElement>(null);
  const registrar = ctx?.registrar;
  React.useLayoutEffect(() => {
    if (!registrar || !ref.current) return undefined;
    return registrar(ref.current);
  }, [registrar]);
  if (!ctx) return null;
  return <div ref={ref} data-testid="ranura-avisos-pagina" className="ds3-ranura-avisos" />;
}

/** Aviso global de la pantalla: se pinta en la ranura vigente (debajo del encabezado). Fuera de un shell se pinta en su lugar. */
export function AvisoPagina({ children }: { readonly children: React.ReactNode }) {
  const ctx = React.useContext(RanuraAvisosContext);
  if (!ctx) return <>{children}</>;
  if (!ctx.destino) return null;
  return createPortal(children, ctx.destino);
}
