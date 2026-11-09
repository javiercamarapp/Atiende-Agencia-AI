// CFO-07 · registro de las pestañas del CFO: `{ slug, etiqueta, icono, componente perezoso }`. `CfoLayout` arma las pestañas, la ruta y la
// exportación a partir de esta lista. PUNTO DE CONTACTO con CFO-08: sus pestañas (Clientes, Platillos, Patrones, Operación y SoftRestaurant) van
// al final, cada una con su propio componente perezoso y su `vistaExportacion`; no hay que tocar `CfoLayout`.
import { lazy } from "react";
import type { ComponentType, LazyExoticComponent } from "react";
import { CalendarRange, ChartNoAxesCombined, LayoutDashboard, Monitor, Receipt, ShoppingBag, Store, Truck, UtensilsCrossed, Users } from "lucide-react";
import type { VistaExportacionCfo } from "@atiende/domain-restaurantes/cfo";
import { traductorActivo } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesCfo } from "@atiende/ui/i18n/restaurantes/cfo";
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

const tr = traductorActivo(restaurantesCfo);

/** `etiqueta` se traduce en cada lectura al idioma activo (i18n); en espanol, el texto de siempre. */
function pagina(clave: Clave, p: Omit<PaginaCfo, "etiqueta">): PaginaCfo {
  return {
    ...p,
    get etiqueta() {
      return tr(clave);
    },
  };
}

export const PAGINAS_CFO: readonly PaginaCfo[] = [
  pagina("restaurantes.cfo.pagina.resumen", { slug: "resumen", icono: LayoutDashboard, componente: lazy(() => import("./CfoResumen.tsx").then((m) => ({ default: m.CfoResumen }))), vistaExportacion: "resumen" }),
  pagina("restaurantes.cfo.pagina.ventas", { slug: "ventas", icono: ShoppingBag, componente: lazy(() => import("./CfoVentas.tsx").then((m) => ({ default: m.CfoVentas }))), vistaExportacion: "ventas" }),
  pagina("restaurantes.cfo.pagina.sucursales", { slug: "sucursales", icono: Store, componente: lazy(() => import("./CfoSucursales.tsx").then((m) => ({ default: m.CfoSucursales }))), vistaExportacion: "sucursales" }),
  pagina("restaurantes.cfo.pagina.estadoResultados", { slug: "estado-resultados", icono: Receipt, componente: lazy(() => import("./CfoEstadoResultados.tsx").then((m) => ({ default: m.CfoEstadoResultados }))), vistaExportacion: "estado_resultados" }),
  pagina("restaurantes.cfo.pagina.clientes", { slug: "clientes", icono: Users, componente: lazy(() => import("./CfoClientes.tsx").then((m) => ({ default: m.CfoClientes }))), vistaExportacion: "clientes" }),
  // Solo lectura (SQL 095). Sin exportación todavía: la vista `analisis_clientes` del exportador queda para una fase posterior (docs/restaurantes/ANALISIS-CLIENTES.md).
  pagina("restaurantes.cfo.pagina.analisisClientes", { slug: "analisis-clientes", icono: ChartNoAxesCombined, componente: lazy(() => import("./CfoAnalisisClientes.tsx").then((m) => ({ default: m.CfoAnalisisClientes }))), vistaExportacion: null }),
  pagina("restaurantes.cfo.pagina.platillos", { slug: "platillos", icono: UtensilsCrossed, componente: lazy(() => import("./CfoPlatillos.tsx").then((m) => ({ default: m.CfoPlatillos }))), vistaExportacion: "platillos" }),
  pagina("restaurantes.cfo.pagina.patrones", { slug: "patrones", icono: CalendarRange, componente: lazy(() => import("./CfoPatrones.tsx").then((m) => ({ default: m.CfoPatrones }))), vistaExportacion: "patrones" }),
  pagina("restaurantes.cfo.pagina.operacion", { slug: "operacion", icono: Truck, componente: lazy(() => import("./CfoOperacion.tsx").then((m) => ({ default: m.CfoOperacion }))), vistaExportacion: "operacion" }),
  pagina("restaurantes.cfo.pagina.softrestaurant", { slug: "softrestaurant", icono: Monitor, componente: lazy(() => import("./CfoSoftRestaurant.tsx").then((m) => ({ default: m.CfoSoftRestaurant }))), vistaExportacion: "softrestaurant" }),
];


export const SLUG_INICIAL_CFO = "resumen";
