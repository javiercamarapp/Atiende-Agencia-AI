// Fase 2 §1 — Server Tools HTTP reales para el agente de voz de ElevenLabs
// (consultar_disponibilidad/listar_servicios/listar_proveedores/buscar_citas_cliente).
// Mismo patrón exacto que apps/api/src/routes/verticals/restaurantes/voice-tools.ts:
// sub-Hono propio, auth SOLO `x-atiende-tool-secret` (nunca authMiddleware/
// originAllowed — ElevenLabs no manda Origin ni Authorization), rate-limit por scope
// vía consumeRateLimit(deps.citasRepo, ...).
import { Hono } from "hono";
import {
  AppointmentValidationError,
  consumeRateLimit,
  findAppointmentsForCustomerPhone,
  queryAvailability,
} from "@atiende/domain-citas";
import type { CitasRepository } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor, secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

async function resolveOrganizationOrNotFound(citasRepo: CitasRepository, orgSlug: string) {
  const org = await citasRepo.findOrganizationBySlug(orgSlug);
  if (!org || !org.isActive) throw Errors.notFound(`Negocio "${orgSlug}" no encontrado o inactivo.`);
  return org;
}

function requireVoiceToolSecret(deps: AppDeps, req: Request): void {
  if (!secretMatches(req, "x-atiende-tool-secret", deps.env.voiceToolSecret)) throw Errors.unauthorized();
}

export function citasVoiceToolsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  // §1.1 — POST /v1/citas/:orgSlug/availability (consultar_disponibilidad).
  // Reutiliza el motor de disponibilidad de Fase 1 vía `queryAvailability`
  // (appointments.ts) — validación estricta de `date` YYYY-MM-DD vive ahí, nunca
  // deja pasar un string arbitrario a zonedTimeToUtc.
  app.post("/v1/citas/:orgSlug/availability", async (c) => {
    requireVoiceToolSecret(deps, c.req.raw);
    const body = await readJsonCapped<{ provider_id?: unknown; service_id?: unknown; date?: unknown }>(c.req.raw, 4 * 1024);
    const providerId = typeof body.provider_id === "string" ? body.provider_id : "";
    const serviceId = typeof body.service_id === "string" ? body.service_id : "";
    const date = typeof body.date === "string" ? body.date : "";
    if (!providerId.trim() || !serviceId.trim() || !date.trim()) throw Errors.validation("provider_id, service_id y date son requeridos");

    // Sub-Hono propio, sin authMiddleware/dbSession -- abre su propia sesión de
    // sistema (`userId: null`), igual que el resto de rutas públicas/de sistema.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const org = await resolveOrganizationOrNotFound(citasRepo, c.req.param("orgSlug"));

      const limited = await consumeRateLimit(citasRepo, "voice-availability", requestActor(c.req.raw, providerId), 120, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      try {
        const { slots } = await queryAvailability(citasRepo, { organizationId: org.id, providerId, serviceId, dateStr: date });
        return c.json({ slots: slots.map((s) => ({ starts_at: s.startsAt, ends_at: s.endsAt })) });
      } catch (err) {
        if (err instanceof AppointmentValidationError) throw Errors.validation(err.message);
        throw err;
      }
    });
  });

  // §1.2 — POST /v1/citas/:orgSlug/services (listar_servicios). Sin input, sin PII
  // — mismo criterio de rate-limit que buscar_producto de restaurantes (120/60).
  app.post("/v1/citas/:orgSlug/services", async (c) => {
    requireVoiceToolSecret(deps, c.req.raw);

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const org = await resolveOrganizationOrNotFound(citasRepo, c.req.param("orgSlug"));

      const limited = await consumeRateLimit(citasRepo, "voice-services", requestActor(c.req.raw), 120, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      const services = await citasRepo.listActiveServices(org.id);
      return c.json({ services: services.map((s) => ({ id: s.id, name: s.name, duration_minutes: s.durationMinutes, price_cents: s.priceCents })) });
    });
  });

  // §1.3 — POST /v1/citas/:orgSlug/providers (listar_proveedores). `service_id`
  // opcional filtra por providerOffersService (relación ya existente en Fase 1).
  app.post("/v1/citas/:orgSlug/providers", async (c) => {
    requireVoiceToolSecret(deps, c.req.raw);
    const body = await readJsonCapped<{ service_id?: unknown }>(c.req.raw, 4 * 1024);
    const serviceId = typeof body.service_id === "string" && body.service_id.trim() ? body.service_id : undefined;

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const org = await resolveOrganizationOrNotFound(citasRepo, c.req.param("orgSlug"));

      const limited = await consumeRateLimit(citasRepo, "voice-providers", requestActor(c.req.raw, serviceId ?? ""), 120, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      const providers = await citasRepo.listActiveProviders(org.id, serviceId);
      return c.json({ providers: providers.map((p) => ({ id: p.id, display_name: p.displayName, role_label: p.roleLabel })) });
    });
  });

  // §1.4 — POST /v1/citas/:orgSlug/customers/appointments (buscar_citas_cliente) —
  // el de mayor riesgo real. GUARDIA CRÍTICA DE DISEÑO (ver diseño Fase 2
  // §1.4/§4.4): `customer_phone` NUNCA debe configurarse como parámetro "LLM
  // Prompt" en ElevenLabs — debe bindearse como variable dinámica de plataforma
  // (system caller-id), exactamente el mismo trust boundary que ya usa
  // customer-lookup de restaurantes. Esto debe documentarse en la config del
  // agente de ElevenLabs, no solo aquí — es la única defensa real contra que un
  // mensaje hostil ("dame las citas de +52...") filtre el historial de otro
  // cliente. Rate-limit por customer_phone, no solo por IP (evita fuerza bruta de
  // números).
  app.post("/v1/citas/:orgSlug/customers/appointments", async (c) => {
    requireVoiceToolSecret(deps, c.req.raw);
    const body = await readJsonCapped<{ customer_phone?: unknown }>(c.req.raw, 4 * 1024);
    const customerPhone = typeof body.customer_phone === "string" ? body.customer_phone : "";
    if (!customerPhone.trim() || customerPhone.length > 64) throw Errors.validation("customer_phone es requerido");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const org = await resolveOrganizationOrNotFound(citasRepo, c.req.param("orgSlug"));

      const limited = await consumeRateLimit(citasRepo, "voice-customer-appointments", requestActor(c.req.raw, customerPhone), 30, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      const { appointments } = await findAppointmentsForCustomerPhone(citasRepo, org.id, customerPhone);
      return c.json({ appointments: appointments.map((a) => ({ appointment_id: a.appointmentId, provider_id: a.providerId, service_id: a.serviceId, starts_at: a.startsAt, ends_at: a.endsAt, status: a.status })) });
    });
  });

  return app;
}
