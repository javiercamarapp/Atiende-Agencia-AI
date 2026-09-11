// Flujo 2 — gestión de cita existente: cancelar + reagendar. Dos entradas de
// autenticación distintas, como en el origen (ver diseño Fase 1 citas §5.2):
//
//   POST /v1/citas/:orgSlug/appointments/:appointmentId/cancel            (agente, x-atiende-tool-secret)
//   POST /v1/citas/:orgSlug/appointments/:appointmentId/reschedule        (agente, x-atiende-tool-secret)
//   POST /v1/citas/properties/:propertyId/appointments/:appointmentId/cancel  (staff panel, JWT)
//
// La ruta de staff SÍ ejercita requirePropertyMembership("propertyId") de
// core-auth — SIN allowedRoles (el origen no restringe por rol quién cancela desde
// el panel, ver domain-citas/src/roles.ts). El panel no tiene botón de reagendar en
// el origen — solo el agente reagenda hoy.
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
  consumeRateLimit,
  notifyWaitlistAfterReschedule,
  rescheduleAppointment,
  tryNotifyWaitlistOfFreedSlot,
} from "@atiende/domain-citas";
import type { AppointmentRecord } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor, secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface RescheduleBody {
  readonly new_starts_at?: unknown;
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

async function resolveOrganizationOrNotFound(deps: AppDeps, orgSlug: string) {
  const org = await deps.citasRepo.findOrganizationBySlug(orgSlug);
  if (!org || !org.isActive) throw Errors.notFound(`Negocio "${orgSlug}" no encontrado o inactivo.`);
  return org;
}

/** Best-effort: nunca bloquea la respuesta de cancelar/reagendar si falla. */
async function tryNotifyWaitlistAndEmail(deps: AppDeps, organizationId: string, providerId: string, serviceId: string, previousStartsAt: string, newStartsAt: string, appointmentId: string) {
  try {
    const provider = await deps.citasRepo.findProvider(organizationId, providerId);
    const timeZone = await deps.citasRepo.findPropertyTimezone(provider?.propertyId ?? null, organizationId);
    await notifyWaitlistAfterReschedule(deps.citasRepo, organizationId, timeZone, { providerId, serviceId, previousStartsAt, newStartsAt });
  } catch (err) {
    console.error("citas: notifyWaitlistAfterReschedule best-effort falló:", err);
  }
  try {
    await deps.citasRepo.enqueueMessagingOutbox(organizationId, "email", "appointment.rescheduled", `appointment-rescheduled:${appointmentId}:${newStartsAt}`, { appointment_id: appointmentId, previous_starts_at: previousStartsAt, new_starts_at: newStartsAt });
  } catch (err) {
    console.error("citas: enqueueMessagingOutbox(appointment.rescheduled) best-effort falló:", err);
  }
}

/** Best-effort: cancelar SIEMPRE libera el horario de la cita — a diferencia de
 * reagendar (donde solo se libera si el nuevo horario es distinto del viejo). */
async function tryNotifyWaitlistAfterCancel(deps: AppDeps, organizationId: string, appointment: AppointmentRecord) {
  try {
    const provider = await deps.citasRepo.findProvider(organizationId, appointment.providerId);
    const timeZone = await deps.citasRepo.findPropertyTimezone(provider?.propertyId ?? null, organizationId);
    await tryNotifyWaitlistOfFreedSlot(deps.citasRepo, organizationId, timeZone, { providerId: appointment.providerId, serviceId: appointment.serviceId, startsAt: appointment.startsAt });
  } catch (err) {
    console.error("citas: aviso de lista de espera tras cancelar falló (best-effort):", err);
  }
}

async function tryNotifyCancelledEmail(deps: AppDeps, organizationId: string, appointmentId: string) {
  try {
    await deps.citasRepo.enqueueMessagingOutbox(organizationId, "email", "appointment.cancelled", `appointment-cancelled:${appointmentId}`, { appointment_id: appointmentId });
  } catch (err) {
    console.error("citas: enqueueMessagingOutbox(appointment.cancelled) best-effort falló:", err);
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
  app.post("/v1/citas/:orgSlug/appointments/:appointmentId/cancel", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-tool-secret", deps.env.voiceToolSecret)) throw Errors.unauthorized();
    const org = await resolveOrganizationOrNotFound(deps, c.req.param("orgSlug"));
    const appointmentId = c.req.param("appointmentId");

    const limited = await consumeRateLimit(deps.citasRepo, "cancel-appointment", requestActor(c.req.raw, appointmentId), 60, 60);
    if (!limited.allowed) throw Errors.tooManyRequests();

    try {
      const appointment = await cancelAppointment(deps.citasRepo, { organizationId: org.id, appointmentId });
      await tryNotifyWaitlistAfterCancel(deps, org.id, appointment);
      await tryNotifyCancelledEmail(deps, org.id, appointment.id);
      return c.json({ appointment: serializeAppointment(appointment) });
    } catch (err) {
      return mapErrorToHttp(err, c);
    }
  });

  // ---- Agente (voz/WhatsApp): reagendar ----
  app.post("/v1/citas/:orgSlug/appointments/:appointmentId/reschedule", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-tool-secret", deps.env.voiceToolSecret)) throw Errors.unauthorized();
    const org = await resolveOrganizationOrNotFound(deps, c.req.param("orgSlug"));
    const appointmentId = c.req.param("appointmentId");
    const raw = await readJsonCapped<RescheduleBody>(c.req.raw, 8 * 1024);

    const limited = await consumeRateLimit(deps.citasRepo, "reschedule-appointment", requestActor(c.req.raw, appointmentId), 60, 60);
    if (!limited.allowed) throw Errors.tooManyRequests();

    try {
      const { appointment, previousStartsAt } = await rescheduleAppointment(deps.citasRepo, {
        organizationId: org.id,
        appointmentId,
        newStartsAt: typeof raw.new_starts_at === "string" ? raw.new_starts_at : "",
        actorChannel: raw.actor_channel === "voice" || raw.actor_channel === "whatsapp" || raw.actor_channel === "web" || raw.actor_channel === "manual" ? raw.actor_channel : undefined,
        actorNote: typeof raw.actor_note === "string" ? raw.actor_note : undefined,
      });
      await tryNotifyWaitlistAndEmail(deps, org.id, appointment.providerId, appointment.serviceId, previousStartsAt, appointment.startsAt, appointment.id);
      return c.json({ appointment: serializeAppointment(appointment) });
    } catch (err) {
      return mapErrorToHttp(err, c);
    }
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

    try {
      const appointment = await cancelAppointmentFromPanel(deps.citasRepo, organizationId, appointmentId, userId);
      await tryNotifyWaitlistAfterCancel(deps, organizationId, appointment);
      await tryNotifyCancelledEmail(deps, organizationId, appointment.id);
      return c.json({ appointment: serializeAppointment(appointment) });
    } catch (err) {
      return mapErrorToHttp(err, c);
    }
  });

  return app;
}
