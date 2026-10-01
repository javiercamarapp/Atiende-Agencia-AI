// C-06 -- checklist de onboarding de un negocio de citas. TODO el estado se DERIVA en el servidor de tablas que ya
// existen (proveedores, servicios, provider_services, availability_rules, whatsapp_config, whatsapp_message_config,
// appointments): no hay tabla nueva ni migracion, y el cliente nunca decide si un paso esta completo.
//
// Dos usos del mismo calculo:
//  * `computeOnboardingChecklist` -- el panel "Primeros pasos" (owner/admin): 9 pasos con estado, progreso y enlace.
//  * `evaluarReservaPublica` -- la puerta de la reserva publica (POST /v1/citas/:orgSlug/appointments, canal web): solo
//    mira el MINIMO sin el cual ninguna reserva puede salir bien (proveedor activo que ofrece un servicio activo y tiene
//    horario semanal). Es exactamente lo que `createAppointment` ya exige, asi que la puerta nunca cierra un flujo que
//    hoy funciona: solo adelanta un mensaje claro en vez de un error de validacion a medias.
//
// Compatibilidad con la base sin migrar: solo lee tablas de 001/003; la unica lectura de una migracion posterior
// (mensajes de WhatsApp, 026) ya degrada con SAVEPOINT en el repositorio (`disponible: false`) y aqui se traduce a un
// paso `no_disponible` en vez de un error.
import type { CitasRepository } from "./repository.ts";
import type { ProviderRecord } from "./types.ts";

export type PasoOnboardingId =
  | "proveedor"
  | "servicio"
  | "asignacion"
  | "horario"
  | "precio"
  | "whatsapp"
  | "recordatorios"
  | "cancelacion"
  | "cita_prueba";

export type PasoOnboardingEstado = "completo" | "pendiente" | "no_disponible";

export interface PasoOnboarding {
  readonly id: PasoOnboardingId;
  readonly titulo: string;
  readonly descripcion: string;
  readonly estado: PasoOnboardingEstado;
  /** true = sin este paso la reserva publica no puede recibir citas (no se puede descartar ni posponer). */
  readonly requeridoParaPublicar: boolean;
  /** Dato real que explica el estado ("2 servicios sin precio"), o null. */
  readonly detalle: string | null;
  /** Subruta del panel (`/citas/<org>/<ruta>`) donde se resuelve el paso. */
  readonly ruta: string;
}

export interface ChecklistOnboarding {
  readonly propertyId: string;
  readonly pasos: readonly PasoOnboarding[];
  readonly completados: number;
  readonly total: number;
  readonly progresoPct: number;
  /** Pasos requeridos que faltan (vacio = el negocio ya puede recibir reservas publicas). */
  readonly faltanParaPublicar: readonly PasoOnboardingId[];
  readonly listoParaRecibirCitas: boolean;
}

export interface ReservaPublicaEvaluacion {
  readonly lista: boolean;
  readonly faltan: readonly PasoOnboardingId[];
}

/** Topes para que un negocio con catalogo enorme nunca convierta una lectura en un barrido. */
const MAX_SERVICIOS_REVISADOS = 25;
const MAX_PROVEEDORES_REVISADOS = 25;

const TODO_EL_TIEMPO_DESDE = "1970-01-01T00:00:00.000Z";
const TODO_EL_TIEMPO_HASTA = "2100-01-01T00:00:00.000Z";

interface Hechos {
  readonly proveedores: readonly ProviderRecord[];
  readonly serviciosActivos: number;
  readonly serviciosSinPrecio: number;
  readonly hayAsignacion: boolean;
  readonly hayHorario: boolean;
  /** Un proveedor activo ofrece un servicio activo Y tiene horario: la reserva puede salir bien. */
  readonly reservable: boolean;
}

/**
 * Lee lo minimo del catalogo. `propertyId = null` = todo el negocio (puerta publica); un id = solo los proveedores de
 * esa sucursal o sin sucursal asignada (un proveedor sin sucursal atiende en todas, mismo criterio que la Agenda).
 * Con `corte: true` se detiene en cuanto encuentra una combinacion reservable (la puerta no necesita mas).
 */
async function recolectarHechos(repo: CitasRepository, organizationId: string, propertyId: string | null, corte: boolean): Promise<Hechos> {
  const [todosProveedores, servicios] = await Promise.all([repo.listActiveProviders(organizationId), repo.listActiveServices(organizationId)]);
  const proveedores = todosProveedores.filter((p) => propertyId === null || p.propertyId === null || p.propertyId === propertyId);
  const idsEnAlcance = new Set(proveedores.map((p) => p.id));

  const conHorario = new Map<string, boolean>();
  const tieneHorario = async (p: ProviderRecord): Promise<boolean> => {
    const cached = conHorario.get(p.id);
    if (cached !== undefined) return cached;
    const reglas = await repo.loadAvailabilityRules(p.id);
    const r = reglas.some((x) => x.isActive);
    conHorario.set(p.id, r);
    return r;
  };

  let hayAsignacion = false;
  let reservable = false;
  if (proveedores.length > 0) {
    for (const s of servicios.slice(0, MAX_SERVICIOS_REVISADOS)) {
      const ofrecen = (await repo.listActiveProviders(organizationId, s.id)).filter((p) => idsEnAlcance.has(p.id));
      if (ofrecen.length > 0) hayAsignacion = true;
      for (const p of ofrecen.slice(0, MAX_PROVEEDORES_REVISADOS)) {
        if (await tieneHorario(p)) {
          reservable = true;
          break;
        }
      }
      if (reservable && corte) break;
    }
  }

  // "Horario semanal" tambien cuenta aunque ese proveedor todavia no ofrezca ningun servicio: el paso se resuelve en
  // Disponibilidad, independiente de la asignacion.
  let hayHorario = reservable;
  if (!hayHorario && !corte) {
    for (const p of proveedores.slice(0, MAX_PROVEEDORES_REVISADOS)) {
      if (await tieneHorario(p)) {
        hayHorario = true;
        break;
      }
    }
  }

  return {
    proveedores,
    serviciosActivos: servicios.length,
    serviciosSinPrecio: servicios.filter((s) => s.priceCents === null).length,
    hayAsignacion,
    hayHorario,
    reservable,
  };
}

function faltantesRequeridos(h: Hechos): PasoOnboardingId[] {
  const faltan: PasoOnboardingId[] = [];
  if (h.proveedores.length === 0) faltan.push("proveedor");
  if (h.serviciosActivos === 0) faltan.push("servicio");
  // Si el minimo combinado ya se cumple, ningun paso requerido falta (incluso si hay proveedores sueltos sin horario).
  if (h.reservable) return [];
  if (h.proveedores.length > 0 && h.serviciosActivos > 0 && !h.hayAsignacion) faltan.push("asignacion");
  if (h.proveedores.length > 0 && !h.hayHorario) faltan.push("horario");
  // Hay proveedor, servicio, asignacion y horario pero en proveedores distintos: lo que falta es el horario del que atiende.
  if (faltan.length === 0) faltan.push("horario");
  return faltan;
}

/** Puerta de la reserva publica: solo el minimo, con corte temprano (tipicamente 3-4 consultas). */
export async function evaluarReservaPublica(repo: CitasRepository, organizationId: string): Promise<ReservaPublicaEvaluacion> {
  const h = await recolectarHechos(repo, organizationId, null, true);
  const faltan = faltantesRequeridos(h);
  return { lista: faltan.length === 0, faltan };
}

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

export async function computeOnboardingChecklist(repo: CitasRepository, organizationId: string, propertyId: string): Promise<ChecklistOnboarding> {
  const h = await recolectarHechos(repo, organizationId, propertyId, false);
  const faltan = new Set(faltantesRequeridos(h));

  const [numeroWhatsapp, config, citas] = await Promise.all([
    repo.resolveActiveWhatsAppPhoneNumberId(organizationId),
    repo.getWhatsappMessageConfig(organizationId),
    repo.listAppointmentsInRange(organizationId, TODO_EL_TIEMPO_DESDE, TODO_EL_TIEMPO_HASTA, undefined, 1),
  ]);
  const whatsappListo = numeroWhatsapp !== null;
  // Sin fila guardada rigen los valores de fabrica (recordatorio activo, 24 h antes) -- igual que el cron real.
  const recordatorioActivo = config.record ? config.record.config.reminderEnabled : true;
  const anticipacion = config.record ? config.record.config.reminderLeadHours : 24;

  const pasos: PasoOnboarding[] = [
    {
      id: "proveedor",
      titulo: "Crea al menos un profesional",
      descripcion: "Quien atiende las citas: tu primer proveedor activo en esta sucursal.",
      estado: h.proveedores.length > 0 ? "completo" : "pendiente",
      requeridoParaPublicar: true,
      detalle: h.proveedores.length > 0 ? plural(h.proveedores.length, "proveedor activo", "proveedores activos") : null,
      ruta: "proveedores",
    },
    {
      id: "servicio",
      titulo: "Crea un servicio con su duración",
      descripcion: "Qué ofreces y cuánto dura cada cita.",
      estado: h.serviciosActivos > 0 ? "completo" : "pendiente",
      requeridoParaPublicar: true,
      detalle: h.serviciosActivos > 0 ? plural(h.serviciosActivos, "servicio activo", "servicios activos") : null,
      ruta: "servicios",
    },
    {
      id: "asignacion",
      titulo: "Asigna un servicio a un profesional",
      descripcion: "Un profesional tiene que ofrecer el servicio para que se pueda reservar.",
      estado: h.hayAsignacion ? "completo" : "pendiente",
      requeridoParaPublicar: true,
      detalle: null,
      ruta: "proveedores",
    },
    {
      id: "horario",
      titulo: "Define el horario semanal",
      descripcion: "Los días y horas en que el profesional recibe citas.",
      estado: h.hayHorario ? "completo" : "pendiente",
      requeridoParaPublicar: true,
      detalle: null,
      ruta: "disponibilidad",
    },
    {
      id: "precio",
      titulo: "Ponle precio a tus servicios",
      descripcion: "Opcional para reservar, pero tus clientes y el agente lo mencionan al agendar.",
      estado: h.serviciosActivos > 0 && h.serviciosSinPrecio === 0 ? "completo" : "pendiente",
      requeridoParaPublicar: false,
      detalle: h.serviciosSinPrecio > 0 ? plural(h.serviciosSinPrecio, "servicio sin precio", "servicios sin precio") : null,
      ruta: "servicios",
    },
    {
      id: "whatsapp",
      titulo: "Conecta tu número de WhatsApp",
      descripcion: "Por ahí el agente atiende a tus clientes y salen los avisos.",
      estado: whatsappListo ? "completo" : "pendiente",
      requeridoParaPublicar: false,
      detalle: null,
      ruta: "mensajes-whatsapp",
    },
    {
      id: "recordatorios",
      titulo: "Activa los recordatorios de cita",
      descripcion: "Un aviso antes de la cita baja las inasistencias. Necesita WhatsApp conectado.",
      estado: whatsappListo && recordatorioActivo ? "completo" : "pendiente",
      requeridoParaPublicar: false,
      detalle: !whatsappListo ? "Falta conectar WhatsApp" : !recordatorioActivo ? "Los recordatorios están apagados" : `Salen ${anticipacion} h antes de la cita`,
      ruta: "mensajes-whatsapp",
    },
    {
      id: "cancelacion",
      titulo: "Avisa al cliente cuando se cancela una cita",
      descripcion: "Activa el mensaje de cancelación de WhatsApp para dejar claro qué pasó con la cita.",
      estado: !config.disponible ? "no_disponible" : config.record?.config.cancellationEnabled ? "completo" : "pendiente",
      requeridoParaPublicar: false,
      detalle: !config.disponible ? "Disponible cuando se actualice la base de datos" : null,
      ruta: "mensajes-whatsapp",
    },
    {
      id: "cita_prueba",
      titulo: "Registra una primera cita de prueba",
      descripcion: "Crea una cita desde la Agenda para comprobar el flujo completo.",
      estado: citas.length > 0 ? "completo" : "pendiente",
      requeridoParaPublicar: false,
      detalle: null,
      ruta: "agenda",
    },
  ];

  // Un paso requerido nunca se muestra "completo" si la combinacion minima no existe (p. ej. horario en otro proveedor).
  const pasosFinal = pasos.map((p) =>
    p.requeridoParaPublicar && faltan.has(p.id) && p.estado === "completo"
      ? { ...p, estado: "pendiente" as const, detalle: "El horario debe ser el de un profesional que ofrezca un servicio" }
      : p,
  );
  const completadosFinal = pasosFinal.filter((p) => p.estado === "completo").length;
  const faltanParaPublicar = pasosFinal.filter((p) => p.requeridoParaPublicar && p.estado !== "completo").map((p) => p.id);

  return {
    propertyId,
    pasos: pasosFinal,
    completados: completadosFinal,
    total: pasosFinal.length,
    progresoPct: Math.round((completadosFinal / pasosFinal.length) * 100),
    faltanParaPublicar,
    listoParaRecibirCitas: faltanParaPublicar.length === 0,
  };
}
