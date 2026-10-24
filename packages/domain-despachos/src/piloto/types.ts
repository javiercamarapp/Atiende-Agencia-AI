// paridad3 D-31 + D-P3-15 + D-P3-21 -- tipos y errores del piloto automatico de cierre y entrega al cliente (migracion 027).
import type { EstadoModulosCierre } from "../cierre-mensual/piloto.ts";
import type { CloseTask } from "../cierre-mensual/types.ts";

/** `disponible: false` = la base aun no tiene la migracion 027 (42883/42P01/42703 dentro de un SAVEPOINT): "no disponible aun", nunca un 500. */
export type PilotoDisponible<T> = { readonly disponible: true; readonly valor: T } | { readonly disponible: false };

export class PilotoNoDisponibleError extends Error {
  constructor() {
    super("Esta funcion aun no esta disponible en este ambiente: falta aplicar la migracion 027.");
    this.name = "PilotoNoDisponibleError";
  }
}
export class PilotoNoEncontradoError extends Error {
  constructor(mensaje = "No encontrado.") {
    super(mensaje);
    this.name = "PilotoNoEncontradoError";
  }
}
export class PilotoEntradaInvalidaError extends Error {
  constructor(mensaje = "La solicitud no es valida.") {
    super(mensaje);
    this.name = "PilotoEntradaInvalidaError";
  }
}
export class PilotoSinAccesoError extends Error {
  constructor() {
    super("Sin permiso sobre este cliente.");
    this.name = "PilotoSinAccesoError";
  }
}

// ------------------------------------------------------------------ automatizacion por cliente
export interface PlantillaSolicitud {
  readonly xmlEmitidos?: boolean;
  readonly xmlRecibidos?: boolean;
  readonly nomina?: boolean;
  readonly otros?: boolean;
  /** Cuentas bancarias a pedir (hasta 10). Ausente = las que tengan movimientos importados en los ultimos meses. */
  readonly estadosCuenta?: readonly string[];
}

export interface AutomatizacionCliente {
  readonly contactoCorreo: string | null;
  /** Opt-in de la entrega de reportes al cerrar el periodo. APAGADO por omision. */
  readonly envioReportesCierre: boolean;
  readonly solicitudActiva: boolean;
  readonly solicitudDia: number;
  readonly plantilla: PlantillaSolicitud;
}

export const AUTOMATIZACION_POR_OMISION: AutomatizacionCliente = { contactoCorreo: null, envioReportesCierre: false, solicitudActiva: true, solicitudDia: 1, plantilla: {} };

// ------------------------------------------------------------------ solicitudes de documentos
export type TipoRenglonSolicitud = "estado_cuenta" | "xml_emitidos" | "xml_recibidos" | "nomina" | "otros";
export type EstadoRenglonSolicitud = "pendiente" | "en_revision" | "recibido" | "no_aplica";

export interface RenglonSolicitud {
  readonly id: string;
  readonly tipo: TipoRenglonSolicitud;
  readonly etiqueta: string;
  readonly estado: EstadoRenglonSolicitud;
  readonly motivoNoAplica: string | null;
  readonly documentoId: string | null;
  readonly resueltoEn: string | null;
}

export interface SolicitudDocumentos {
  readonly id: string;
  readonly propertyId: string;
  readonly ejercicio: number;
  readonly mes: number;
  readonly estado: "abierta" | "completa";
  readonly creadaEn: string;
  readonly completadaEn: string | null;
  readonly ultimoRecordatorioNivel: number;
  readonly renglones: readonly RenglonSolicitud[];
}

export type SemaforoDocumentos = "verde" | "amarillo" | "rojo" | "sin_solicitud";

/** Resumen por cliente para la Cartera y el cierre: cuantos renglones hay en cada estado. */
export interface ResumenSolicitudCliente {
  readonly propertyId: string;
  readonly ejercicio: number;
  readonly mes: number;
  readonly estado: "abierta" | "completa";
  readonly creadaEn: string;
  readonly total: number;
  readonly pendientes: number;
  readonly enRevision: number;
  readonly recibidos: number;
  readonly noAplica: number;
}

/**
 * Semaforo de documentos de un cliente: verde = completa; amarillo = abierta con algo en revision o con menos de 7 dias desde que se pidio;
 * rojo = abierta con renglones pendientes pasados 7 dias; sin_solicitud = aun no se pidio nada para el periodo.
 */
export function semaforoDeSolicitud(r: ResumenSolicitudCliente | null | undefined, ahoraMs: number): SemaforoDocumentos {
  if (!r) return "sin_solicitud";
  if (r.estado === "completa") return "verde";
  const dias = (ahoraMs - Date.parse(r.creadaEn)) / 86_400_000;
  if (r.pendientes > 0 && dias >= 7) return "rojo";
  return "amarillo";
}

export interface RegistroSolicitudSistema {
  readonly id: string;
  readonly creada: boolean;
  readonly organizationId: string;
  readonly contactoCorreo: string | null;
  readonly cliente: string;
  readonly renglones: number;
  /** Etiquetas de los renglones pedidos (cuentas enmascaradas): van en el correo al cliente. */
  readonly etiquetas: readonly string[];
}

export interface SolicitudPorCrear {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly ejercicio: number;
  readonly mes: number;
}

export interface SolicitudParaRecordatorio {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly ejercicio: number;
  readonly mes: number;
  /** 1 = a los 3 dias, 2 = a los 7, 3 = a los 10. */
  readonly nivel: 1 | 2 | 3;
  readonly pendientes: number;
  readonly dias: number;
  readonly contactoCorreo: string | null;
  readonly cliente: string;
}

// ------------------------------------------------------------------ cierre
export interface PeriodoCierreAbierto {
  readonly periodoId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly anio: number;
  readonly mes: number;
}

export type TipoArchivoEntrega = "impuestos" | "diot" | "balanza";
export interface EntregaCierre {
  readonly id: string;
  readonly creada: boolean;
  readonly contactoCorreo: string;
  readonly anio: number;
  readonly mes: number;
}
export interface ArchivoEntregaMeta {
  readonly id: string;
  readonly tipo: TipoArchivoEntrega;
  readonly nombreArchivo: string;
  readonly tamanoBytes: number;
}
export interface EntregaPublicada {
  readonly anio: number;
  readonly mes: number;
  readonly publicadaEn: string;
  readonly archivos: readonly ArchivoEntregaMeta[];
}

export type TipoArtefactoCierre = "contabilidad_catalogo_xml" | "contabilidad_balanza_xml";
export interface ArtefactoCierreMeta {
  readonly id: string;
  readonly periodoCierreId: string;
  readonly tipo: TipoArtefactoCierre;
  readonly nombreArchivo: string;
  readonly tamanoBytes: number;
  readonly creadoEn: string;
}

export interface CancelacionForzada {
  readonly forzado: boolean;
  readonly motivo: string | null;
  readonly validaciones: readonly string[];
}

// ------------------------------------------------------------------ portal
export interface SolicitudVistaCliente {
  readonly id: string;
  readonly ejercicio: number;
  readonly mes: number;
  readonly estado: "abierta" | "completa";
  readonly renglones: readonly { readonly id: string; readonly tipo: TipoRenglonSolicitud; readonly etiqueta: string; readonly estado: EstadoRenglonSolicitud; readonly motivo: string | null }[];
}

export interface PilotoRepository {
  // ---- STAFF (sesion del request; RLS por property)
  obtenerAutomatizacion(propertyId: string): Promise<PilotoDisponible<AutomatizacionCliente>>;
  guardarAutomatizacion(propertyId: string, a: AutomatizacionCliente): Promise<void>;
  listarSolicitudes(propertyId: string, limite?: number): Promise<PilotoDisponible<readonly SolicitudDocumentos[]>>;
  /** Resumen de la solicitud del periodo de TODOS los clientes visibles al staff (para el semaforo de la Cartera). */
  resumenSolicitudesPeriodo(ejercicio: number, mes: number): Promise<PilotoDisponible<readonly ResumenSolicitudCliente[]>>;
  crearSolicitud(propertyId: string, ejercicio: number, mes: number): Promise<{ readonly id: string; readonly creada: boolean }>;
  marcarRenglonNoAplica(propertyId: string, renglonId: string, motivo: string): Promise<boolean>;
  reabrirRenglon(propertyId: string, renglonId: string): Promise<boolean>;
  vincularDocumentoStaff(propertyId: string, renglonId: string, documentoId: string): Promise<EstadoRenglonSolicitud>;
  /** Estado de los modulos del cierre calculado por el servidor desde datos persistidos. */
  estadoModulosCierre(propertyId: string, anio: number, mes: number): Promise<PilotoDisponible<EstadoModulosCierre>>;
  forzarCierre(propertyId: string, periodoId: string, motivo: string, validaciones: readonly string[]): Promise<boolean>;
  crearEntrega(propertyId: string, periodoId: string): Promise<EntregaCierre>;
  agregarArchivoEntrega(propertyId: string, entregaId: string, tipo: TipoArchivoEntrega, nombre: string, contenido: Uint8Array): Promise<boolean>;
  marcarCorreoEntrega(propertyId: string, entregaId: string): Promise<boolean>;
  guardarArtefacto(propertyId: string, periodoId: string, tipo: TipoArtefactoCierre, nombre: string, contenido: Uint8Array): Promise<boolean>;
  listarArtefactos(propertyId: string, periodoId: string): Promise<PilotoDisponible<readonly ArtefactoCierreMeta[]>>;
  contenidoArtefacto(propertyId: string, artefactoId: string): Promise<{ readonly nombreArchivo: string; readonly contenido: Uint8Array }>;
  /** Hay entrega abierta para el periodo (`null` = no se genero: opt-in apagado o aun no cerrado). */
  entregaDelPeriodo(propertyId: string, periodoId: string): Promise<PilotoDisponible<{ readonly id: string; readonly creadaEn: string; readonly correoEncoladoEn: string | null; readonly archivos: readonly ArchivoEntregaMeta[] } | null>>;

  // ---- SISTEMA (sesion `userId: null`)
  solicitudesPorCrear(hoy: string, limite: number): Promise<readonly SolicitudPorCrear[] | null>;
  crearSolicitudSistema(propertyId: string, ejercicio: number, mes: number): Promise<RegistroSolicitudSistema>;
  crearEnlaceSistema(propertyId: string, tokenHash: string, etiqueta: string, dias: number): Promise<{ readonly id: string; readonly expiraEn: string }>;
  solicitudesParaRecordatorio(hoy: string, limite: number): Promise<readonly SolicitudParaRecordatorio[] | null>;
  marcarRecordatorio(solicitudId: string, nivel: 1 | 2 | 3): Promise<boolean>;
  periodosCierreAbiertos(limite: number): Promise<readonly PeriodoCierreAbierto[] | null>;
  /** Todas las tareas de un periodo ABIERTO (el auto-check necesita las dependencias). */
  tareasCierreSistema(periodoId: string): Promise<readonly CloseTask[]>;
  autocompletarTareasSistema(periodoId: string, tareaIds: readonly string[]): Promise<number>;

  // ---- PORTAL (sistema; recibe el HASH del token)
  portalSolicitudes(tokenHash: string): Promise<PilotoDisponible<readonly SolicitudVistaCliente[]>>;
  portalVincular(tokenHash: string, documentoId: string, renglonId: string): Promise<PilotoDisponible<EstadoRenglonSolicitud>>;
  portalReportes(tokenHash: string): Promise<PilotoDisponible<readonly EntregaPublicada[]>>;
  portalReporteContenido(tokenHash: string, archivoId: string): Promise<PilotoDisponible<{ readonly nombreArchivo: string; readonly contenido: Uint8Array }>>;
}
