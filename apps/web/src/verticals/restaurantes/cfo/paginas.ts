// CFO-07 · registro de las pestañas del CFO: `{ slug, etiqueta, icono, componente perezoso }`. `CfoLayout` arma las pestañas, la ruta y la
// exportación a partir de esta lista. PUNTO DE CONTACTO con CFO-08: sus pestañas (Clientes, Platillos, Patrones, Operación y SoftRestaurant) se agregan
// aquí al final, con su propio componente perezoso y su `vistaExportacion`; no hay que tocar `CfoLayout`.
import { lazy } from "react";
import type { ComponentType, LazyExoticComponent } from "react";
import { LayoutDashboard, Receipt, ShoppingBag, Store } from "lucide-react";
import type { VistaExportacionCfo } from "@atiende/domain-restaurantes/cfo";
import type { CfoPaginaProps } from "./contexto.ts";

type Icono = ComponentType<{ className?: string; strokeWidth?: number | string; "aria-hidden"?: boolean | "true" | "false" }>;

export interface PaginaCfo {
  /** Segmento de la URL: `/restaurantes/:orgSlug/cfo/:slug`. */
  readonly slug: string;
  readonly etiqueta: string;
  readonly icono: Icono;
  readonly componente: LazyExoticComponent<ComponentType<CfoPaginaProps>>;
  /** Vista que se pide a `/exportar` (CFO-06). null = esta pestaña no exporta y el botón se oculta. */
  readonly vistaExportacion: VistaExportacionCfo | null;
}

export const PAGINAS_CFO: readonly PaginaCfo[] = [
  { slug: "resumen", etiqueta: "Resumen", icono: LayoutDashboard, componente: lazy(() => import("./CfoResumen.tsx").then((m) => ({ default: m.CfoResumen }))), vistaExportacion: "resumen" },
  { slug: "ventas", etiqueta: "Ventas", icono: ShoppingBag, componente: lazy(() => import("./CfoVentas.tsx").then((m) => ({ default: m.CfoVentas }))), vistaExportacion: "ventas" },
  { slug: "sucursales", etiqueta: "Sucursales", icono: Store, componente: lazy(() => import("./CfoSucursales.tsx").then((m) => ({ default: m.CfoSucursales }))), vistaExportacion: "sucursales" },
  { slug: "estado-resultados", etiqueta: "Estado de resultados", icono: Receipt, componente: lazy(() => import("./CfoEstadoResultados.tsx").then((m) => ({ default: m.CfoEstadoResultados }))), vistaExportacion: "estado_resultados" },
];

export const SLUG_INICIAL_CFO = "resumen";
