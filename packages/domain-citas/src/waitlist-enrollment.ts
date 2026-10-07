// Puerta de entrada de la LISTA DE ESPERA (QA-citas-R1-agentes-18): hasta ahora `citas.appointment_waitlist` solo se leia y se avisaba (el optimizador y
// el broadcast), pero nada inscribia a nadie, asi que los huecos liberados se ofrecian a una lista siempre vacia.
//
// Esta pieza la usa el PANEL (staff: sesion con RLS de membresia). El alta desde el agente de WhatsApp/voz (sesion de SISTEMA) necesita una funcion
// `security definer` de solo-sistema que NO existe todavia: ver "huecos conocidos" del PR; no se simula aqui.
import { AppointmentNotFoundError, AppointmentValidationError } from "./errors.ts";
import { isUsablePhone, normalizePhone } from "./appointments.ts";
import type { CitasRepository, WaitlistCandidateRow } from "./repository.ts";

export const WAITLIST_TIME_WINDOWS = ["morning", "afternoon", "evening", "any"] as const;
export type WaitlistTimeWindow = (typeof WAITLIST_TIME_WINDOWS)[number];

/** Tope de entradas VIVAS por telefono: evita que un solo cliente (o un error de captura) llene la fila de la que depende el FIFO. */
export const MAX_WAITLIST_ENTRIES_PER_PHONE = 5;

export interface EnrollWaitlistInput {
  readonly organizationId: string;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly providerId?: string | null;
  readonly serviceId?: string | null;
  readonly preferredDateFrom?: string | null;
  readonly preferredDateTo?: string | null;
  readonly preferredTimeWindow?: string | null;
  /** AAAA-MM-DD de hoy en la zona horaria del negocio (la fecha preferida no puede quedar en el pasado). */
  readonly today: string;
}

export interface EnrollWaitlistOutcome {
  readonly entry: WaitlistCandidateRow;
  /** true si el cliente ya estaba en la lista con el mismo proveedor, servicio y fechas: no se duplica. */
  readonly alreadyEnrolled: boolean;
}

function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export async function enrollWaitlistEntry(repo: CitasRepository, input: EnrollWaitlistInput): Promise<EnrollWaitlistOutcome> {
  const name = typeof input.customerName === "string" ? input.customerName.trim() : "";
  if (name.length === 0 || name.length > 160) throw new AppointmentValidationError("customer_name: se esperaba un texto no vacío de hasta 160 caracteres.");
  if (typeof input.customerPhone !== "string" || !isUsablePhone(input.customerPhone)) throw new AppointmentValidationError("customer_phone debe ser un teléfono válido (entre 7 y 15 dígitos)");
  const phone = normalizePhone(input.customerPhone);

  const window = input.preferredTimeWindow ?? "any";
  if (!(WAITLIST_TIME_WINDOWS as readonly string[]).includes(window)) throw new AppointmentValidationError("preferred_time_window: se esperaba morning, afternoon, evening o any.");

  const from = input.preferredDateFrom ?? null;
  const to = input.preferredDateTo ?? null;
  if (from !== null && !validDateOnly(from)) throw new AppointmentValidationError("preferred_date_from: se esperaba una fecha AAAA-MM-DD válida.");
  if (to !== null && !validDateOnly(to)) throw new AppointmentValidationError("preferred_date_to: se esperaba una fecha AAAA-MM-DD válida.");
  if (from !== null && to !== null && to < from) throw new AppointmentValidationError("preferred_date_to no puede ser anterior a preferred_date_from.");
  if ((to ?? from) !== null && (to ?? from)! < input.today) throw new AppointmentValidationError("Las fechas preferidas ya pasaron: elige fechas de hoy en adelante.");

  const providerId = input.providerId ?? null;
  const serviceId = input.serviceId ?? null;
  if (providerId !== null && !(await repo.findProvider(input.organizationId, providerId))) throw new AppointmentNotFoundError("Proveedor no encontrado en este negocio.");
  if (serviceId !== null && !(await repo.findService(input.organizationId, serviceId))) throw new AppointmentNotFoundError("Servicio no encontrado en este negocio.");

  const vivas = (await repo.loadLiveWaitlistCandidates(input.organizationId)).filter((row) => row.customerPhone === phone);
  const repetida = vivas.find((row) => row.providerId === providerId && row.serviceId === serviceId && row.preferredDateFrom === from && row.preferredDateTo === to && row.preferredTimeWindow === window);
  if (repetida) return { entry: repetida, alreadyEnrolled: true };
  if (vivas.length >= MAX_WAITLIST_ENTRIES_PER_PHONE) throw new AppointmentValidationError(`Este teléfono ya tiene ${MAX_WAITLIST_ENTRIES_PER_PHONE} lugares en la lista de espera.`);

  const entry = await repo.insertWaitlistEntry({
    organizationId: input.organizationId,
    customerPhone: phone,
    customerName: name,
    providerId,
    serviceId,
    preferredDateFrom: from,
    preferredDateTo: to,
    preferredTimeWindow: window as WaitlistTimeWindow,
  });
  return { entry, alreadyEnrolled: false };
}
