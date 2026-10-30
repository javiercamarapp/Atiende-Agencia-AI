// Inscripcion en la lista de espera (QA R1 features-12): hasta ahora la lista solo se LEIA (aviso al liberar un horario, broadcast) pero nadie podia
// anotarse: ni el staff desde el panel ni el agente de WhatsApp/voz. Una sola funcion para los tres canales.
//   * Panel (sesion de staff): INSERT directo; lo autoriza la politica de RLS de staff de `citas.appointment_waitlist` (003).
//   * Agente de WhatsApp/voz (`sistema: true`): la sesion de sistema es el rol `authenticated` con `auth.uid()` NULL, SUJETO a RLS (no es service_role ni
//     BYPASSRLS), y la unica politica de la tabla es la de staff, asi que no puede leer ni insertar directo. Usa la funcion `security definer` de
//     solo-sistema `citas.system_enroll_waitlist` (migracion 034). Sin esa migracion, la inscripcion del agente responde "no disponible aun".
import { AppointmentConflictError, AppointmentNotFoundError, AppointmentValidationError } from "./errors.ts";
import type { CitasRepository, WaitlistCandidateRow } from "./repository.ts";

export type FranjaListaEspera = "morning" | "afternoon" | "evening" | "any";
export const FRANJAS_LISTA_ESPERA: readonly FranjaListaEspera[] = ["morning", "afternoon", "evening", "any"];

/** Tope de anotaciones ACTIVAS por telefono: una sola persona no puede llenar la lista de un negocio. */
export const MAX_LISTA_ESPERA_ACTIVAS_POR_TELEFONO = 5;

export interface WaitlistEnrollmentPayload {
  readonly organizationId: string;
  readonly customerPhone: string;
  readonly customerName?: string | null;
  /** Sucursal de la ruta del panel: si viene, el proveedor debe ser de esa sucursal (misma regla que el alta de citas del panel). */
  readonly propertyId?: string | null;
  readonly providerId?: string | null;
  readonly serviceId?: string | null;
  /** YYYY-MM-DD, dia civil del negocio. */
  readonly preferredDateFrom?: string | null;
  readonly preferredDateTo?: string | null;
  readonly preferredTimeWindow?: string | null;
}

export interface NewWaitlistEntryInput {
  readonly organizationId: string;
  readonly customerPhone: string;
  readonly customerName: string | null;
  readonly providerId: string | null;
  readonly serviceId: string | null;
  readonly preferredDateFrom: string | null;
  readonly preferredDateTo: string | null;
  readonly preferredTimeWindow: FranjaListaEspera;
}

export type InsertWaitlistResult =
  | { readonly outcome: "created"; readonly entry: WaitlistCandidateRow }
  | { readonly outcome: "already_waiting"; readonly entry: WaitlistCandidateRow }
  | { readonly outcome: "too_many" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fechaValida(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function opcional(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export interface WaitlistEnrollment {
  readonly created: boolean;
  readonly entry: WaitlistCandidateRow;
}

/** Anota a un cliente en la lista de espera (o devuelve su anotacion vigente identica: reintentar no duplica). */
export async function enrollInWaitlist(repo: CitasRepository, raw: WaitlistEnrollmentPayload, opciones: { readonly sistema?: boolean } = {}): Promise<WaitlistEnrollment> {
  const phone = typeof raw.customerPhone === "string" ? raw.customerPhone.trim() : "";
  if (!raw.organizationId?.trim() || !phone || phone.length > 32) throw new AppointmentValidationError("customer_phone es requerido (máximo 32 caracteres).");
  const name = opcional(raw.customerName);
  if (name !== null && name.length > 160) throw new AppointmentValidationError("customer_name admite máximo 160 caracteres.");
  const providerId = opcional(raw.providerId);
  const serviceId = opcional(raw.serviceId);
  const from = opcional(raw.preferredDateFrom);
  const to = opcional(raw.preferredDateTo);
  const franja = opcional(raw.preferredTimeWindow) ?? "any";
  if ([phone, name, providerId, serviceId, from, to, franja].some((v) => typeof v === "string" && v.includes("\u0000"))) {
    throw new AppointmentValidationError("Los textos no pueden contener caracteres de control nulos.");
  }
  if (!(FRANJAS_LISTA_ESPERA as readonly string[]).includes(franja)) throw new AppointmentValidationError("preferred_time_window debe ser morning, afternoon, evening o any.");
  if (from !== null && !fechaValida(from)) throw new AppointmentValidationError("preferred_date_from debe ser una fecha YYYY-MM-DD válida.");
  if (to !== null && !fechaValida(to)) throw new AppointmentValidationError("preferred_date_to debe ser una fecha YYYY-MM-DD válida.");
  if (from !== null && to !== null && to < from) throw new AppointmentValidationError("preferred_date_to no puede ser anterior a preferred_date_from.");
  // Un id que no es UUID nunca llega a Postgres (22P02 abortaria la transaccion compartida del turno).
  if (providerId !== null && !UUID_RE.test(providerId)) throw new AppointmentNotFoundError("Proveedor no encontrado.");
  if (serviceId !== null && !UUID_RE.test(serviceId)) throw new AppointmentNotFoundError("Servicio no encontrado.");
  if (providerId !== null) {
    const provider = await repo.findProvider(raw.organizationId, providerId);
    if (!provider) throw new AppointmentNotFoundError("Proveedor no encontrado.");
    if (raw.propertyId && provider.propertyId !== null && provider.propertyId !== raw.propertyId) {
      throw new AppointmentValidationError("provider_id: ese proveedor no pertenece a esta sucursal.");
    }
  }
  if (serviceId !== null && !(await repo.findService(raw.organizationId, serviceId))) throw new AppointmentNotFoundError("Servicio no encontrado.");

  const entrada: NewWaitlistEntryInput = { organizationId: raw.organizationId, customerPhone: phone, customerName: name, providerId, serviceId, preferredDateFrom: from, preferredDateTo: to, preferredTimeWindow: franja as FranjaListaEspera };
  const result = opciones.sistema
    ? await repo.insertWaitlistEntryAsSystem(entrada, MAX_LISTA_ESPERA_ACTIVAS_POR_TELEFONO)
    : await repo.insertWaitlistEntry(entrada, MAX_LISTA_ESPERA_ACTIVAS_POR_TELEFONO);
  if (result.outcome === "unavailable") {
    throw new AppointmentConflictError("La lista de espera automática aún no está disponible en este negocio. Ofrece otro horario o pasa a la persona con alguien del equipo.");
  }
  if (result.outcome === "too_many") {
    throw new AppointmentConflictError(`Este número ya tiene ${MAX_LISTA_ESPERA_ACTIVAS_POR_TELEFONO} anotaciones activas en la lista de espera. Espera a que se atienda alguna.`);
  }
  return { created: result.outcome === "created", entry: result.entry };
}
