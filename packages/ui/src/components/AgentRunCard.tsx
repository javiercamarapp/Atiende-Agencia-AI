// Ficha de la ultima corrida de un agente (seccion "Ultima corrida" de Likida,
// admin/consola.tsx:334-348): nombre de 13 px, `StatusBadge` a la derecha, linea de meta de 12 px y,
// si hay ficha, "— ver ficha". Sin corrida registrada dice "Sin corridas registradas." en vez de
// inventar un estado.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import { StatusBadge, type StatusTone } from "./ui/status-badge";

export interface AgentRunEstado {
  readonly tone: StatusTone;
  readonly etiqueta: string;
}

export interface AgentRunCardProps {
  readonly nombre: string;
  /** Estado de la ultima corrida. Omitido junto con `meta` = el agente no tiene corridas. */
  readonly estado?: AgentRunEstado;
  /** Linea de detalle ya formateada por la pagina (cuando, disparo, tareas...). */
  readonly meta?: ReactNode;
  /** Ruta de react-router de la ficha del agente. */
  readonly href?: string;
  readonly className?: string;
}

export function AgentRunCard({ nombre, estado, meta, href, className }: AgentRunCardProps) {
  const conCorrida = estado !== undefined || (meta !== undefined && meta !== null && meta !== "");
  return (
    <div className={cn("rounded-lg border border-border bg-card px-3 py-2.5", className)}>
      <div className="flex items-center gap-2">
        <span className="truncate text-ui font-medium text-foreground">{nombre}</span>
        {estado && (
          <StatusBadge tone={estado.tone} className="ml-auto">
            {estado.etiqueta}
          </StatusBadge>
        )}
      </div>
      {conCorrida ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {meta}
          {href && (
            <>
              {" — "}
              <Link to={href} className="font-medium underline">
                ver ficha
              </Link>
            </>
          )}
        </p>
      ) : (
        <p className="mt-1 text-xs text-faint">Sin corridas registradas.</p>
      )}
    </div>
  );
}
