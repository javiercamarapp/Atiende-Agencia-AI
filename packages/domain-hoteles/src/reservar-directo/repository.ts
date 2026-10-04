// Puerto de persistencia de la reserva directa publica (H-42). Todas las operaciones de la reserva publica corren en SESION DE SISTEMA
// (auth.uid() is null, la API publica no tiene usuario); la unica de staff es la lectura del KPI (RLS del hotel). Los errores de regla de
// negocio salen como `ReservasAgenteError` con codigo estable; la base sin la migracion 044 sale como `ReservasAgenteUnavailableError`.
import type { StayOptionsResult } from "../reservas-agente/tipos.ts";
import type { CreateWebHoldInput, PagoEstado, RoomNightsDirectas, WebHoldContext, WebHoldRecord, WebPolicyRecord } from "./tipos.ts";

export interface ReservarDirectoRepository {
  /** Politica del canal web del hotel (fail-closed: sin fila, deshabilitado). `disponible:false` = migracion 044 pendiente. */
  webPolicy(propertyId: string): Promise<WebPolicyRecord>;
  /** Disponibilidad + cotizacion por tipo (agent_stay_options de 037). Vacio honesto sin migrar. */
  stayOptions(propertyId: string, checkInDate: string, checkOutDate: string, now?: Date): Promise<StayOptionsResult>;
  /** Crea (o devuelve, por la misma llave) el hold web. Lanza `ReservasAgenteError` (precio_cambio, sin_disponibilidad, ...). */
  createWebHold(input: CreateWebHoldInput): Promise<WebHoldRecord>;
  /** Solo holds del canal web de ESA property; si no, `no_encontrada`. Vence primero los holds abiertos. */
  getWebHold(propertyId: string, holdId: string, now?: Date): Promise<WebHoldRecord>;
  /** Contexto de presentacion (tipo, estado de la reserva, terminos de cancelacion). null si el hold no es web de esa property. */
  webContext(propertyId: string, holdId: string): Promise<WebHoldContext | null>;
  /** capturado confirma el hold (reserva directo_web); fallido/pendiente solo actualizan el estado de pago. */
  recordPayment(propertyId: string, holdId: string, status: Extract<PagoEstado, "capturado" | "fallido" | "pendiente">, ref: string | null, now?: Date): Promise<WebHoldRecord>;
  /** Cancela un hold abierto o una reserva confirmada aplicando cancellation_policy. Idempotente. */
  cancelWebHold(propertyId: string, holdId: string, now?: Date): Promise<WebHoldRecord>;
  /** La pasarela proceso el reembolso solicitado. */
  markRefunded(propertyId: string, holdId: string, ref: string): Promise<WebHoldRecord>;
  /** KPI (sesion de staff): noches de reservas directo_web vs total en [desde, hasta). */
  roomNightsDirectas(propertyId: string, desde: string, hasta: string): Promise<RoomNightsDirectas>;
}
