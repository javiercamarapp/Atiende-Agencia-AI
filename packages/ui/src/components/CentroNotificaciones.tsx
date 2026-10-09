import * as React from "react";
import { AlertTriangle, Bell, BellOff, CheckCheck, Info, OctagonAlert } from "lucide-react";
import { Link } from "react-router-dom";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Skeleton } from "./ui/skeleton";

export type CentroSeveridad = "info" | "atencion" | "critica";

export interface CentroNotificacionItem {
  readonly id: string;
  readonly titulo: string;
  readonly cuerpo?: string | null;
  /** Texto de tiempo ya formateado ("hace 5 min"): el formato vive en quien conoce la zona/reloj. */
  readonly cuando: string;
  readonly severidad: CentroSeveridad;
  readonly sinLeer: boolean;
  /** Ruta interna a la que lleva la notificacion (ya validada por quien la entrega). */
  readonly enlace?: string | null;
}

export interface CentroNotificacionesProps {
  /** Pagina completa de notificaciones ("Ver todas"). */
  readonly href: string;
  readonly hayNoLeidas: boolean;
  readonly items: readonly CentroNotificacionItem[];
  readonly estado: "cargando" | "error" | "listo";
  /** Se llama al abrir el popover (cargar las recientes). */
  readonly onAbrir?: () => void;
  readonly onReintentar?: () => void;
  readonly onLeer?: (id: string) => void;
  readonly onMarcarTodas?: () => void;
  readonly className?: string;
}

const ICONO = { info: Info, atencion: AlertTriangle, critica: OctagonAlert } as const;
const COLOR = {
  info: "bg-info-tint text-info",
  atencion: "bg-warning-tint text-warning",
  critica: "bg-destructive-tint text-destructive",
} as const;
const ROTULO = { info: "Informativa", atencion: "Requiere atención", critica: "Crítica" } as const;

/**
 * Centro de notificaciones de la campana del encabezado: popover animado con las recientes (no leidas
 * resaltadas con punto), accion "Marcar todas", estado vacio, cargando y error, y enlace a la pagina
 * completa. Mismo material que el resto de ventanas flotantes (Popover). Controlado: no hace fetch.
 */
export function CentroNotificaciones({ href, hayNoLeidas, items, estado, onAbrir, onReintentar, onLeer, onMarcarTodas, className }: CentroNotificacionesProps) {
  const [abierto, setAbierto] = React.useState(false);
  const cambiar = (v: boolean) => {
    setAbierto(v);
    if (v) onAbrir?.();
  };
  return (
    <Popover open={abierto} onOpenChange={cambiar}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={hayNoLeidas ? "Notificaciones: hay avisos sin leer" : "Notificaciones"}
          data-no-leidas={hayNoLeidas ? "true" : "false"}
          className={cn(
            "relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground transition-colors hover:bg-canvas",
            className,
          )}
        >
          <Bell aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          {hayNoLeidas && <span data-testid="campana-punto" aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full bg-destructive" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden p-0" aria-label="Notificaciones">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Notificaciones</h2>
          {hayNoLeidas && onMarcarTodas && (
            <Button type="button" variant="ghost" size="xs" onClick={onMarcarTodas} iconLeft={<CheckCheck aria-hidden="true" />}>
              Marcar todas
            </Button>
          )}
        </div>

        <div className="max-h-[min(24rem,60dvh)] overflow-y-auto">
          {estado === "cargando" && (
            <div role="status" aria-label="Cargando notificaciones" className="grid gap-3 p-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-start gap-3">
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                  <div className="grid flex-1 gap-1.5">
                    <Skeleton className="h-3.5 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {estado === "error" && (
            <div role="alert" className="grid justify-items-center gap-2 px-4 py-8 text-center">
              <OctagonAlert aria-hidden="true" className="size-8 text-destructive" strokeWidth={1.5} />
              <p className="text-ui text-muted-foreground">No se pudieron cargar las notificaciones.</p>
              {onReintentar && (
                <Button type="button" variant="outline" size="xs" onClick={onReintentar}>
                  Volver a intentar
                </Button>
              )}
            </div>
          )}
          {estado === "listo" && items.length === 0 && (
            <div role="status" className="grid justify-items-center gap-2 px-4 py-10 text-center">
              <BellOff aria-hidden="true" className="size-10 text-muted-foreground/30" strokeWidth={1.5} />
              <p className="text-ui text-muted-foreground">Estás al día. No hay notificaciones.</p>
            </div>
          )}
          {estado === "listo" && items.length > 0 && (
            <ul className="divide-y divide-dashed divide-border">
              {items.map((n) => {
                const Icono = ICONO[n.severidad];
                const contenido = (
                  <>
                    <span aria-hidden="true" className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full", COLOR[n.severidad])}>
                      <Icono className="size-4" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 flex-1 text-left">
                      <span className={cn("block text-ui leading-snug", n.sinLeer ? "font-medium text-foreground" : "text-muted-foreground")}>
                        <span className="sr-only">{ROTULO[n.severidad]}. </span>
                        {n.titulo}
                      </span>
                      {n.cuerpo && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{n.cuerpo}</span>}
                      <span className="mt-1 block text-eyebrow text-faint">{n.cuando}</span>
                    </span>
                    {n.sinLeer && <span data-testid="centro-sin-leer" aria-label="Sin leer" role="img" className="mt-2 size-2 shrink-0 rounded-full bg-primary" />}
                  </>
                );
                const clase = "flex w-full items-start gap-3 px-4 py-3 transition-colors duration-fast hover:bg-muted/40 focus-visible:bg-muted/40";
                return (
                  <li key={n.id} data-testid="centro-item">
                    {n.enlace ? (
                      <Link
                        to={n.enlace}
                        className={clase}
                        onClick={() => {
                          if (n.sinLeer) onLeer?.(n.id);
                          setAbierto(false);
                        }}
                      >
                        {contenido}
                      </Link>
                    ) : (
                      <button type="button" className={clase} onClick={() => n.sinLeer && onLeer?.(n.id)}>
                        {contenido}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t border-border bg-muted/30 px-4 py-2.5">
          <Link to={href} onClick={() => setAbierto(false)} className="text-ui font-medium text-primary hover:underline">
            Ver todas las notificaciones
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
