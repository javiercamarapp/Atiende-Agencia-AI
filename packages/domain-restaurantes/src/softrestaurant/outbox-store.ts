// Puerto de persistencia del outbox de comandas y de la bandera por organizacion.
// Dos implementaciones: en memoria (pruebas, rutas de prueba) y Postgres
// (`PostgresComandaOutboxStore`, migracion 024). El servicio solo habla con esta
// interfaz.
import type { DecisionTransicion, EstadoComanda } from "./outbox-state.ts";
import type { ComandaInput } from "./types.ts";

export const MODOS_SOFTRESTAURANT = ["apagado", "sombra", "activo"] as const;
export type ModoSoftRestaurant = (typeof MODOS_SOFTRESTAURANT)[number];

export function esModoSoftRestaurant(value: unknown): value is ModoSoftRestaurant {
  return typeof value === "string" && (MODOS_SOFTRESTAURANT as readonly string[]).includes(value);
}

/** Modos en los que SI se encola una comanda. */
export type ModoEncolado = Exclude<ModoSoftRestaurant, "apagado">;

export interface FilaComandaOutbox {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly orderId: string;
  readonly estado: EstadoComanda;
  readonly modo: ModoEncolado;
  readonly payload: ComandaInput;
  readonly intentos: number;
  readonly maxIntentos: number;
  /** ISO 8601. */
  readonly proximoIntentoEn: string;
  readonly folio: string | null;
  readonly ultimoError: string | null;
  readonly capturadoPor: string | null;
  readonly capturadoEn: string | null;
  readonly notaCaptura: string | null;
  readonly creadoEn: string;
  readonly actualizadoEn: string;
}

export interface EntradaEncolar {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly orderId: string;
  readonly idempotencyKey: string;
  readonly modo: ModoEncolado;
  readonly payload: ComandaInput;
  readonly maxIntentos: number;
}

/** `disponible: false` = la base aun no tiene la migracion 024 (vacio honesto, nunca un error). */
export type ResultadoEncolar = { readonly disponible: true; readonly fila: FilaComandaOutbox } | { readonly disponible: false };

export interface FiltroListarComandas {
  /** null = toda la organizacion. */
  readonly propertyIds: readonly string[] | null;
  readonly estados?: readonly EstadoComanda[];
  readonly limite: number;
  readonly offset: number;
}

export type ResultadoListar = { readonly disponible: true; readonly filas: readonly FilaComandaOutbox[] } | { readonly disponible: false; readonly filas: readonly [] };

export type ResumenComandas =
  | { readonly disponible: true; readonly porEstado: Readonly<Record<EstadoComanda, number>> }
  | { readonly disponible: false; readonly porEstado: Readonly<Record<EstadoComanda, number>> };

export type ResultadoCaptura =
  | { readonly resultado: "ok"; readonly fila: FilaComandaOutbox }
  | { readonly resultado: "no_encontrada" }
  | { readonly resultado: "estado_invalido" }
  | { readonly resultado: "prohibido" }
  | { readonly resultado: "no_disponible" };

export interface ComandaOutboxStore {
  /** Modo efectivo. Sin fila, sin migracion o ante cualquier error de compatibilidad => "apagado". */
  leerModo(organizationId: string): Promise<ModoSoftRestaurant>;
  /** Solo owner/admin (lo exige la base). `false` = la base no tiene la migracion. */
  fijarModo(organizationId: string, modo: ModoSoftRestaurant): Promise<{ readonly disponible: boolean }>;

  /** Solo sistema. Idempotente por pedido: reencolar devuelve la fila existente. */
  encolar(entrada: EntradaEncolar): Promise<ResultadoEncolar>;
  /** Solo sistema. Reclama (pasa a `enviada`, intentos+1) UNA fila concreta si esta lista; null si no. */
  reclamarPorId(id: string, ahora: Date, leaseMs: number): Promise<FilaComandaOutbox | null>;
  /** Solo sistema. Reclama hasta `limite` filas listas de cualquier organizacion con modo != apagado. */
  reclamarLote(limite: number, ahora: Date, leaseMs: number): Promise<readonly FilaComandaOutbox[]>;
  /** Solo sistema. Cierra un intento; false si la fila ya no estaba `enviada`. */
  completar(id: string, decision: DecisionTransicion): Promise<boolean>;

  listar(organizationId: string, filtro: FiltroListarComandas): Promise<ResultadoListar>;
  resumen(organizationId: string, propertyIds: readonly string[] | null): Promise<ResumenComandas>;
  /** Staff. Detiene los reintentos automaticos de esa comanda. */
  marcarCapturada(organizationId: string, id: string, actorUserId: string, nota: string | null): Promise<ResultadoCaptura>;
}

export function resumenVacio(): Record<EstadoComanda, number> {
  return { pendiente: 0, enviada: 0, confirmada: 0, fallida: 0, captura_manual: 0, capturada_manual: 0 };
}
