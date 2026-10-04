// Mundo del simulador de llamadas de CITAS: un consultorio sembrado en el repositorio en memoria, con el MOTOR REAL de agenda (`queryAvailability`,
// `createAppointment`, `cancelAppointment`, `rescheduleAppointment`...) y la guardia de crisis activa (rubro de salud). Datos de prueba (negocio,
// proveedores, horarios, fechas inventados para el arnes); no se usan en ningun entorno real. Las fechas son de 2031 para que ninguna caiga en el pasado
// del reloj real. Hay DOS clientes: el llamante (con una cita sembrada) y otro cliente cuya cita jamas debe tocarse.
import { randomUUID } from "node:crypto";
import { zonedTimeToUtc } from "../../availability.ts";
import { InMemoryCitasRepository } from "../../in-memory-repository.ts";
import type { AppointmentRecord } from "../../types.ts";

export const ZONA_SIM = "America/Merida";
export const NOMBRE_NEGOCIO_SIM = "Clínica Casa Verde";
export const TELEFONO_LLAMANTE = "9991230000";
export const SIP_FROM_LLAMANTE = `"Paciente" <sip:+52${TELEFONO_LLAMANTE}@trunk.sim.invalid;user=phone>;tag=sim`;
export const TELEFONO_OTRO_CLIENTE = "5512345678";
export const TELEFONO_AVISOS = "+5219990001111";
/** Jueves; viernes; sabado (sin horario); lunes de la cita sembrada; martes; miercoles de la cita del otro cliente. */
export const DIA_JUEVES = "2031-06-12";
export const DIA_VIERNES = "2031-06-13";
export const DIA_SABADO = "2031-06-14";
export const DIA_LUNES = "2031-06-16";
export const DIA_MARTES = "2031-06-17";
export const DIA_MIERCOLES = "2031-06-18";

/** ISO UTC de un dia y hora locales del negocio. */
export function inicioLocal(dia: string, hora: string): string {
  return zonedTimeToUtc(dia, hora, ZONA_SIM).toISOString();
}

export interface MundoVozCitas {
  readonly repo: InMemoryCitasRepository;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly slug: string;
  /** Rubro del negocio (`citas.tenant_config.rubro`): decide si la guardia de crisis aplica. */
  readonly rubro: string;
  readonly servicios: { readonly valoracion: string; readonly seguimiento: string };
  readonly proveedores: { readonly lucia: string; readonly mario: string };
  readonly citaSembradaId: string;
  readonly citaOtroClienteId: string;
  /** Se resuelve cuando termino de sembrarse (los clientes se crean con el repositorio, que es asincrono). */
  readonly listo: Promise<void>;
  /** Citas con origen `voice` que dejo la llamada (cualquier estado). */
  citasVoz(): Promise<readonly AppointmentRecord[]>;
  cita(id: string): Promise<AppointmentRecord | undefined>;
}

export function crearMundoVozCitas(): MundoVozCitas {
  const repo = new InMemoryCitasRepository();
  const organizationId = randomUUID();
  const slug = "clinica-casa-verde";
  repo.seedOrganization({ id: organizationId, slug, name: NOMBRE_NEGOCIO_SIM, defaultTimezone: ZONA_SIM });
  repo.seedTenantConfig({ organizationId, rubro: "psicologo", defaultTimezone: ZONA_SIM, ownerNotificationPhone: TELEFONO_AVISOS });
  repo.seedWhatsAppConfig(organizationId, "1234567890");

  const lucia = randomUUID();
  const mario = randomUUID();
  repo.seedProvider({ id: lucia, organizationId, propertyId: null, displayName: "Dra. Lucía Pech", roleLabel: "Psicóloga", isActive: true });
  repo.seedProvider({ id: mario, organizationId, propertyId: null, displayName: "Dr. Mario Canul", roleLabel: "Psicólogo", isActive: true });
  const valoracion = randomUUID();
  const seguimiento = randomUUID();
  repo.seedService({ id: valoracion, organizationId, name: "Consulta de valoración", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: 90000, isActive: true });
  repo.seedService({ id: seguimiento, organizationId, name: "Sesión de seguimiento", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: 70000, isActive: true });
  for (const p of [lucia, mario]) {
    repo.seedProviderService(p, valoracion);
    repo.seedProviderService(p, seguimiento);
    // Lunes (1) a viernes (5), 9:00-17:00 hora de Merida. El sabado no hay horario.
    for (const dayOfWeek of [1, 2, 3, 4, 5]) repo.seedAvailabilityRule({ id: randomUUID(), providerId: p, dayOfWeek, startTime: "09:00", endTime: "17:00", isActive: true });
  }

  const citaSembradaId = randomUUID();
  const citaOtroClienteId = randomUUID();
  const sembrar = async (): Promise<void> => {
    const llamante = await repo.upsertCustomer(organizationId, TELEFONO_LLAMANTE, "Ana Pech");
    const otro = await repo.upsertCustomer(organizationId, TELEFONO_OTRO_CLIENTE, "Otro Cliente");
    const base = { organizationId, propertyId: null, providerId: lucia, serviceId: valoracion, status: "confirmed" as const, source: "manual" as const, notes: null, dedupeFingerprint: null, idempotencyKey: null, reminder24hSentAt: null, createdAt: "2031-01-01T00:00:00.000Z", googleEventId: null, googleSyncStatus: "skipped" as const, googleSyncAttempts: 0, googleSyncNextRetryAt: null, googleSyncError: null };
    const cita = (id: string, customerId: string, dia: string, hora: string, fin: string): AppointmentRecord => ({ ...base, id, customerId, startsAt: inicioLocal(dia, hora), endsAt: inicioLocal(dia, fin) });
    repo.seedAppointment(cita(citaSembradaId, llamante.id, DIA_LUNES, "10:00", "10:30"));
    repo.seedAppointment({ ...cita(citaOtroClienteId, otro.id, DIA_MIERCOLES, "12:00", "12:30"), providerId: mario, serviceId: seguimiento });
  };

  const rango = ["2031-06-01T00:00:00.000Z", "2031-07-01T00:00:00.000Z"] as const;
  return {
    repo,
    organizationId,
    propertyId: randomUUID(),
    slug,
    rubro: "psicologo",
    servicios: { valoracion, seguimiento },
    proveedores: { lucia, mario },
    citaSembradaId,
    citaOtroClienteId,
    listo: sembrar(),
    async citasVoz() {
      return (await repo.listAppointmentsInRange(organizationId, rango[0], rango[1], undefined, 200)).filter((a) => a.source === "voice");
    },
    async cita(id) {
      return (await repo.listAppointmentsInRange(organizationId, rango[0], rango[1], undefined, 200)).find((a) => a.id === id);
    },
  };
}
