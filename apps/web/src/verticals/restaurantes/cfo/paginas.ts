// CFO-07 · registro de las pestañas del CFO: `{ slug, etiqueta, icono, componente perezoso }`. `CfoLayout` arma las pestañas, la ruta y la
// exportación a partir de esta lista. PUNTO DE CONTACTO con CFO-08: sus pestañas (Clientes, Platillos, Patrones, Operación y SoftRestaurant) van
// al final, cada una con su propio componente perezoso y su `vistaExportacion`; no hay que tocar `CfoLayout`.
import { lazy } from "react";
import type { ComponentType, LazyExoticComponent } from "react";
import { CalendarRange, LayoutDashboard, Monitor, Receipt, ShoppingBag, Store, Truck, UtensilsCrossed, Users } from "lucide-react";
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
  { slug: "clientes", etiqueta: "Clientes", icono: Users, componente: lazy(() => import("./CfoClientes.tsx").then((m) => ({ default: m.CfoClientes }))), vistaExportacion: "clientes" },
  { slug: "platillos", etiqueta: "Platillos", icono: UtensilsCrossed, componente: lazy(() => import("./CfoPlatillos.tsx").then((m) => ({ default: m.CfoPlatillos }))), vistaExportacion: "platillos" },
  { slug: "patrones", etiqueta: "Patrones", icono: CalendarRange, componente: lazy(() => import("./CfoPatrones.tsx").then((m) => ({ default: m.CfoPatrones }))), vistaExportacion: "patrones" },
  { slug: "operacion", etiqueta: "Operación y agente", icono: Truck, componente: lazy(() => import("./CfoOperacion.tsx").then((m) => ({ default: m.CfoOperacion }))), vistaExportacion: "operacion" },
  { slug: "softrestaurant", etiqueta: "SoftRestaurant", icono: Monitor, componente: lazy(() => import("./CfoSoftRestaurant.tsx").then((m) => ({ default: m.CfoSoftRestaurant }))), vistaExportacion: "softrestaurant" },
];

export const SLUG_INICIAL_CFO = "resumen";
