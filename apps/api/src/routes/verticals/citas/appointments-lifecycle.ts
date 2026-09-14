// Flujo 2 — gestión de cita existente: cancelar + reagendar + modificar (Fase 4) +
// confirmar/completar/no-show (Fase 7). Distintas entradas de autenticación, como
// en el origen (ver diseño Fase 1 citas §5.2) y como Fase 4/7 extienden el mismo
// criterio:
//
//   POST /v1/citas/:orgSlug/appointments/:appointmentId/cancel            (agente, x-atiende-tool-secret)
//   POST /v1/citas/:orgSlug/appointments/:appointmentId/reschedule        (agente, x-atiende-tool-secret)
//   POST /v1/citas/:orgSlug/appointments/:appointmentId/reassign          (agente, x-atiende-tool-secret) — Fase 4
//   POST /v1/citas/properties/:propertyId/appointments/:appointmentId/cancel    (staff panel, JWT)
//   POST /v1/citas/properties/:propertyId/appointments/:appointmentId/confirm   (staff panel, JWT) — Fase 7
//   POST /v1/citas/properties/:propertyId/appointments/:appointmentId/complete  (staff panel, JWT) — Fase 7
//   POST /v1/citas/properties/:propertyId/appointments/:appointmentId/no-show   (staff panel, JWT) — Fase 7
//
// Las 4 rutas de staff SÍ ejercitan requirePropertyMembership("propertyId") de
// core-auth — SIN allowedRoles (el origen no restringe por rol quién opera el
// panel, ver domain-citas/src/roles.ts). El panel no tiene botón de reagendar ni
// de reasignar en el origen — solo el agente ejecuta esas dos hoy; confirmar/
// completar/no-show, al revés, son acciones SOLO del panel (el agente de voz/
// WhatsApp nunca las ejecuta — ver AgendaSection.tsx del repo original, único
// lugar que las tenía: confirmarCita/completarCita + update directo a no_show).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  AppointmentAlternativesError,
  AppointmentConflictError,
  AppointmentNotFoundError,
  AppointmentValidationError,
  cancelAppointment,
  cancelAppointmentFromPanel,
  completeAppointmentFromPanel,
  confirmAppointmentFromPanel,
  consumeRateLimit,
  markAppointmentNoShowFromPanel,
  notifyWaitlistAfterReschedule,
  reassignAppointment,
  rescheduleAppointment,
  tryEnqueueAppointmentEmail,
  tryNotifyWaitlistOfFreedSlot,
  tryTriggerGoogleSync,
} from "@atiende/domain-citas";
import type { AppointmentRecord, CitasRepository } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor, secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface RescheduleBody {
  readonly new_starts_at?: unknown;
  readonly actor_channel?: unknown;
  readonly actor_note?: unknown;
}

interface ReassignBody {
  readonly new_provider_id?: unknown;
  readonly new_service_id?: unknown;
  readonly actor_channel?: unknown;
  readonly actor_note?: unknown;
}

function serializeAppointment(appointment: AppointmentRecord) {
  return {
    id: appointment.id,
    organization_id: appointment.organizationId,
    property_id: appointment.propertyId,
    provider_id: appointment.providerId,
    service_id: appointment.serviceId,
    customer_id: appointment.customerId,
    starts_at: appointment.startsAt,
    ends_at: appointment.endsAt,
    status: appointment.status,
    source: appointment.source,
    notes: appointment.notes,
    created_at: appointment.createdAt,
  };
}

async function resolveOrganizationOrNotFound(citasRepo: CitasRepository, orgSlug: string) {
  const org = await citasRepo.findOrganizationBySlug(orgSlug);
  if (!org || !org.isActive) throw Errors.notFound(`Negocio "${orgSlug}" no encontrado o inactivo.`);
  return org;
}

/** Best-effort: nunca bloquea la respuesta de cancelar/reagendar si falla. */
async function tryNotifyWaitlistAndEmail(citasRepo: CitasRepository, organizationId: string, providerId: string, serviceId: string, previousStartsAt: string, newStartsAt: string, appointmentId: string) {
  try {
    const provider = await citasRepo.findProvider(organizationId, providerId);
    const timeZone = await citasRepo.findPropertyTimezone(provider?.propertyId ?? null, organizationId);
    await notifyWaitlistAfterReschedule(citasRepo, organizationId, timeZone, { providerId, serviceId, previousStartsAt, newStartsAt });
  } catch (err) {
    console.error("citas: notifyWaitlistAfterReschedule best-effort falló:", err);
  }
  // Fase 6 §3 — arma el correo real (to/subject/html) a partir de la cita ya
  // reagendada; ya es best-effort internamente (tryEnqueueAppointmentEmail).
  await tryEnqueueAppointmentEmail(citasRepo, organizationId, "appointment.rescheduled", appointmentId, { previousStartsAt });
}

/** Best-effort: cancelar SIEMPRE libera el horario de la cita — a diferencia de
 * reagendar (donde solo se libera si el nuevo horario es distinto del viejo). */
async function tryNotifyWaitlistAfterCancel(citasRepo: CitasRepository, organizationId: string, appointment: AppointmentRecord) {
  try {
    const provider = await citasRepo.findProvider(organizationId, appointment.providerId);
    const timeZone = await citasRepo.findPropertyTimezone(provider?.propertyId ?? null, organizationId);
    await tryNotifyWaitlistOfFreedSlot(citasRepo, organizationId, timeZone, { providerId: appointment.providerId, serviceId: appointment.serviceId, startsAt: appointment.startsAt });
  } catch (err) {
    console.error("citas: aviso de lista de espera tras cancelar falló (best-effort):", err);
  }
}

/**
 * A diferencia de los demás errores de negocio (mapeados a {code,message} genérico
 * por el onError global de app.ts, ver Errors.*), un conflicto de disponibilidad con
 * alternativas necesita un body enriquecido — `{ error, alternative_slots }`, ver
 * diseño Fase 1 citas §5.2 — así que se responde aquí directamente en vez de lanzar
 * un ApiError genérico que perdería esas alternativas.
 */
function mapErrorToHttp(err: unknown, c: Context): Response {
  if (err instanceof AppointmentAlternativesError) {
    return c.json({ error: err.message, alternative_slots: err.alternativeSlots.map((s) => ({ starts_at: s.startsAt, ends_at: s.endsAt })) }, 409);
  }
  if (err instanceof AppointmentNotFoundError) throw Errors.notFound(err.message);
  if (err instanceof AppointmentConflictError) throw Errors.conflict(err.message);
  if (err instanceof AppointmentValidationError) throw Errors.validation(err.message);
  throw err;
}

export function citasAppointmentsLifecycleRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  // ---- Agente (voz/WhatsApp): cancelar ----
  // Rutas del agente: sin authMiddleware/dbSession montado (guard por
  // x-atiende-tool-secret, ver cabecera del archivo) -- abren su propia sesión de
  // sistema (`userId: null`), igual que documenta postgres-repository.ts.
  app.post("/v1/citas/:orgSlug/appointments/:appointmentId/cancel", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-tool-secret", deps.env.voiceToolSecret)) throw Errors.unauthorized();
    const appointmentId = c.req.param("appointmentId");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const org = await resolveOrganizationOrNotFound(citasRepo, c.req.param("orgSlug"));

      const limited = await consumeRateLimit(citasRepo, "cancel-appointment", requestActor(c.req.raw, appointmentId), 60, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      try {
        const appointment = await cancelAppointment(citasRepo, { organizationId: org.id, appointmentId });
        await tryNotifyWaitlistAfterCancel(citasRepo, org.id, appointment);
        await tryEnqueueAppointmentEmail(citasRepo, org.id, "appointment.cancelled", appointment.id);
        // Fase 3 §5 — la fila ya quedó en 'pending_cancel'/'skipped' de forma atómica
        // dentro de cancel_appointment_idempotent; best-effort real, nunca puede
        // convertir esta respuesta 200 en un error.
        await tryTriggerGoogleSync(citasRepo, deps.citasGoogleCalendarPortResolver, appointment.id);
        return c.json({ appointment: serializeAppointment(appointment) });
      } catch (err) {
        return mapErrorToHttp(err, c);
      }
    });
  });

  // ---- Agente (voz/WhatsApp): reagendar ----
  app.post("/v1/citas/:orgSlug/appointments/:appointmentId/reschedule", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-tool-secret", deps.env.voiceToolSecret)) throw Errors.unauthorized();
    const appointmentId = c.req.param("appointmentId");
    const raw = await readJsonCapped<RescheduleBody>(c.req.raw, 8 * 1024);

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const org = await resolveOrganizationOrNotFound(citasRepo, c.req.param("orgSlug"));

      const limited = await consumeRateLimit(citasRepo, "reschedule-appointment", requestActor(c.req.raw, appointmentId), 60, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      try {
        const { appointment, previousStartsAt } = await rescheduleAppointment(citasRepo, {
          organizationId: org.id,
          appointmentId,
          newStartsAt: typeof raw.new_starts_at === "string" ? raw.new_starts_at : "",
          actorChannel: raw.actor_channel === "voice" || raw.actor_channel === "whatsapp" || raw.actor_channel === "web" || raw.actor_channel === "manual" ? raw.actor_channel : undefined,
          actorNote: typeof raw.actor_note === "string" ? raw.actor_note : undefined,
        });
        await tryNotifyWaitlistAndEmail(citasRepo, org.id, appointment.providerId, appointment.serviceId, previousStartsAt, appointment.startsAt, appointment.id);
        // Fase 3 §5 — reschedule_appointment_idempotent ya dejó 'pending' (si había
        // google_event_id) de forma atómica; best-effort real.
        await tryTriggerGoogleSync(citasRepo, deps.citasGoogleCalendarPortResolver, appointment.id);
        return c.json({ appointment: serializeAppointment(appointment) });
      } catch (err) {
        return mapErrorToHttp(err, c);
      }
    });
  });

  // ---- Agente (voz/WhatsApp): modificar-cita — Fase 4. Cambia proveedor y/o
  // servicio SIN tocar el horario de inicio; ver domain-citas/src/appointments.ts
  // (reassignAppointment) para las guardias reales. ----
  app.post("/v1/citas/:orgSlug/appointments/:appointmentId/reassign", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-tool-secret", deps.env.voiceToolSecret)) throw Errors.unauthorized();
    const appointmentId = c.req.param("appointmentId");
    const raw = await readJsonCapped<ReassignBody>(c.req.raw, 8 * 1024);

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const org = await resolveOrganizationOrNotFound(citasRepo, c.req.param("orgSlug"));

      const limited = await consumeRateLimit(citasRepo, "reassign-appointment", requestActor(c.req.raw, appointmentId), 60, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      try {
        const { appointment, previousProviderId, previousServiceId } = await reassignAppointment(citasRepo, {
          organizationId: org.id,
          appointmentId,
          newProviderId: typeof raw.new_provider_id === "string" ? raw.new_provider_id : undefined,
          newServiceId: typeof raw.new_service_id === "string" ? raw.new_service_id : undefined,
          actorChannel: raw.actor_channel === "voice" || raw.actor_channel === "whatsapp" || raw.actor_channel === "web" || raw.actor_channel === "manual" ? raw.actor_channel : undefined,
          actorNote: typeof raw.actor_note === "string" ? raw.actor_note : undefined,
        });
        // El hueco (proveedor, servicio, horario) VIEJO queda libre — mismo aviso
        // de lista de espera que usa cancelar (nadie más "ocupa" ese hueco ahora).
        try {
          const oldProvider = await citasRepo.findProvider(org.id, previousProviderId);
          const timeZone = await citasRepo.findPropertyTimezone(oldProvider?.propertyId ?? null, org.id);
          await tryNotifyWaitlistOfFreedSlot(citasRepo, org.id, timeZone, { providerId: previousProviderId, serviceId: previousServiceId, startsAt: appointment.startsAt });
        } catch (err) {
          console.error("citas: aviso de lista de espera tras modificar-cita falló (best-effort):", err);
        }
        // Fase 6 §3 — GAP que esta fase cierra: modificar-cita nunca encolaba
        // ningún correo (a diferencia de crear/cancelar/reagendar, que sí lo
        // hacían aunque fuera con el payload incompleto). El cliente ahora sí se
        // entera si le cambiaron el proveedor/servicio de su cita.
        await tryEnqueueAppointmentEmail(citasRepo, org.id, "appointment.modified", appointment.id);
        // Fase 3 §5 — reassign_appointment_idempotent ya dejó 'pending' (si había
        // google_event_id) de forma atómica; best-effort real.
        await tryTriggerGoogleSync(citasRepo, deps.citasGoogleCalendarPortResolver, appointment.id);
        return c.json({ appointment: serializeAppointment(appointment) });
      } catch (err) {
        return mapErrorToHttp(err, c);
      }
    });
  });

  // ---- Staff panel: cancelar (única de las 2 acciones que el panel tiene, ver
  // diseño §5.2). Ejercita la integración real con core-tenancy. ----
  app.use(
    "/v1/citas/properties/:propertyId/appointments/:appointmentId/cancel",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requirePropertyMembership("propertyId"), // SIN allowedRoles — ver diseño §4/§5.2.
  );
  app.post("/v1/citas/properties/:propertyId/appointments/:appointmentId/cancel", async (c) => {
    const organizationId = c.get("organizationId");
    const appointmentId = c.req.param("appointmentId");
    const userId = c.get("userId");
    const citasRepo = deps.citasRepo(c.get("db"));

    try {
      const appointment = await cancelAppointmentFromPanel(citasRepo, organizationId, appointmentId, userId);
      await tryNotifyWaitlistAfterCancel(citasRepo, organizationId, appointment);
      await tryEnqueueAppointmentEmail(citasRepo, organizationId, "appointment.cancelled", appointment.id);
      // Fase 3 §5 — mismo best-effort que la cancelación del agente.
      await tryTriggerGoogleSync(citasRepo, deps.citasGoogleCalendarPortResolver, appointment.id);
      return c.json({ appointment: serializeAppointment(appointment) });
    } catch (err) {
      return mapErrorToHttp(err, c);
    }
  });

  // ---- Staff panel: confirmar/completar/marcar no-show — Fase 7. Gap real que
  // esta fase cierra: sin estas 3 rutas una cita nunca salía de 'pending'/
  // 'confirmed' aunque el cliente hubiera asistido (ver cabecera del archivo).
  // Ninguna cambia starts_at/ends_at ni provider_id/service_id, así que — a
  // diferencia de cancelar/reagendar/reasignar — no hay ningún hueco de horario
  // que liberar para la lista de espera y ningún evento de Google Calendar que
  // re-sincronizar (el horario del evento ya sincronizado sigue siendo válido).
  // Sin notificación por correo a propósito: el origen (AgendaSection.tsx) nunca
  // la tuvo para estas 3 transiciones tampoco — agregar plantillas nuevas de
  // correo queda fuera del alcance real de este gap (ver resumen de la fase).
  app.use(
    "/v1/citas/properties/:propertyId/appointments/:appointmentId/confirm",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requirePropertyMembership("propertyId"),
  );
  app.post("/v1/citas/properties/:propertyId/appointments/:appointmentId/confirm", async (c) => {
    const organizationId = c.get("organizationId");
    const appointmentId = c.req.param("appointmentId");
    const userId = c.get("userId");
    const citasRepo = deps.citasRepo(c.get("db"));

    try {
      const appointment = await confirmAppointmentFromPanel(citasRepo, organizationId, appointmentId, userId);
      return c.json({ appointment: serializeAppointment(appointment) });
    } catch (err) {
      return mapErrorToHttp(err, c);
    }
  });

  app.use(
    "/v1/citas/properties/:propertyId/appointments/:appointmentId/complete",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requirePropertyMembership("propertyId"),
  );
  app.post("/v1/citas/properties/:propertyId/appointments/:appointmentId/complete", async (c) => {
    const organizationId = c.get("organizationId");
    const appointmentId = c.req.param("appointmentId");
    const userId = c.get("userId");
    const citasRepo = deps.citasRepo(c.get("db"));

    try {
      const appointment = await completeAppointmentFromPanel(citasRepo, organizationId, appointmentId, userId);
      return c.json({ appointment: serializeAppointment(appointment) });
    } catch (err) {
      return mapErrorToHttp(err, c);
    }
  });

  app.use(
    "/v1/citas/properties/:propertyId/appointments/:appointmentId/no-show",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requirePropertyMembership("propertyId"),
  );
  app.post("/v1/citas/properties/:propertyId/appointments/:appointmentId/no-show", async (c) => {
    const organizationId = c.get("organizationId");
    const appointmentId = c.req.param("appointmentId");
    const userId = c.get("userId");
    const citasRepo = deps.citasRepo(c.get("db"));

    try {
      const appointment = await markAppointmentNoShowFromPanel(citasRepo, organizationId, appointmentId, userId);
      return c.json({ appointment: serializeAppointment(appointment) });
    } catch (err) {
      return mapErrorToHttp(err, c);
    }
  });

  return app;
}
