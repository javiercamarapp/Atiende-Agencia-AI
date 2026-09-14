// Flujo 1 — POST /v1/citas/:orgSlug/appointments (== crear-cita del origen). Ruta
// pública/de sistema: checkout/widget de reservación público + Server Tool del
// agente conversacional — por eso este grupo se monta SIN authMiddleware/
// requirePropertyMembership, mismo criterio exacto que restaurantesPublicRoutes (ver
// diseño Fase 1 citas §5.1).
//
// Protección real: originAllowed() (CORS) para source="web", x-atiende-tool-secret
// para source="voice"|"whatsapp" (agente), rate-limit distinto por canal.
import { Hono } from "hono";
import { consumeRateLimit, createAppointment, tryEnqueueAppointmentEmail, tryTriggerGoogleSync, AppointmentConflictError, AppointmentValidationError } from "@atiende/domain-citas";
import type { CitasRepository, CreateAppointmentPayload } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { originAllowed, readJsonCapped, requestActor, secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface CreateAppointmentBody {
  readonly provider_id?: unknown;
  readonly service_id?: unknown;
  readonly property_id?: unknown;
  readonly customer_name?: unknown;
  readonly customer_phone?: unknown;
  readonly customer_email?: unknown;
  readonly starts_at?: unknown;
  readonly notes?: unknown;
  readonly source?: unknown;
  readonly idempotency_key?: unknown;
  readonly conversation_id?: unknown;
}

function mapCreateAppointmentBody(organizationId: string, body: CreateAppointmentBody, source: "web" | "voice" | "whatsapp"): CreateAppointmentPayload {
  return {
    organizationId,
    providerId: typeof body.provider_id === "string" ? body.provider_id : "",
    serviceId: typeof body.service_id === "string" ? body.service_id : "",
    propertyId: typeof body.property_id === "string" ? body.property_id : undefined,
    customerName: typeof body.customer_name === "string" ? body.customer_name : "",
    customerPhone: typeof body.customer_phone === "string" ? body.customer_phone : "",
    customerEmail: typeof body.customer_email === "string" ? body.customer_email : undefined,
    startsAt: typeof body.starts_at === "string" ? body.starts_at : "",
    notes: typeof body.notes === "string" ? body.notes : undefined,
    source,
    idempotencyKey: typeof body.idempotency_key === "string" ? body.idempotency_key : undefined,
    conversationId: typeof body.conversation_id === "string" ? body.conversation_id : undefined,
  };
}

function serializeAppointment(appointment: Awaited<ReturnType<typeof createAppointment>>) {
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

export function citasAppointmentsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/v1/citas/:orgSlug/appointments", async (c) => {
    if (!originAllowed(c.req.header("origin") ?? null, deps.env.allowedOrigins)) throw Errors.forbidden("Origen no permitido");

    const incoming = await readJsonCapped<CreateAppointmentBody>(c.req.raw, 16 * 1024);
    const toolAuthorized = secretMatches(c.req.raw, "x-atiende-tool-secret", deps.env.voiceToolSecret);

    const requestedSource = typeof incoming.source === "string" ? incoming.source : undefined;
    if ((requestedSource === "voice" || requestedSource === "whatsapp") && !toolAuthorized) throw Errors.unauthorized();
    if (!toolAuthorized && requestedSource && requestedSource !== "web") throw Errors.validation("source inválido");

    const source = toolAuthorized && (requestedSource === "voice" || requestedSource === "whatsapp") ? requestedSource : "web";

    // Ruta pública/de sistema (sin authMiddleware/dbSession montado, ver comentario
    // de cabecera) -- abre su propia sesión de sistema (`userId: null`) igual que
    // ya documenta postgres-repository.ts de este paquete, en vez de depender de un
    // `c.get("db")` que aquí nunca existe.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const org = await resolveOrganizationOrNotFound(citasRepo, c.req.param("orgSlug"));
      const input = mapCreateAppointmentBody(org.id, incoming, source);

      const limited = await consumeRateLimit(citasRepo, "create-appointment", requestActor(c.req.raw, toolAuthorized ? input.customerPhone : ""), toolAuthorized ? 60 : 10, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      try {
        const appointment = await createAppointment(citasRepo, input);
        // Best-effort, nunca bloquea la respuesta si falla (ver diseño §5.1 paso 3).
        // Fase 6 §3 — arma el correo real (to/subject/html) a partir de la cita ya
        // creada; antes de esta fase el payload encolado aquí solo traía
        // {appointment_id}, sin contenido real que un dispatcher pudiera enviar.
        await tryEnqueueAppointmentEmail(citasRepo, org.id, "appointment.created", appointment.id);
        // Fase 3 §5 — intento inmediato de sincronizar con Google Calendar. La fila
        // ya quedó en google_sync_status='pending' de forma atómica dentro de
        // create_appointment_idempotent; tryTriggerGoogleSync absorbe cualquier
        // excepción internamente (best-effort real, mismo criterio que
        // tryNotifyWaitlistAfterCancel de appointments-lifecycle.ts) — esperarla aquí
        // NUNCA puede convertir esta respuesta 201 en un error 500.
        await tryTriggerGoogleSync(citasRepo, deps.citasGoogleCalendarPortResolver, appointment.id);
        return c.json({ appointment: serializeAppointment(appointment) }, 201);
      } catch (err) {
        if (err instanceof AppointmentConflictError) throw Errors.conflict(err.message);
        if (err instanceof AppointmentValidationError) throw Errors.validation(err.message);
        throw err;
      }
    });
  });

  return app;
}
