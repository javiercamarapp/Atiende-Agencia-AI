// Analítica del dueño · contrato del repositorio y errores tipados. La implementación Postgres vive aparte (importa Node); la de memoria es de pruebas.
import type { DemandaCruda, Lectura, ParamsAnalitica, ProductosCrudo, RatiosCrudo, ZonaCruda } from "./tipos.ts";

export class AnaliticaParametroInvalidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnaliticaParametroInvalidoError";
  }
}
export class AnaliticaSinAccesoError extends Error {
  constructor(message = "No tienes acceso a esta sucursal.") {
    super(message);
    this.name = "AnaliticaSinAccesoError";
  }
}
export class AnaliticaNoDisponibleError extends Error {
  constructor(message = "Esta función de analítica todavía no está disponible en esta base de datos.") {
    super(message);
    this.name = "AnaliticaNoDisponibleError";
  }
}

export interface AnaliticaRepository {
  demanda(p: ParamsAnalitica): Promise<Lectura<DemandaCruda>>;
  zonas(p: ParamsAnalitica, k: number): Promise<Lectura<readonly ZonaCruda[]>>;
  productos(p: ParamsAnalitica, limite: number): Promise<Lectura<ProductosCrudo>>;
  ratios(p: ParamsAnalitica, grandeCentavos: number): Promise<Lectura<RatiosCrudo>>;
  /** costoPesos null = borrar el costo. Escritura: base sin migrar => AnaliticaNoDisponibleError (nunca 500). */
  guardarCostoProducto(organizationId: string, productId: string, costoPesos: number | null): Promise<void>;
}

/** Repositorio de pruebas: devuelve lo que se le cargue y cuenta las llamadas (sin base). */
export class InMemoryAnaliticaRepository implements AnaliticaRepository {
  readonly llamadas: string[] = [];
  readonly costos = new Map<string, number>();
  constructor(
    private readonly datos: {
      readonly demanda?: DemandaCruda;
      readonly zonas?: readonly ZonaCruda[];
      readonly productos?: ProductosCrudo;
      readonly ratios?: RatiosCrudo;
      /** true = simula la base sin migrar. */
      readonly sinMigrar?: boolean;
    } = {},
  ) {}
  private lee<T>(nombre: string, valor: T | undefined): Promise<Lectura<T>> {
    this.llamadas.push(nombre);
    if (this.datos.sinMigrar || valor === undefined) return Promise.resolve({ disponible: false });
    return Promise.resolve({ disponible: true, datos: valor });
  }
  demanda(): Promise<Lectura<DemandaCruda>> { return this.lee("demanda", this.datos.demanda); }
  zonas(): Promise<Lectura<readonly ZonaCruda[]>> { return this.lee("zonas", this.datos.zonas); }
  productos(): Promise<Lectura<ProductosCrudo>> { return this.lee("productos", this.datos.productos); }
  ratios(): Promise<Lectura<RatiosCrudo>> { return this.lee("ratios", this.datos.ratios); }
  guardarCostoProducto(organizationId: string, productId: string, costoPesos: number | null): Promise<void> {
    this.llamadas.push("guardarCostoProducto");
    if (this.datos.sinMigrar) return Promise.reject(new AnaliticaNoDisponibleError());
    const k = `${organizationId}|${productId}`;
    if (costoPesos === null) this.costos.delete(k);
    else this.costos.set(k, costoPesos);
    return Promise.resolve();
  }
}
