// D-P3-13 -- repositorio de la clasificación contable persistida (migración 026): clasificaciones por CFDI (siempre filas nuevas), correcciones por RFC
// emisor, configuración por cliente (umbral y autoaceptado del portal) y recálculo de la dirección. Contra la base sin migrar las lecturas devuelven
// `no_disponible` con vacío honesto y las escrituras `ClasificacionNoDisponibleError` (503), nunca un 500.
import type { CorreccionClasificacion, MetodoClasificacion, ResultadoClasificacionCfdi } from "../bookkeeping/clasificacion-cfdi.ts";

export type MetodoClasificacionRegistrado = MetodoClasificacion | "manual" | "heuristica_claveprodserv";

/** Lo que se escribe en `invoice_classification` al ingerir: el resultado del clasificador, o la categoría que el staff indicó (`manual`, confianza 1). */
export interface ClasificacionAEscribir {
  readonly categoria: string;
  readonly confianza: number;
  readonly metodo: MetodoClasificacion | "manual";
  readonly razon: string | null;
  readonly cuenta: string | null;
  readonly empate: boolean;
}

export function aClasificacionAEscribir(r: ResultadoClasificacionCfdi): ClasificacionAEscribir {
  return { categoria: r.categoria, confianza: r.confianza, metodo: r.metodo, razon: r.razon, cuenta: r.cuenta, empate: r.empate };
}

export interface ClasificacionRecord {
  readonly id: string;
  readonly invoiceId: string;
  readonly categoria: string;
  readonly confianza: number | null;
  readonly metodo: MetodoClasificacionRegistrado;
  readonly razon: string | null;
  readonly cuenta: string | null;
  readonly empate: boolean;
  /** Staff que la escribió; null = el sistema (ingesta automática, cron, autoaceptado del portal). */
  readonly clasificadaPor: string | null;
  readonly creadaEn: string;
}

export interface CorreccionRecord extends CorreccionClasificacion {
  readonly id: string;
  readonly autorId: string | null;
  readonly creadaEn: string;
  readonly actualizadaEn: string;
}

export interface HistorialCorreccionManual {
  readonly cfdiUuid: string;
  readonly rfcEmisor: string;
  readonly categoria: string;
}

export interface CorreccionInput {
  readonly rfcEmisor: string;
  readonly claveProdServ: string | null;
  readonly categoria: string;
  readonly cuenta: string | null;
}

export interface ConfigClasificacion {
  /** Umbral de confianza del despacho para este cliente (>= piso 0.5). */
  readonly umbral: number;
  /** Los XML válidos del portal se aceptan solos (encendido por omisión). */
  readonly portalAutoaceptar: boolean;
  /** false = la base aún no tiene la migración 026: se devuelven los valores por omisión. */
  readonly disponible: boolean;
}

export interface LecturaClasificacion<T> {
  readonly estado: "ok" | "no_disponible";
  readonly datos: T;
}

export class ClasificacionNoDisponibleError extends Error {
  constructor(message = "La clasificación contable aún no está disponible en esta base de datos (falta aplicar la migración 026).") {
    super(message);
    this.name = "ClasificacionNoDisponibleError";
  }
}
export class ClasificacionSinPermisoError extends Error {
  constructor(message = "No tienes permiso sobre este cliente.") {
    super(message);
    this.name = "ClasificacionSinPermisoError";
  }
}
export class ClasificacionDatosInvalidosError extends Error {
  constructor(message = "Datos inválidos.") {
    super(message);
    this.name = "ClasificacionDatosInvalidosError";
  }
}
export class ClasificacionNoEncontradaError extends Error {
  constructor(message = "No se encontró el registro.") {
    super(message);
    this.name = "ClasificacionNoEncontradaError";
  }
}
export class ClasificacionTopeExcedidoError extends Error {
  constructor(message = "Se alcanzó el tope de correcciones del cliente.") {
    super(message);
    this.name = "ClasificacionTopeExcedidoError";
  }
}

export interface ClasificacionRepository {
  /** Escribe la clasificación automática de un CFDI recién ingerido (fila nueva). `false` = la base no la tiene (el CFDI se ingiere igual). */
  registrar(propertyId: string, invoiceId: string, resultado: ClasificacionAEscribir): Promise<boolean>;
  /** Corrección humana de UN CFDI: fila nueva `manual` (confianza 1) y, si se pide, la regla por RFC emisor. Devuelve el id de la clasificación. */
  corregirCategoria(propertyId: string, invoiceId: string, input: { readonly categoria: string; readonly cuenta: string | null; readonly guardarRegla: boolean }): Promise<string>;
  /** Última clasificación de cada CFDI dado (invoiceId -> registro). */
  vigentes(propertyId: string, invoiceIds: readonly string[]): Promise<LecturaClasificacion<ReadonlyMap<string, ClasificacionRecord>>>;
  /** Historial completo de un CFDI, la más reciente primero (tope 50). */
  historial(propertyId: string, invoiceId: string): Promise<LecturaClasificacion<readonly ClasificacionRecord[]>>;
  listarCorrecciones(propertyId: string): Promise<LecturaClasificacion<readonly CorreccionRecord[]>>;
  /** Correcciones HUMANAS de categoria ya persistidas (filas `manual` de `invoice_classification`), las mas recientes primero (tope 2000): alimentan las sugerencias de regla por RFC. */
  historialManual(propertyId: string): Promise<LecturaClasificacion<readonly HistorialCorreccionManual[]>>;
  guardarCorreccion(propertyId: string, input: CorreccionInput): Promise<string>;
  eliminarCorreccion(propertyId: string, id: string): Promise<boolean>;
  leerConfig(propertyId: string): Promise<ConfigClasificacion>;
  guardarConfig(propertyId: string, organizationId: string, cambios: { readonly umbral?: number; readonly portalAutoaceptar?: boolean }): Promise<ConfigClasificacion>;
  /** Recalcula la dirección de los CFDI `indeterminado` con la ficha vigente. `null` = la base no lo tiene aún. */
  recalcularDireccion(propertyId: string): Promise<number | null>;
}
