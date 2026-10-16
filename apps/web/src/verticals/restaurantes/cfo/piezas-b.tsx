// CFO-08 · piezas compartidas de las pestañas Clientes, Platillos, Patrones, Operación y SoftRestaurant.
import { ClipboardList } from "lucide-react";
import { Button } from "@atiende/ui";
import type { FiltrosCfo } from "./filtros-url.ts";

/** Llave que vuelve a cargar una pestaña cuando cambia el rango, las sucursales o la comparación. */
export const claveCarga = (f: FiltrosCfo): string => `${f.desde}|${f.hasta}|${f.sucursales?.join(",") ?? ""}|${f.comparar}`;

export const DIAS_CORTOS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"] as const;
const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;

/** `2026-09-21` -> «21 sep» (sin `toLocale*`: guard de formato único). */
export function diaCorto(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MESES_CORTOS[Number(m[2]) - 1] ?? m[2]}` : iso;
}

export function BotonPedidos({ etiqueta, onClick, ariaLabel }: { readonly etiqueta: string; readonly onClick: () => void; readonly ariaLabel?: string }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={onClick} aria-label={ariaLabel ?? etiqueta}>
      <ClipboardList className="size-3.5" aria-hidden="true" />
      {etiqueta}
    </Button>
  );
}

/** Intensidad (0..8) de una celda de tabla con relleno de un solo tono: clases fijas de Tailwind (sin `style` inline). */
const RELLENO = ["bg-primary/5", "bg-primary/10", "bg-primary/20", "bg-primary/30", "bg-primary/40", "bg-primary/50", "bg-primary/60", "bg-primary/70", "bg-primary/80"] as const;
export function rellenoCelda(valor: number | null, max: number): { readonly clase: string; readonly fuerte: boolean } {
  if (valor === null || !Number.isFinite(valor) || max <= 0) return { clase: "", fuerte: false };
  const paso = Math.min(RELLENO.length - 1, Math.max(0, Math.round((valor / max) * (RELLENO.length - 1))));
  return { clase: RELLENO[paso]!, fuerte: paso >= 6 };
}
