// Rn-18 / Rn-19 -- puerto de datos del catalogo y de las reglas de comision. Separado de
// RentasRepository a proposito (mismo criterio que RentasAccesoRepository): las escrituras dependen de
// funciones nuevas de la migracion 027, que pueden no existir todavia en la base real.
import type {
  CanalRecordCatalogo,
  EntradaActualizarPropiedad,
  EntradaActualizarPropietario,
  EntradaActualizarReglaComision,
  EntradaActualizarUnidad,
  EntradaCrearPropiedad,
  EntradaCrearPropietario,
  EntradaCrearUnidad,
  EntradaReglaComision,
  PropiedadCatalogoRecord,
  PropietarioRecord,
  ReglaComisionRecord,
  ResultadoCatalogo,
  UnidadCatalogoRecord,
} from "./tipos.ts";

export interface RentasCatalogoRepository {
  // ---- lecturas (tablas que ya existen en cualquier base; RLS real del request) ----
  /** Reglas globales de la organizacion y las especificas de `propertyId`. */
  listarReglasComision(organizationId: string, propertyId: string): Promise<readonly ReglaComisionRecord[]>;
  listarCanales(): Promise<readonly CanalRecordCatalogo[]>;
  /** Propiedades activas de la organizacion que el staff puede ver, con su configuracion. */
  listarPropiedades(organizationId: string): Promise<readonly PropiedadCatalogoRecord[]>;
  listarUnidades(propertyId: string): Promise<readonly UnidadCatalogoRecord[]>;
  listarPropietarios(organizationId: string): Promise<readonly PropietarioRecord[]>;

  // ---- escrituras (funciones SQL de la migracion 027; `no_disponible` si aun no se aplica) ----
  crearReglaComision(organizationId: string, propertyId: string, entrada: EntradaReglaComision): Promise<ResultadoCatalogo<{ id: string }>>;
  actualizarReglaComision(reglaId: string, entrada: EntradaActualizarReglaComision): Promise<ResultadoCatalogo<{ id: string }>>;
  /** Siembra las reglas por defecto que falten; devuelve cuantas creo. */
  sembrarReglasComisionPorDefecto(organizationId: string): Promise<ResultadoCatalogo<{ creadas: number }>>;
  crearPropiedad(organizationId: string, entrada: EntradaCrearPropiedad): Promise<ResultadoCatalogo<{ propertyId: string }>>;
  actualizarPropiedad(propertyId: string, entrada: EntradaActualizarPropiedad): Promise<ResultadoCatalogo<{ propertyId: string }>>;
  crearPropietario(organizationId: string, entrada: EntradaCrearPropietario): Promise<ResultadoCatalogo<{ id: string }>>;
  actualizarPropietario(organizationId: string, propietarioId: string, entrada: EntradaActualizarPropietario): Promise<ResultadoCatalogo<{ id: string }>>;
  crearUnidad(propertyId: string, entrada: EntradaCrearUnidad): Promise<ResultadoCatalogo<{ id: string }>>;
  actualizarUnidad(unidadId: string, entrada: EntradaActualizarUnidad): Promise<ResultadoCatalogo<{ id: string }>>;
  /** Responsable de limpieza por omision de la unidad (`null` lo quita). Funcion SQL de la migracion 033: `no_disponible` si aun no se aplica. */
  fijarResponsableLimpieza(unidadId: string, responsableId: string | null): Promise<ResultadoCatalogo<{ id: string }>>;
}
