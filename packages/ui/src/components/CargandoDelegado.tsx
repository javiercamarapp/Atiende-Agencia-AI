import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { CargandoLogo } from "./CargandoLogo";
import { DISENO_DS3 } from "../lib/diseno";
import { useCargaRetenida, type CargaTamano } from "../lib/carga-coordinador";
import { cn } from "../lib/utils";

/**
 * Adaptadores de carga (ds3 / 2.2). Con la bandera APAGADA renderizan EXACTAMENTE lo que renderizaban los consumidores
 * (spinner `Loader2` y contenedor con skeletons); con `?diseno=ds3` delegan en `CargandoLogo`. Son el unico punto
 * (junto con CargandoLogo y Skeleton) que ramifica por la bandera: los consumidores no la leen.
 */

/**
 * Indicador en linea de una accion en curso (botones, confirmaciones, toasts). Apagada: `Loader2` girando si `cargando`,
 * si no `reposo`. Encendida: `CargandoLogo linea` decorativo (el control ya anuncia `aria-busy`); como el componente
 * sigue montado al terminar, respeta la permanencia minima (`useCargaRetenida`).
 */
export function IconoDeCarga({
  cargando,
  reposo = null,
  className,
  strokeWidth,
}: {
  cargando: boolean;
  /** Lo que se pinta cuando no se carga (p. ej. el icono izquierdo del boton). */
  reposo?: ReactNode;
  /** Solo diseno actual: clases del `Loader2` (tamano, color). */
  className?: string;
  strokeWidth?: number;
}) {
  // `DISENO_DS3` es constante de modulo: en una sesion este componente SIEMPRE toma la misma rama, asi que delegar en un
  // subcomponente con hook no cambia el orden de hooks entre renders (reglas de hooks respetadas) y con la bandera apagada
  // no se monta ningun estado ni efecto extra: produccion queda como antes.
  if (DISENO_DS3) return <IconoDeCargaDs3 cargando={cargando} reposo={reposo} />;
  return cargando ? <Loader2 aria-hidden="true" className={cn("animate-spin", className)} strokeWidth={strokeWidth} /> : <>{reposo}</>;
}

/** Rama ds3: sigue montada al terminar, asi que respeta la permanencia minima (`useCargaRetenida`). */
function IconoDeCargaDs3({ cargando, reposo }: { cargando: boolean; reposo: ReactNode }) {
  const retenida = useCargaRetenida(cargando, "linea");
  return retenida ? <CargandoLogo tamano="linea" decorativo /> : <>{reposo}</>;
}

/**
 * Region que carga (`role="status"`). Apagada: el `div` de siempre con sus `children` (esqueletos, texto sr-only) y,
 * opcionalmente, un `Loader2` (`giro`) o el pulso (`pulso`). Encendida: `CargandoLogo` (solo logo, sin texto visible) que
 * conserva la etiqueta ARIA y la altura minima de la region (`claseDs3`) para no mover el layout.
 */
export function RegionCargando({
  etiqueta,
  etiquetaDs3,
  ocupado = false,
  className,
  claseDs3,
  tamano = "panel",
  giro,
  pulso = false,
  children,
}: {
  /** `aria-label` de la region (se conserva en ambos disenos). */
  etiqueta?: string;
  /** Etiqueta del logo cuando la region no lleva `aria-label` (su texto va en un `sr-only` hijo). */
  etiquetaDs3?: string;
  ocupado?: boolean;
  /** Clases del contenedor en el diseno actual. */
  className?: string;
  /** Clases de la region con el logo (min-height, borde...). */
  claseDs3?: string;
  tamano?: CargaTamano;
  /** Diseno actual: clases de un `Loader2` girando dentro de la region. */
  giro?: string;
  /** Diseno actual: pulso del contenedor. */
  pulso?: boolean;
  children?: ReactNode;
}) {
  if (DISENO_DS3) return <CargandoLogo tamano={tamano} etiqueta={etiqueta ?? etiquetaDs3 ?? "Cargando…"} className={claseDs3} />;
  return (
    <div role="status" aria-busy={ocupado ? "true" : undefined} aria-label={etiqueta} className={cn(pulso && "animate-pulse", className)}>
      {giro !== undefined ? <Loader2 className={cn("animate-spin", giro)} aria-hidden="true" /> : null}
      {children}
    </div>
  );
}
