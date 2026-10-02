// D-35 + D-02 -- conciliación bancaria PERSISTIDA (migración 021): sesiones por periodo, matches confirmados por una persona,
// y sugerencias del nivel 4 (LLM) que quedan pendientes hasta su aprobación humana. Contrato del repositorio (Postgres + doble en
// memoria) y errores de dominio tipados que las rutas HTTP traducen a 400/403/404/409/503.
import type { MovimientoBancario } from "../types.ts";

export type EstadoSesionConciliacion = "abierta" | "cerrada";
export type OrigenMatchConciliacion = "motor" | "llm_aprobado" | "manual";
export type EstadoSugerenciaConciliacion = "pendiente" | "aprobada" | "rechazada";

/** Movimiento del libro `despachos.estado_cuenta_movimiento` (migración 015), con su id y su huella. */
export interface MovimientoGuardado extends MovimientoBancario {
  readonly id: string;
  readonly hash: string;
  readonly cuenta: string | null;
}

export interface SesionConciliacion {
  readonly id: string;
  readonly propertyId: string;
  /** YYYY-MM */
  readonly periodo: string;
  readonly cuenta: string | null;
  readonly estado: EstadoSesionConciliacion;
  readonly creadaPor: string | null;
  readonly creadaEn: string;
  readonly cerradaEn: string | null;
}

export interface SesionConResumen extends SesionConciliacion {
  readonly totalMovimientos: number;
  readonly matchesVigentes: number;
  readonly sugerenciasPendientes: number;
}

export interface MatchConciliacion {
  readonly id: string;
  readonly sesionId: string;
  readonly movimientoId: string;
  readonly invoiceId: string;
  /** 1 exacto, 2 fuzzy, 3 multi-línea, 4 IA; null en un match manual. */
  readonly nivel: number | null;
  readonly confianza: number | null;
  readonly origen: OrigenMatchConciliacion;
  readonly confirmadoPor: string | null;
  readonly confirmadoEn: string;
  readonly deshechoPor: string | null;
  readonly deshechoEn: string | null;
  readonly motivoDeshacer: string | null;
}

export interface SugerenciaConciliacion {
  readonly id: string;
  readonly sesionId: string;
  readonly movimientoId: string;
  readonly invoiceId: string;
  readonly confianza: number;
  readonly razon: string;
  readonly estado: EstadoSugerenciaConciliacion;
  readonly matchId: string | null;
  readonly creadaEn: string;
  readonly resueltaEn: string | null;
}

/** Par que la ruta ya validó contra el motor (o marcó manual) y se pasa a confirmar. */
export interface ParConfirmar {
  readonly movimientoId: string;
  readonly invoiceId: string;
  readonly nivel: number | null;
  readonly confianza: number | null;
  readonly origen: OrigenMatchConciliacion;
}

export interface NuevaSugerencia {
  readonly movimientoId: string;
  readonly invoiceId: string;
  readonly confianza: number;
  readonly razon: string;
}

export type EstadoConciliacionPersistida = "disponible" | "no_disponible";
export interface LecturaConciliacion<T> {
  readonly estado: EstadoConciliacionPersistida;
  readonly datos: T;
}

export class ConciliacionNoDisponibleError extends Error {
  constructor() {
    super("La conciliación persistida aún no está disponible en esta base de datos: falta aplicar la migración 021.");
    this.name = "ConciliacionNoDisponibleError";
  }
}
export class ConciliacionSinPermisoError extends Error {
  constructor() {
    super("No tienes permiso sobre este cliente para conciliar.");
    this.name = "ConciliacionSinPermisoError";
  }
}
export class ConciliacionNoEncontradaError extends Error {
  constructor(mensaje = "No encontrado.") {
    super(mensaje);
    this.name = "ConciliacionNoEncontradaError";
  }
}
export class ConciliacionDatosInvalidosError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ConciliacionDatosInvalidosError";
  }
}
export class ConciliacionPeriodoCerradoError extends Error {
  constructor(readonly periodo: string) {
    super(`El periodo ${periodo} ya está cerrado: no se pueden confirmar, aprobar ni deshacer conciliaciones en él. Reabre el periodo primero.`);
    this.name = "ConciliacionPeriodoCerradoError";
  }
}
export class ConciliacionConflictoError extends Error {
  constructor(mensaje = "Ese movimiento ya tiene una conciliación vigente.") {
    super(mensaje);
    this.name = "ConciliacionConflictoError";
  }
}
export class ConciliacionTopeExcedidoError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ConciliacionTopeExcedidoError";
  }
}
/** El cliente pidió confirmar un par que el motor NO propuso al recalcular (y que no se marcó manual). */
export class ParNoPropuestoPorMotorError extends Error {
  constructor(readonly movimientoId: string, readonly invoiceId: string) {
    super("El servidor no reconoce este par: el motor de conciliación no lo propone. Si es una conciliación que decides tú, confírmala como manual.");
    this.name = "ParNoPropuestoPorMotorError";
  }
}

export interface ConciliacionPersistidaRepository {
  /** Crea la sesión con los movimientos guardados del periodo. 404 si no hay movimientos guardados en él. */
  crearSesion(propertyId: string, periodo: string, cuenta: string | null, actorId: string): Promise<{ readonly sesion: SesionConciliacion; readonly movimientos: number }>;
  listarSesiones(propertyId: string, limit: number): Promise<LecturaConciliacion<readonly SesionConResumen[]>>;
  obtenerSesion(propertyId: string, sesionId: string): Promise<LecturaConciliacion<SesionConciliacion | null>>;
  /** Movimientos guardados del periodo (y cuenta, si la sesión la fija) de la sesión. */
  listarMovimientosSesion(sesion: SesionConciliacion): Promise<readonly MovimientoGuardado[]>;
  /** Matches de la sesión (vigentes y deshechos: el historial no se borra). */
  listarMatches(sesionId: string): Promise<readonly MatchConciliacion[]>;
  obtenerMatch(propertyId: string, matchId: string): Promise<MatchConciliacion | null>;
  listarSugerencias(sesionId: string): Promise<readonly SugerenciaConciliacion[]>;
  obtenerSugerencia(propertyId: string, sugerenciaId: string): Promise<SugerenciaConciliacion | null>;
  /** Marca derivada "conciliado": ids de CFDI de la property con al menos un match vigente. Base sin migrar: conjunto vacío. */
  invoiceIdsConciliados(propertyId: string): Promise<LecturaConciliacion<ReadonlySet<string>>>;
  /** Confirma el lote (todo o nada). `actorId` solo lo usa el doble en memoria: Postgres toma auth.uid() y no se puede falsear. */
  confirmarMatches(propertyId: string, sesionId: string, pares: readonly ParConfirmar[], actorId: string): Promise<readonly MatchConciliacion[]>;
  /** IDEMPOTENTE: deshacer un match ya deshecho no cambia nada y devuelve `yaDeshecho: true`. */
  deshacerMatch(propertyId: string, matchId: string, motivo: string, actorId: string): Promise<{ readonly yaDeshecho: boolean }>;
  cerrarSesion(propertyId: string, sesionId: string, actorId: string): Promise<{ readonly yaCerrada: boolean }>;
  /** Guarda como PENDIENTES (nunca crea un match). Devuelve las realmente insertadas (una pendiente por movimiento). */
  guardarSugerencias(propertyId: string, sesionId: string, sugerencias: readonly NuevaSugerencia[], actorId: string): Promise<readonly SugerenciaConciliacion[]>;
  /** Aprobar crea el match `llm_aprobado` (nivel 4) en la misma operación; rechazar solo la marca. */
  resolverSugerencia(propertyId: string, sugerenciaId: string, aprobar: boolean, actorId: string): Promise<{ readonly estado: "aprobada" | "rechazada"; readonly matchId: string | null }>;
}

export const MAX_PARES_POR_CONFIRMACION = 200;
export const MAX_SUGERENCIAS_POR_CORRIDA = 100;
export const PERIODO_RE = /^20[1-9][0-9]-(0[1-9]|1[0-2])$/;

/** `YYYY-MM-DD` -> `YYYY-MM`. */
export function periodoDeFecha(fecha: string): string {
  return fecha.slice(0, 7);
}
