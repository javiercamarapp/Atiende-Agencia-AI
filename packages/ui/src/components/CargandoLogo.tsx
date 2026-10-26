import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { AtiendeMark, AtiendeWordmark } from "./AtiendeLogo";
import { cn } from "../lib/utils";
import { faseCarga, useCargaCoordinada, type CargaTamano } from "../lib/carga-coordinador";

export type CargandoLogoTamano = CargaTamano;

type Props = Omit<HTMLAttributes<HTMLDivElement>, "children" | "role" | "aria-label" | "aria-busy" | "aria-live"> & {
  /** pantalla: marco centrado con wordmark; panel: simbolo 32 en la region; linea: simbolo 16 en linea. */
  tamano?: CargandoLogoTamano;
  /** Texto accesible (aria-label + sr-only). Los consumidores conservan el suyo («Cargando notificaciones»). */
  etiqueta?: string;
};

const CONTENEDOR: Record<CargandoLogoTamano, string> = {
  pantalla: "flex w-full min-h-[min(60dvh,520px)] items-center justify-center",
  panel: "flex w-full items-center justify-center",
  linea: "inline-flex items-center justify-center",
};

/**
 * Estado de carga unico (ds3): SOLO el logo de Atiende que respira, sin texto visible. El coordinador garantiza un
 * unico dibujo visible a la vez; las demas instancias siguen siendo role=status con su texto sr-only. La region
 * conserva el `min-height` que le ponga quien llama (via `className`), asi no hay salto de layout.
 */
export function CargandoLogo({ tamano = "panel", etiqueta = "Cargando…", className, ...resto }: Props) {
  const { visible } = useCargaCoordinada(tamano);
  const dibujo = useRef<HTMLSpanElement>(null);

  // Fase global: un logo remontado continua la respiracion en vez de reiniciarla.
  useLayoutEffect(() => {
    if (visible) dibujo.current?.style.setProperty("--carga-fase", faseCarga());
  }, [visible]);

  return (
    <div
      {...resto}
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label={etiqueta}
      data-carga-tamano={tamano}
      data-carga-visible={visible ? "true" : "false"}
      className={cn(CONTENEDOR[tamano], className)}
    >
      <span className="sr-only">{etiqueta}</span>
      <span ref={dibujo} aria-hidden="true" className={cn("carga-logo inline-flex", !visible && "invisible")}>
        {tamano === "pantalla" ? (
          <AtiendeWordmark />
        ) : (
          <AtiendeMark className={tamano === "panel" ? "h-8 w-auto" : "h-4 w-auto"} />
        )}
      </span>
    </div>
  );
}
