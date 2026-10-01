// Puerto de persistencia del agente de reservas (H-25). Separado de `HotelesRepository` (mismo criterio que agentes/grupos).
// Las operaciones "ParaContacto" y las de consulta/creacion del agente corren en SESION DE SISTEMA (auth.uid() is null);
// las de staff (decidir, confirmar, politica, listado) en sesion de usuario: el rol sale de core.membership, nunca de un parametro.
import type { BookingPolicyInput, BookingPolicyResult, CreateHoldInput, HoldListResult, HoldRecord, HoldStatus, StayOptionsResult } from "./tipos.ts";

export interface ReservasAgenteRepository {
  // ---- agente (sistema) ----
  /** Disponibilidad + cotizacion por tipo de cuarto. Vacio honesto (`disponible:false`) sin la migracion 037. */
  stayOptions(propertyId: string, checkInDate: string, checkOutDate: string, now?: Date): Promise<StayOptionsResult>;
  /** Crea (o devuelve, si ya existe por llave o por el mismo contacto/tipo/fechas) el hold. Lanza `ReservasAgenteError`. */
  createHold(input: CreateHoldInput): Promise<HoldRecord>;
  /** Solo con id + telefono del contacto. Lanza `no_encontrada` si no coincide. */
  holdStatusForContact(propertyId: string, holdId: string, contactPhone: string, now?: Date): Promise<HoldRecord>;
  cancelHoldForContact(propertyId: string, holdId: string, contactPhone: string, now?: Date): Promise<HoldRecord>;
  /** Barrido de sistema (sin cron programado). Devuelve cuantos holds vencio. */
  expireDueHolds(propertyId: string | null, now?: Date): Promise<number>;

  // ---- staff (la base valida el rol) ----
  listHolds(propertyId: string, filter?: { readonly status?: HoldStatus; readonly onlyOpen?: boolean }): Promise<HoldListResult>;
  decideHold(propertyId: string, holdId: string, decision: "aprobar" | "rechazar", reason: string): Promise<HoldRecord>;
  registerPaymentLink(propertyId: string, holdId: string, reference: string): Promise<HoldRecord>;
  confirmHold(propertyId: string, holdId: string): Promise<HoldRecord>;
  staffCancelHold(propertyId: string, holdId: string, reason: string): Promise<HoldRecord>;
  getPolicy(propertyId: string): Promise<BookingPolicyResult>;
  upsertPolicy(propertyId: string, input: BookingPolicyInput): Promise<BookingPolicyResult>;
}
