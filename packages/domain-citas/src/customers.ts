// Fase 2 §2.2 — "CONTEXTO DEL CLIENTE" del prompt del agente de WhatsApp. Mismo
// principio que domain-restaurantes/src/customers.ts::lookupCustomer (memoria real
// de cliente por teléfono, nunca una lista genérica) pero simplificado al dominio de
// citas: sin tier/loyalty (eso es negocio de restaurantes, no aplica aquí) — solo si
// ya se conoce al cliente y sus citas activas/próximas reales, para que el agente
// pueda saludarlo por nombre y ofrecer "reagendar tu cita de mañana" sin inventar
// nada (reutiliza `findAppointmentsForCustomerPhone`, mismo contrato de silencio).
import { findAppointmentsForCustomerPhone, normalizePhone } from "./appointments.ts";
import { AppointmentNotFoundError, AppointmentValidationError } from "./errors.ts";
import type { CitasRepository } from "./repository.ts";
import type { CustomerRecord } from "./types.ts";

export interface UpcomingAppointmentContext {
  readonly appointmentId: string;
  readonly providerName: string;
  readonly serviceName: string;
  readonly startsAt: string;
}

export interface CitasCustomerContext {
  readonly isNew: boolean;
  readonly fullName: string | null;
  readonly upcomingAppointments: readonly UpcomingAppointmentContext[];
}

/**
 * Reconoce a un cliente por teléfono (normalizado) y arma el contexto real que se
 * inyecta al prompt: nombre guardado (si existe) y sus citas activas/próximas reales
 * con nombre de proveedor/servicio ya resueltos (nunca ids crudos en el prompt). Un
 * teléfono nunca visto -> `{ isNew: true, ... }`, nunca un error.
 */
export async function lookupCitasCustomer(repo: CitasRepository, organizationId: string, phone: string, now: Date = new Date()): Promise<CitasCustomerContext> {
  const customer = await repo.findCustomerByPhone(organizationId, normalizePhone(phone));
  if (!customer) return { isNew: true, fullName: null, upcomingAppointments: [] };

  const { appointments } = await findAppointmentsForCustomerPhone(repo, organizationId, phone, now);
  const upcomingAppointments = await Promise.all(
    appointments.map(async (a) => {
      const [provider, service] = await Promise.all([repo.findProvider(organizationId, a.providerId), repo.findService(organizationId, a.serviceId)]);
      return { appointmentId: a.appointmentId, providerName: provider?.displayName ?? "proveedor", serviceName: service?.name ?? "servicio", startsAt: a.startsAt };
    }),
  );

  return { isNew: false, fullName: customer.fullName, upcomingAppointments };
}

// ============================================================================
// Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — captura/edición del
// correo OPCIONAL de un cliente YA existente desde la ficha de Clientes del
// panel. `citas.customers.email` existe desde Fase 1 (el agente ya lo captura al
// crear una cita, ver `validateCreateAppointmentPayload`/`create_appointment_from_
// panel`) — el hueco real que esto cierra es que, una vez creado el cliente SIN
// correo (el caso normal: voz/WhatsApp solo capturan teléfono), no había forma de
// agregárselo después sin recrear una cita. Relevante para calendar-sync.ts: un
// event type de Cal.com que exige `attendeeEmail` deja la cita en
// `google_sync_status = 'invalid'` hasta que el correo del cliente exista — este
// es el único lugar del panel donde el staff puede resolverlo sin tocar la cita
// misma.
// ============================================================================

const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * `email: null` (o cadena vacía) explícito SIEMPRE quita el correo guardado —
 * nunca es obligatorio, ni aquí ni en ningún otro flujo de este dominio. Un
 * formato inválido lanza `AppointmentValidationError` (400); un `customerId` que
 * no pertenece a `organizationId` lanza `AppointmentNotFoundError` (404) — el
 * repositorio nunca distingue "no existe" de "es de otra organización" (mismo
 * criterio de no-filtración que `findCustomerById`).
 */
export async function updateCustomerEmailFromPanel(repo: CitasRepository, organizationId: string, customerId: string, email: string | null): Promise<CustomerRecord> {
  if (typeof organizationId !== "string" || !organizationId.trim()) throw new AppointmentValidationError("organizationId es requerido");
  if (typeof customerId !== "string" || !customerId.trim()) throw new AppointmentValidationError("customerId es requerido");

  const trimmed = email?.trim() || null;
  if (trimmed !== null && (trimmed.length > 320 || !EMAIL_FORMAT_RE.test(trimmed))) {
    throw new AppointmentValidationError("email: formato inválido");
  }

  const updated = await repo.updateCustomerEmailFromPanel(organizationId, customerId, trimmed);
  if (!updated) throw new AppointmentNotFoundError("Cliente no encontrado");
  return updated;
}
