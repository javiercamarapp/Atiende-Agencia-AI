// Barra de acciones pegajosa de los paneles (Likida `dashboard/chat.tsx:916`:
// `sticky bottom-0 shrink-0 pt-3 pb-4` sobre el gris sumido). En movil se eleva sobre la barra
// inferior de 63 px + safe-area (spec §5.3); desde `md` vuelve a `bottom-0`.
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export interface BarraAccionesInferiorProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function BarraAccionesInferior({ children, className }: BarraAccionesInferiorProps) {
  return (
    <div
      data-testid="barra-acciones-inferior"
      className={cn("sticky bottom-[calc(63px+var(--safe-area-bottom))] z-10 shrink-0 bg-sunken pt-3 pb-4 md:bottom-0", className)}
    >
      {children}
    </div>
  );
}
