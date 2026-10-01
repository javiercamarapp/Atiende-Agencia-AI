import { AtiendeMark } from "./AtiendeLogo";
import { Skeleton } from "./ui/skeleton";
import { cn } from "../lib/utils";

export type EstadoCargandoVariante = "bloque" | "pantalla" | "tabla" | "tarjeta";

/**
 * Estado de carga con skeleton y role="status"/aria-busy (REQ-UX-002/003).
 * Variantes de DS v2 (4.4/4.5): `bloque` (por defecto, el de siempre),
 * `tabla` (cabecera + `filas`), `tarjeta` y `pantalla` (glifo que respira,
 * para el arranque de Shell/login). Nunca un texto suelto "Cargando...".
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
      <div role="status" aria-busy="true" aria-label={etiqueta} className={cn("flex min-h-[60vh] flex-col items-center justify-center gap-3", className)}>
        <span aria-hidden="true" className="atiende-respira">
          <AtiendeMark animado className="h-10 w-auto" />
        </span>
        <span className="text-sm text-muted-foreground">{etiqueta}</span>
      </div>
    );
  }

  if (variante === "tabla") {
    return (
      <div role="status" aria-busy="true" aria-label={etiqueta} className={cn("space-y-2", className)}>
        <span className="sr-only">{etiqueta}</span>
        <Skeleton className="h-9 w-full rounded-md" />
        {Array.from({ length: filas }).map((_, i) => (
          <div key={i} className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3">
            <Skeleton className="h-5 rounded" />
            <Skeleton className="h-5 rounded" />
            <Skeleton className="h-5 rounded" />
            <Skeleton className="h-5 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (variante === "tarjeta") {
    return (
      <div role="status" aria-busy="true" aria-label={etiqueta} className={cn("space-y-3 rounded-card border border-border bg-card p-4", className)}>
        <span className="sr-only">{etiqueta}</span>
        <Skeleton className="h-5 w-1/3 rounded" />
        {Array.from({ length: lineas }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full rounded" style={{ maxWidth: `${92 - i * 12}%` }} />
        ))}
      </div>
    );
  }

  return (
    <div role="status" aria-busy="true" aria-label={etiqueta} className={cn("space-y-3", className)}>
      <span className="sr-only">{etiqueta}</span>
      <Skeleton className="h-24 w-full rounded-xl" />
      {Array.from({ length: lineas }).map((_, i) => (
        <Skeleton key={i} className="h-4 w-full rounded" style={{ maxWidth: `${92 - i * 12}%` }} />
      ))}
    </div>
  );
}
