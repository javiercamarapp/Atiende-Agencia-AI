// Analítica del dueño · servicio: junta el repositorio con las funciones puras. Cada sección degrada por separado (`disponible: false` si la base no
// tiene la migración); un error NO recuperable se propaga (la API lo traduce) y nunca se esconde.
import { construirDemanda, type DemandaVista } from "./demanda.ts";
import { construirProductos, type ProductosVista } from "./productos.ts";
import { calcularRatios, DEFINICIONES_RATIOS, type DefinicionRatio, type RatiosCalculados } from "./ratios.ts";
import type { AnaliticaRepository } from "./repositorio.ts";
import { K_ZONAS, type ParamsAnalitica, type SucursalAnalitica } from "./tipos.ts";
import { construirZonas, type ZonaVista } from "./zonas.ts";

export const PEDIDO_GRANDE_CENTAVOS = 400_000;
export const LIMITE_PRODUCTOS_POR_OMISION = 30;

export interface AlcanceAnalitica {
  readonly organizationId: string;
  readonly propertyIds: readonly string[] | null;
  readonly sucursales: readonly SucursalAnalitica[];
}
interface Base { readonly desde: string; readonly hasta: string; readonly sucursales: readonly SucursalAnalitica[] }
export type VistaDemanda = Base & { readonly disponible: true; readonly demanda: DemandaVista } | (Base & { readonly disponible: false });
export type VistaZonas = Base & { readonly disponible: true; readonly zonas: readonly ZonaVista[]; readonly k: number } | (Base & { readonly disponible: false });
export type VistaProductos = Base & { readonly disponible: true; readonly productos: ProductosVista } | (Base & { readonly disponible: false });
export type VistaRatios = Base & { readonly disponible: true; readonly filas: readonly RatiosCalculados[]; readonly definiciones: readonly DefinicionRatio[] } | (Base & { readonly disponible: false });

export class ServicioAnalitica {
  constructor(private readonly repo: AnaliticaRepository, private readonly alcance: AlcanceAnalitica) {}

  private params(desde: string, hasta: string): ParamsAnalitica {
    return { organizationId: this.alcance.organizationId, propertyIds: this.alcance.propertyIds, desde, hasta };
  }
  private base(desde: string, hasta: string): Base {
    return { desde, hasta, sucursales: this.alcance.sucursales };
  }

  async demanda(desde: string, hasta: string): Promise<VistaDemanda> {
    const l = await this.repo.demanda(this.params(desde, hasta));
    return l.disponible ? { ...this.base(desde, hasta), disponible: true, demanda: construirDemanda(l.datos) } : { ...this.base(desde, hasta), disponible: false };
  }
  async zonas(desde: string, hasta: string): Promise<VistaZonas> {
    const l = await this.repo.zonas(this.params(desde, hasta), K_ZONAS);
    return l.disponible ? { ...this.base(desde, hasta), disponible: true, zonas: construirZonas(l.datos), k: K_ZONAS } : { ...this.base(desde, hasta), disponible: false };
  }
  async productos(desde: string, hasta: string, limite: number = LIMITE_PRODUCTOS_POR_OMISION): Promise<VistaProductos> {
    const l = await this.repo.productos(this.params(desde, hasta), limite);
    return l.disponible ? { ...this.base(desde, hasta), disponible: true, productos: construirProductos(l.datos) } : { ...this.base(desde, hasta), disponible: false };
  }
  async ratios(desde: string, hasta: string): Promise<VistaRatios> {
    const l = await this.repo.ratios(this.params(desde, hasta), PEDIDO_GRANDE_CENTAVOS);
    return l.disponible
      ? { ...this.base(desde, hasta), disponible: true, filas: l.datos.filas.map(calcularRatios), definiciones: DEFINICIONES_RATIOS }
      : { ...this.base(desde, hasta), disponible: false };
  }
}
