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
//   POST /v1/citas/properties/:propertyId/appointments/:appointmentId/retry-sync (staff panel, JWT) — Fase 6 §2 (seguimiento)
//
// Las 5 rutas de staff SÍ ejercitan requirePropertyMembership("propertyId") de
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
  AppointmentForbiddenError,
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
  retryAppointmentCalendarSyncFromPanel,
  tryEnqueueAppointmentEmail,
  tryNotifyWaitlistOfFreedSlot,
  tryTriggerCalendarSync,
} from "@atiende/domain-citas";
import type { AppointmentRecord, CitasRepository } from "@atiende/domain-citas";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor, secretMatches } from "../../../http-security.ts";
import { INLINE_BATCH_SIZE, runCitasEmailDispatch, triggerCitasEmailDispatchInline } from "./email-dispatch.ts";
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
    // Fase 6 §2 (seguimiento) — la ruta nueva de "reintentar sincronización" (ver
    // abajo) necesita devolver el estado de sync ya actualizado para feedback
    // inmediato en el panel; admin.ts (listado de Agenda) ya lo exponía, esta
    // respuesta puntual (cancelar/confirmar/completar/no-show/reintentar) no.
    google_sync_status: appointment.googleSyncStatus,
    google_sync_error: appointment.googleSyncError,
  };
}

async function resolveOrganizationOrNotFound(citasRepo: CitasRepository, orgSlug: string) {
  const org = await citasRepo.findOrganizationBySlug(orgSlug);
  if (!org || !org.isActive) throw Errors.notFound(`Negocio "${orgSlug}" no encontrado o inactivo.`);
  return org;
}

/**
 * f2-citas-lista-de-espera, hallazgo (C) residual de la auditoría a3 (barrido
 * #4) — `findProvider`/`findPropertyTimezone` (2 SELECTs planos) corrían
 * SUELTOS, SIN SAVEPOINT propio, dentro de un `try/catch` que sí protege (con
 * su PROPIO SAVEPOINT interno) la llamada que sigue
 * (`tryNotifyWaitlistOfFreedSlot`/`notifyWaitlistAfterReschedule`, ver
 * `reminders.ts`). Un error real de Postgres en cualquiera de estos 2 SELECTs
 * (probabilidad baja) dejaba la transacción COMPARTIDA del agente -- que sigue
 * con `tryEnqueueAppointmentEmail`/`triggerCitasEmailDispatchInline`/
 * `tryTriggerCalendarSync` después -- abortada sin recuperación, exactamente
 * el mismo patrón que ya se corrigió para el claim de la lista de espera.
 * Usado por los 3 callers reales (cancelar/reagendar/reasignar del agente,
 * TODOS sesión de sistema).
 */
async function resolveProviderTimeZoneForWaitlist(citasRepo: CitasRepository, organizationId: string, providerId: string): Promise<string> {
  return citasRepo.runWithRowSavepoint(async () => {
    const provider = await citasRepo.findProvider(organizationId, providerId);
    return citasRepo.findPropertyTimezone(provider?.propertyId ?? null, organizationId);
  });
}

/** Best-effort: nunca bloquea la respuesta de cancelar/reagendar si falla. */
async function tryNotifyWaitlistAndEmail(deps: AppDeps, db: TenantDbSession, citasRepo: CitasRepository, organizationId: string, providerId: string, serviceId: string, previousStartsAt: string, newStartsAt: string, appointmentId: string) {
  try {
    const timeZone = await resolveProviderTimeZoneForWaitlist(citasRepo, organizationId, providerId);
    await notifyWaitlistAfterReschedule(citasRepo, organizationId, timeZone, { providerId, serviceId, previousStartsAt, newStartsAt });
  } catch (err) {
    console.error("citas: notifyWaitlistAfterReschedule best-effort falló:", err);
  }
  // Fase 6 §3 — arma el correo real (to/subject/html) a partir de la cita ya
  // reagendada; ya es best-effort internamente (tryEnqueueAppointmentEmail).
  await tryEnqueueAppointmentEmail(citasRepo, organizationId, "appointment.rescheduled", appointmentId, { previousStartsAt });
  // Cluster #3 (CRÍTICO) de la auditoría final — disparo inline best-effort del
  // correo recién encolado arriba, ver comentario de cabecera de email-dispatch.ts.
  // `db` (necesario para el SAVEPOINT del hotfix de auditoría a2) es el MISMO
  // `TenantDbSession` que le pasó el caller (agente de voz/WhatsApp -- sesión de
  // sistema hoy, ver los 2 call sites de abajo).
  await triggerCitasEmailDispatchInline(deps, db, citasRepo);
}

/** Best-effort: cancelar SIEMPRE libera el horario de la cita — a diferencia de
 * reagendar (donde solo se libera si el nuevo horario es distinto del viejo). */
async function tryNotifyWaitlistAfterCancel(citasRepo: CitasRepository, organizationId: string, appointment: AppointmentRecord) {
  try {
    const timeZone = await resolveProviderTimeZoneForWaitlist(citasRepo, organizationId, appointment.providerId);
    await tryNotifyWaitlistOfFreedSlot(citasRepo, organizationId, timeZone, { providerId: appointment.providerId, serviceId: appointment.serviceId, startsAt: appointment.startsAt });
  } catch (err) {
    console.error("citas: aviso de lista de espera tras cancelar falló (best-effort):", err);
  }
}

/**
 * Arreglo de fondo (auditoría a3, hallazgo confirmado #1) — el SAVEPOINT de
 * `tryNotifyWaitlistOfFreedSlot` evita el 500 (deja la transacción del caller
 * utilizable), pero por sí solo NO logra que el aviso salga en sesión de STAFF:
 * `citas.claim_waitlist_notification_slot` rechaza con 42501 CUALQUIER sesión
 * con `auth.uid()` no nulo, sin excepción ("solo para la sesión de sistema").
 * Mismo patrón EXACTO que `runCitasEmailDispatch` (auditoría a2,
 * PR #166/#168, ver `email-dispatch.ts`): correr esto en una sesión de SISTEMA
 * nueva, DESPUÉS de que la cancelación ya hizo `commit;` real (vía
 * `c.get("postCommitTasks")`, que `dbSession` solo drena tras confirmar la
 * transacción del staff, ver `packages/core-auth/src/middleware.ts`), es lo
 * único que de verdad pasa el guard y notifica al candidato de la lista de
 * espera. Best-effort real -- un fallo aquí nunca puede afectar la respuesta ya
 * armada del staff (el `try` interno de `tryNotifyWaitlistAfterCancel` ya lo
 * cubre; `dbSession` además envuelve cada tarea post-commit en su propio
 * try/catch, ver middleware.ts).
 */
export async function runCitasWaitlistNotifyAfterCancel(deps: AppDeps, organizationId: string, appointment: AppointmentRecord): Promise<void> {
  await deps.engine.withAppSession({ userId: null }, async (db) => {
    const citasRepo = deps.citasRepo(db);
    await tryNotifyWaitlistAfterCancel(citasRepo, organizationId, appointment);
  });
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
  // Fase 6 §2 (seguimiento) — la ruta nueva de "reintentar sincronización" (ver
  // abajo) es la primera de este archivo que de verdad puede lanzar esto
  // (forbidden_out_of_scope, mismo criterio de property-scope que confirm/
  // complete/no-show); se mapea aquí, en el helper compartido, en vez de
  // duplicar el catch en cada ruta.
  if (err instanceof AppointmentForbiddenError) throw Errors.forbidden(err.message);
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
        await triggerCitasEmailDispatchInline(deps, db, citasRepo);
        // Fase 3 §5 — la fila ya quedó en 'pending_cancel'/'skipped' de forma atómica
        // dentro de cancel_appointment_idempotent; best-effort real, nunca puede
        // convertir esta respuesta 200 en un error.
        await tryTriggerCalendarSync(citasRepo, deps.citasCalendarSyncPortResolver, appointment.id);
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
        await tryNotifyWaitlistAndEmail(deps, db, citasRepo, org.id, appointment.providerId, appointment.serviceId, previousStartsAt, appointment.startsAt, appointment.id);
        // Fase 3 §5 — reschedule_appointment_idempotent ya dejó 'pending' (si había
        // google_event_id) de forma atómica; best-effort real.
        await tryTriggerCalendarSync(citasRepo, deps.citasCalendarSyncPortResolver, appointment.id);
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
        // f2-citas-lista-de-espera, hallazgo (C) — ver `resolveProviderTimeZoneForWaitlist`.
        try {
          const timeZone = await resolveProviderTimeZoneForWaitlist(citasRepo, org.id, previousProviderId);
          await tryNotifyWaitlistOfFreedSlot(citasRepo, org.id, timeZone, { providerId: previousProviderId, serviceId: previousServiceId, startsAt: appointment.startsAt });
        } catch (err) {
          console.error("citas: aviso de lista de espera tras modificar-cita falló (best-effort):", err);
        }
        // Fase 6 §3 — GAP que esta fase cierra: modificar-cita nunca encolaba
        // ningún correo (a diferencia de crear/cancelar/reagendar, que sí lo
        // hacían aunque fuera con el payload incompleto). El cliente ahora sí se
        // entera si le cambiaron el proveedor/servicio de su cita.
        await tryEnqueueAppointmentEmail(citasRepo, org.id, "appointment.modified", appointment.id);
        await triggerCitasEmailDispatchInline(deps, db, citasRepo);
        // Fase 3 §5 — reassign_appointment_idempotent ya dejó 'pending' (si había
        // google_event_id) de forma atómica; best-effort real.
        await tryTriggerCalendarSync(citasRepo, deps.citasCalendarSyncPortResolver, appointment.id);
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
      await tryEnqueueAppointmentEmail(citasRepo, organizationId, "appointment.cancelled", appointment.id);
      await triggerCitasEmailDispatchInline(deps, c.get("db"), citasRepo);
      // Arreglo de fondo (auditoría a2, parte 3) — en sesión de staff el intento
      // inline de arriba SIEMPRE es un no-op seguro (42501); el envío real solo
      // puede pasar DESPUÉS de que esta transacción confirme, en sesión de
      // sistema (runCitasEmailDispatch ya pasa el guard auth.uid() is null).
      c.get("postCommitTasks").push(() => runCitasEmailDispatch(deps, INLINE_BATCH_SIZE).then(() => undefined));
      // Arreglo de fondo (auditoría a3, hallazgo confirmado #1) — MISMO criterio
      // que el correo de arriba: `citas.claim_waitlist_notification_slot`
      // siempre deniega el claim en sesión de staff (42501), así que el aviso
      // real a la lista de espera solo puede intentarse DESPUÉS del commit, en
      // sesión de sistema (ver `runCitasWaitlistNotifyAfterCancel` arriba). Ya
      // NO se llama `tryNotifyWaitlistAfterCancel` dentro de esta transacción —
      // antes de este fix eso solo lograba tragar un 42501 sin savepoint, dejando
      // la transacción abortada y revirtiendo esta misma cancelación en silencio.
      c.get("postCommitTasks").push(() => runCitasWaitlistNotifyAfterCancel(deps, organizationId, appointment));
      // Fase 3 §5 — mismo best-effort que la cancelación del agente.
      await tryTriggerCalendarSync(citasRepo, deps.citasCalendarSyncPortResolver, appointment.id);
      return c.json({ appointment: serializeAppointment(appointment) });
    } catch (err) {
      return mapErrorToHttp(err, c);
    }
  });

  // ---- Staff panel: confirmar/completar/marcar no-show — Fase 7. Gap real que
  // esa fase cerró: sin estas 3 rutas una cita nunca salía de 'pending'/
  // 'confirmed' aunque el cliente hubiera asistido (ver cabecera del archivo).
  // Ninguna cambia starts_at/ends_at ni provider_id/service_id, así que — a
  // diferencia de cancelar/reagendar/reasignar — no hay ningún hueco de horario
  // que liberar para la lista de espera y ningún evento de Google Calendar que
  // re-sincronizar (el horario del evento ya sincronizado sigue siendo válido).
  // Fase 11 — gap real que ESTA fase cierra: Fase 7 documentó a propósito que no
  // había plantilla de correo para estas 3 transiciones (el origen,
  // AgendaSection.tsx, tampoco la tenía). Ahora sí hay plantilla real
  // (appointment-templates.ts::correoCitaConfirmada/Completada/NoShow) y las 3
  // rutas la encolan best-effort, mismo patrón EXACTO que cancelar arriba.
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
      await tryEnqueueAppointmentEmail(citasRepo, organizationId, "appointment.confirmed", appointment.id);
      await triggerCitasEmailDispatchInline(deps, c.get("db"), citasRepo);
      // Arreglo de fondo (auditoría a2, parte 3) — en sesión de staff el intento
      // inline de arriba SIEMPRE es un no-op seguro (42501); el envío real solo
      // puede pasar DESPUÉS de que esta transacción confirme, en sesión de
      // sistema (runCitasEmailDispatch ya pasa el guard auth.uid() is null).
      c.get("postCommitTasks").push(() => runCitasEmailDispatch(deps, INLINE_BATCH_SIZE).then(() => undefined));
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
      await tryEnqueueAppointmentEmail(citasRepo, organizationId, "appointment.completed", appointment.id);
      await triggerCitasEmailDispatchInline(deps, c.get("db"), citasRepo);
      // Arreglo de fondo (auditoría a2, parte 3) — en sesión de staff el intento
      // inline de arriba SIEMPRE es un no-op seguro (42501); el envío real solo
      // puede pasar DESPUÉS de que esta transacción confirme, en sesión de
      // sistema (runCitasEmailDispatch ya pasa el guard auth.uid() is null).
      c.get("postCommitTasks").push(() => runCitasEmailDispatch(deps, INLINE_BATCH_SIZE).then(() => undefined));
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
      await tryEnqueueAppointmentEmail(citasRepo, organizationId, "appointment.no_show", appointment.id);
      await triggerCitasEmailDispatchInline(deps, c.get("db"), citasRepo);
      // Arreglo de fondo (auditoría a2, parte 3) — en sesión de staff el intento
      // inline de arriba SIEMPRE es un no-op seguro (42501); el envío real solo
      // puede pasar DESPUÉS de que esta transacción confirme, en sesión de
      // sistema (runCitasEmailDispatch ya pasa el guard auth.uid() is null).
      c.get("postCommitTasks").push(() => runCitasEmailDispatch(deps, INLINE_BATCH_SIZE).then(() => undefined));
      return c.json({ appointment: serializeAppointment(appointment) });
    } catch (err) {
      return mapErrorToHttp(err, c);
    }
  });

  // ---- Staff panel: "reintentar sincronización" — Fase 6 §2 (seguimiento,
  // "citas-sync-errores-visibles"). Solo tiene efecto sobre una cita que el motor
  // dejó en google_sync_status='invalid' (rechazo PERMANENTE de validación, p.ej.
  // Cal.com exige el correo del cliente y esta cita no lo tenía — ver
  // domain-citas/src/calendar-sync.ts) — el staff la corrige (agregar el correo
  // del cliente, PATCH .../customers/:customerId) y dispara este botón para que
  // no tenga que esperar al cron. Mismo guard EXACTO que
  // confirm/complete/no-show de arriba (requirePropertyMembership, SIN
  // allowedRoles). ----
  app.use(
    "/v1/citas/properties/:propertyId/appointments/:appointmentId/retry-sync",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requirePropertyMembership("propertyId"),
  );
  app.post("/v1/citas/properties/:propertyId/appointments/:appointmentId/retry-sync", async (c) => {
    const organizationId = c.get("organizationId");
    const appointmentId = c.req.param("appointmentId");
    const userId = c.get("userId");
    const citasRepo = deps.citasRepo(c.get("db"));

    try {
      const appointment = await retryAppointmentCalendarSyncFromPanel(citasRepo, organizationId, appointmentId, userId);
      // Best-effort real, mismo criterio que crear/cancelar/reagendar: la
      // transición a 'pending' YA quedó escrita de forma atómica arriba; esto
      // solo evita que el staff tenga que esperar al cron para ver el resultado.
      await tryTriggerCalendarSync(citasRepo, deps.citasCalendarSyncPortResolver, appointment.id);
      const refreshed = await citasRepo.findAppointmentForOrganization(organizationId, appointment.id);
      return c.json({ appointment: serializeAppointment(refreshed ?? appointment) });
    } catch (err) {
      return mapErrorToHttp(err, c);
    }
  });

  return app;
}
