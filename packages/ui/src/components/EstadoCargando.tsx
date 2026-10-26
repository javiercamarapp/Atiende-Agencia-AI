import { AtiendeMark } from "./AtiendeLogo";
import { RegionCargando } from "./CargandoDelegado";
import { Skeleton } from "./ui/skeleton";
import { cn } from "../lib/utils";

export type EstadoCargandoVariante = "bloque" | "pantalla" | "tabla" | "tarjeta";

/**
 * Estado de carga con skeleton y role="status"/aria-busy (REQ-UX-002/003),
 * identico al `EstadoCargando` de Likida (kit.tsx; spec UNI-3c 6.5): `space-y-2`
 * de filas `skeleton rounded-md` de 14 px de alto, la ultima al 60 %. Variantes:
 * `bloque` (por defecto), `tabla` (cabecera + `filas`), `tarjeta` y `pantalla`
 * (glifo que respira, para el arranque de Shell/login). Nunca un texto suelto
 * "Cargando...".
 *
 * ds3 (`?diseno=ds3`): SOLO el logo (`CargandoLogo`), sin esqueleto ni texto visible; misma etiqueta ARIA. `pantalla`
 * usa el logo de pantalla; el resto, el de panel con la altura minima de la region (bloque 96, tarjeta 160, tabla 240).
 */
export function EstadoCargando({
  lineas = 3,
  etiqueta = "Cargando…",
  variante = "bloque",
  filas = 5,
  className,
}: {
  lineas?: number;
  etiqueta?: string;
  variante?: EstadoCargandoVariante;
  /** Solo `tabla`: número de filas de esqueleto. */
  filas?: number;
  className?: string;
}) {
  if (variante === "pantalla") {
    return (
      <RegionCargando
        tamano="pantalla"
        ocupado
        etiqueta={etiqueta}
        className={cn("flex min-h-[60vh] flex-col items-center justify-center gap-3", className)}
        claseDs3={className}
      >
        <span aria-hidden="true" className="atiende-respira">
          <AtiendeMark animado className="h-10 w-auto" />
        </span>
        <span className="text-ui text-muted-foreground">{etiqueta}</span>
      </RegionCargando>
    );
  }

  if (variante === "tabla") {
    return (
      <RegionCargando ocupado etiqueta={etiqueta} className={cn("space-y-2", className)} claseDs3={cn("min-h-60", className)}>
        <span className="sr-only">{etiqueta}</span>
        <Skeleton className="h-7 w-full" />
        {Array.from({ length: filas }).map((_, i) => (
          <div key={i} className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3">
            <Skeleton className="h-3.5" />
            <Skeleton className="h-3.5" />
            <Skeleton className="h-3.5" />
            <Skeleton className="h-3.5" />
          </div>
        ))}
      </RegionCargando>
    );
  }

  if (variante === "tarjeta") {
    return (
      <RegionCargando
        ocupado
        etiqueta={etiqueta}
        className={cn("card space-y-2 rounded-lg border border-border bg-card p-4 shadow-card", className)}
        claseDs3={cn("min-h-40 rounded-lg border border-border bg-card", className)}
      >
        <span className="sr-only">{etiqueta}</span>
        <Skeleton className="h-3.5 w-1/3" />
        {Array.from({ length: lineas }).map((_, i) => (
          <Skeleton key={i} className={cn("h-3.5", i === lineas - 1 ? "w-3/5" : "w-full")} />
        ))}
      </RegionCargando>
    );
  }

  return (
    <RegionCargando ocupado etiqueta={etiqueta} className={cn("space-y-2", className)} claseDs3={cn("min-h-24", className)}>
      <span className="sr-only">{etiqueta}</span>
      {Array.from({ length: lineas }).map((_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i === lineas - 1 ? "w-3/5" : "w-full")} />
      ))}
    </RegionCargando>
  );
}
