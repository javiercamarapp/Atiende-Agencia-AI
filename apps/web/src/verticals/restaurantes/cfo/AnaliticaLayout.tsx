// Analítica del dueño (F7) · marco de `/restaurantes/:orgSlug/analitica/*`. Reutiliza el marco del CFO (filtros en la URL, alcance, fail-closed sin `cfo.ver`) con su propio
// registro de pestañas: demanda, zonas, productos y combos, ratios. Es un registro aparte para no alterar las pestañas del CFO.
import { lazy } from "react";
import { Boxes, CalendarClock, Gauge, MapPinned } from "lucide-react";
import { CfoLayout, type CfoLayoutProps, type MarcoLayout } from "./CfoLayout.tsx";
import type { PaginaCfo } from "./paginas.ts";

export const PAGINAS_ANALITICA: readonly PaginaCfo[] = [
  { slug: "demanda", etiqueta: "Demanda", icono: CalendarClock, componente: lazy(() => import("./CfoDemanda.tsx").then((m) => ({ default: m.CfoDemanda }))), vistaExportacion: null },
  { slug: "zonas", etiqueta: "Zonas", icono: MapPinned, componente: lazy(() => import("./CfoZonas.tsx").then((m) => ({ default: m.CfoZonas }))), vistaExportacion: null },
  { slug: "combos", etiqueta: "Productos y combos", icono: Boxes, componente: lazy(() => import("./CfoCombos.tsx").then((m) => ({ default: m.CfoCombos }))), vistaExportacion: null },
  { slug: "ratios", etiqueta: "Ratios", icono: Gauge, componente: lazy(() => import("./CfoRatios.tsx").then((m) => ({ default: m.CfoRatios }))), vistaExportacion: null },
];

export const MARCO_ANALITICA: MarcoLayout = {
  paginas: PAGINAS_ANALITICA,
  slugInicial: "demanda",
  ruta: "analitica",
  titulo: "Analítica",
  descripcion: "Cuándo y dónde vendes, qué se pide junto y los ratios de tu restaurante, con la definición exacta de cada cifra.",
  etiquetaNav: "Secciones de la analítica",
};

export function AnaliticaLayout(props: Omit<CfoLayoutProps, "marco">) {
  return <CfoLayout {...props} marco={MARCO_ANALITICA} />;
}
