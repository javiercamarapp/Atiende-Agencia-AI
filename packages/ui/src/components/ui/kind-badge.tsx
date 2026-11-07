import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Procedencia de un dato (ds3 §3.4): Real, Estimado, Inferido o Por validar. El patron (punto solido / borde discontinuo /
 * borde punteado / signo ?) acompana SIEMPRE al texto: el significado nunca depende solo del color. Usar solo donde el dato
 * ya trae la distincion (no inventar una procedencia).
 */
export const KIND_TIPOS = ["real", "estimado", "inferido", "por-validar"] as const;
export type KindTipo = (typeof KIND_TIPOS)[number];

export const KIND_ETIQUETAS: Readonly<Record<KindTipo, string>> = {
  real: "Real",
  estimado: "Estimado",
  inferido: "Inferido",
  "por-validar": "Por validar",
};

export interface KindBadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "color"> {
  kind: KindTipo;
}

export function KindBadge({ kind, className, children, ...props }: KindBadgeProps) {
  return (
    <span
      data-kind={kind}
      className={cn(
        "ds3-status ds3-kind inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground",
        kind === "estimado" && "ds3-kind-estimado border-dashed",
        kind === "inferido" && "ds3-kind-inferido border-dotted",
        className,
      )}
      {...props}
    >
      {kind === "real" && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />}
      {kind === "por-validar" && (
        <span aria-hidden="true" className="shrink-0 font-semibold leading-none">
          ?
        </span>
      )}
      {children ?? KIND_ETIQUETAS[kind]}
    </span>
  );
}
