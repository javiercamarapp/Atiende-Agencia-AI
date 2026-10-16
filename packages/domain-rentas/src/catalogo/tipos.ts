// Rn-18 / Rn-19 -- reglas de comision de canal y catalogo (propiedades, unidades, propietarios) que el
// panel administra. Tipos de dominio, sin IO. La autoridad real de cada escritura es la funcion SQL
// `security definer` de la migracion 027 (rol, alcance de property, aislamiento entre tenants); estos
// tipos solo describen lo que entra y sale.

export const MONEDAS_PERMITIDAS = ["MXN", "USD"] as const;
export type MonedaPermitida = (typeof MONEDAS_PERMITIDAS)[number];

export interface ReglaComisionRecord {
  readonly id: string;
  /** `null` = regla global de la organizacion. */
  readonly propertyId: string | null;
  readonly canalCodigo: string;
  readonly canalNombre: string;
  readonly yaNetoDeComision: boolean;
  readonly comisionBasisPoints: number;
  readonly fuente: string;
  readonly vigenteDesde: string;
  /** `true` si la regla viene del sembrado por defecto y nadie la ha confirmado (fuente "default_sugerido..."). */
  readonly sugerida: boolean;
}

export interface CanalRecordCatalogo {
  readonly codigo: string;
  readonly nombre: string;
}

export interface PropiedadCatalogoRecord {
  readonly propertyId: string;
  readonly nombre: string;
  /** `null` solo si la property no tiene fila de configuracion (no deberia ocurrir). */
  readonly zonaHoraria: string | null;
  readonly moneda: string | null;
}

export interface PropietarioRecord {
  readonly id: string;
  readonly nombre: string;
  readonly email: string | null;
}

export interface UnidadCatalogoRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly nombre: string;
  readonly duracionMinimaNoches: number;
  readonly propietarioId: string | null;
  readonly propietarioNombre: string | null;
  /** Responsable de limpieza por omision (`rentas.unidad.responsable_limpieza_default`, migracion 033): la tarea de limpieza de cada
   *  checkout nace asignada a el. `null` = cola "Sin asignar". Base sin migrar: siempre `null`. */
  readonly responsableLimpiezaId: string | null;
}

export type MotivoRechazoCatalogo = "sin_permiso" | "invalido" | "duplicado" | "regla_integridad" | "no_encontrado";

/** Resultado de una escritura: la base sin la migracion 027 responde `no_disponible` (la ruta contesta
 *  503 honesto), una regla de negocio de la funcion SQL responde `rechazado` con su mensaje. */
export type ResultadoCatalogo<T> =
  | { readonly estado: "ok"; readonly valor: T }
  | { readonly estado: "no_disponible" }
  | { readonly estado: "rechazado"; readonly motivo: MotivoRechazoCatalogo; readonly mensaje: string };

export interface EntradaReglaComision {
  /** 'organizacion' = regla global (todas las propiedades); 'propiedad' = solo la property de la ruta. */
  readonly alcance: "organizacion" | "propiedad";
  readonly canalCodigo: string;
  readonly yaNetoDeComision: boolean;
  readonly comisionBasisPoints: number;
  readonly fuente: string;
}

export interface EntradaActualizarReglaComision {
  readonly yaNetoDeComision: boolean;
  readonly comisionBasisPoints: number;
  readonly fuente: string;
}

export interface EntradaCrearPropiedad {
  readonly nombre: string;
  readonly zonaHoraria: string;
  readonly moneda: MonedaPermitida;
}

export interface EntradaActualizarPropiedad {
  readonly nombre?: string;
  readonly zonaHoraria?: string;
  readonly moneda?: MonedaPermitida;
}

export interface EntradaCrearUnidad {
  readonly nombre: string;
  readonly propietarioId: string | null;
  readonly duracionMinimaNoches: number;
}

export interface EntradaActualizarUnidad {
  readonly nombre?: string;
  /** `undefined` = sin cambio; `null` = quitar el propietario. */
  readonly propietarioId?: string | null;
  readonly duracionMinimaNoches?: number;
}

export interface EntradaCrearPropietario {
  readonly nombre: string;
  readonly email: string | null;
}

export interface EntradaActualizarPropietario {
  readonly nombre?: string;
  /** `undefined` = sin cambio; `null` = quitar el correo. */
  readonly email?: string | null;
}
