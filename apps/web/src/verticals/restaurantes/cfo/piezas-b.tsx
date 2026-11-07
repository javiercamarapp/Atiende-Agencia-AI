// CFO-08 · piezas compartidas de las pestañas Clientes, Platillos, Patrones, Operación y SoftRestaurant.
import { ClipboardList } from "lucide-react";
import { Button, idiomaActivo, traductorActivo } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesCfo } from "@atiende/ui/i18n/restaurantes/cfo";
import type { FiltrosCfo } from "./filtros-url.ts";

/** Llave que vuelve a cargar una pestaña cuando cambia el rango, las sucursales o la comparación. */
export const claveCarga = (f: FiltrosCfo): string => `${f.desde}|${f.hasta}|${f.sucursales?.join(",") ?? ""}|${f.comparar}`;

const tr = traductorActivo(restaurantesCfo);
const CLAVES_DIA_CORTO: readonly Clave[] = ["restaurantes.cfo.diaCorto.1", "restaurantes.cfo.diaCorto.2", "restaurantes.cfo.diaCorto.3", "restaurantes.cfo.diaCorto.4", "restaurantes.cfo.diaCorto.5", "restaurantes.cfo.diaCorto.6", "restaurantes.cfo.diaCorto.7"];
/** «Lun»…«Dom» (lunes primero), en el idioma activo: cada lectura traduce. */
export const DIAS_CORTOS: readonly string[] = Object.freeze(
  CLAVES_DIA_CORTO.reduce<string[]>((dias, clave, i) => Object.defineProperty(dias, i, { enumerable: true, get: () => tr(clave) }), new Array<string>(CLAVES_DIA_CORTO.length)),
);
const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;
const MESES_CORTOS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `2026-09-21` -> «21 sep» («Sep 21» en ingles; sin `toLocale*`: guard de formato único). */
export function diaCorto(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m && idiomaActivo() === "en") return `${MESES_CORTOS_EN[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
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
