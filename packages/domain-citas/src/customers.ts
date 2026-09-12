// Fase 2 §2.2 — "CONTEXTO DEL CLIENTE" del prompt del agente de WhatsApp. Mismo
// principio que domain-restaurantes/src/customers.ts::lookupCustomer (memoria real
// de cliente por teléfono, nunca una lista genérica) pero simplificado al dominio de
// citas: sin tier/loyalty (eso es negocio de restaurantes, no aplica aquí) — solo si
// ya se conoce al cliente y sus citas activas/próximas reales, para que el agente
// pueda saludarlo por nombre y ofrecer "reagendar tu cita de mañana" sin inventar
// nada (reutiliza `findAppointmentsForCustomerPhone`, mismo contrato de silencio).
import { findAppointmentsForCustomerPhone, normalizePhone } from "./appointments.ts";
import type { CitasRepository } from "./repository.ts";

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
