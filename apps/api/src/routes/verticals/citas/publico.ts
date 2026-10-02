// C-19 -- API publica de SOLO LECTURA de la pagina de reservas (/reservar/:orgSlug): catalogo de servicios/profesionales y
// disponibilidad. Sin sesion de usuario: abre una sesion de sistema (`userId: null`) igual que POST /appointments, con el mismo
// criterio de proteccion (originAllowed + rate limit por IP + 404 uniforme si el negocio no existe o esta inactivo).
//
// Reglas de lo que NUNCA sale: telefono, correo ni ids de cuenta/sucursal del personal, ni datos de clientes. El catalogo solo
// entrega nombre visible del negocio, zona horaria, servicios activos y el nombre visible de los profesionales activos. El `id`
// de un profesional (fila de citas.providers, no una cuenta de usuario) SI sale: el POST publico /appointments lo exige.
//
// Puerta de reserva (C-06): un negocio que `evaluarReservaPublica` dice que no esta listo responde `{ lista:false, faltan }` sin
// ningun dato del negocio -- la pagina no muestra el formulario.
import { Hono } from "hono";
import type { Context } from "hono";
import { AppointmentValidationError, consumeRateLimit, evaluarReservaPublica, queryAvailability } from "@atiende/domain-citas";
import type { CitasRepository } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { originAllowed, readJsonCapped, requestActor } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

/** Tope de servicios del catalogo publico y de profesionales consultados en "cualquiera": acota las lecturas por peticion. */
const MAX_SERVICIOS = 50;
const MAX_PROFESIONALES_DISPONIBILIDAD = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolverNegocio(citasRepo: CitasRepository, orgSlug: string) {
  const org = await citasRepo.findOrganizationBySlug(orgSlug);
  // 404 uniforme: mismo mensaje exista o no el negocio, este activo o no (no filtra que slugs existen).
  if (!org || !org.isActive) throw Errors.notFound("Negocio no encontrado.");
  return org;
}

export function citasPublicoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  const verificarOrigen = (c: Context) => {
    if (!originAllowed(c.req.header("origin") ?? null, deps.env.allowedOrigins)) throw Errors.forbidden("Origen no permitido");
  };

  // GET /v1/citas/:orgSlug/publico/catalogo
  app.get("/v1/citas/:orgSlug/publico/catalogo", async (c) => {
    verificarOrigen(c);
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const org = await resolverNegocio(citasRepo, c.req.param("orgSlug"));

      const limited = await consumeRateLimit(citasRepo, "public-catalog", requestActor(c.req.raw), 60, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      const reserva = await evaluarReservaPublica(citasRepo, org.id);
      if (!reserva.lista) return c.json({ lista: false, faltan: reserva.faltan });

      const [servicios, zona] = await Promise.all([citasRepo.listActiveServices(org.id), citasRepo.findPropertyTimezone(null, org.id)]);
      const visibles = servicios.slice(0, MAX_SERVICIOS);
      // Un solo recorrido por servicio: quien lo ofrece. Solo se publican profesionales que ofrecen al menos un servicio.
      const porProfesional = new Map<string, { id: string; nombre: string; servicio_ids: string[] }>();
      const serviciosConProfesional: typeof visibles[number][] = [];
      for (const s of visibles) {
        const ofrecen = await citasRepo.listActiveProviders(org.id, s.id);
        if (ofrecen.length === 0) continue;
        serviciosConProfesional.push(s);
        for (const p of ofrecen) {
          const previo = porProfesional.get(p.id) ?? { id: p.id, nombre: p.displayName, servicio_ids: [] };
          previo.servicio_ids.push(s.id);
          porProfesional.set(p.id, previo);
        }
      }
      return c.json({
        lista: true,
        negocio: { nombre: org.name, zona_horaria: zona },
        servicios: serviciosConProfesional.map((s) => ({ id: s.id, nombre: s.name, duracion_minutos: s.durationMinutes, precio_centavos: s.priceCents })),
        profesionales: [...porProfesional.values()].map((p) => ({ id: p.id, nombre: p.nombre, servicio_ids: p.servicio_ids })),
      });
    });
  });

  // POST /v1/citas/:orgSlug/publico/disponibilidad  { service_id, provider_id?, date }
  app.post("/v1/citas/:orgSlug/publico/disponibilidad", async (c) => {
    verificarOrigen(c);
    const body = await readJsonCapped<{ service_id?: unknown; provider_id?: unknown; date?: unknown }>(c.req.raw, 4 * 1024);
    const serviceId = typeof body.service_id === "string" ? body.service_id.trim() : "";
    const providerId = typeof body.provider_id === "string" ? body.provider_id.trim() : "";
    const date = typeof body.date === "string" ? body.date.trim() : "";
    if (!serviceId || !date) throw Errors.validation("service_id y date son requeridos");
    if (!UUID_RE.test(serviceId) || (providerId && !UUID_RE.test(providerId))) throw Errors.validation("service_id o provider_id inválido");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const org = await resolverNegocio(citasRepo, c.req.param("orgSlug"));

      const limited = await consumeRateLimit(citasRepo, "public-availability", requestActor(c.req.raw), 30, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      const reserva = await evaluarReservaPublica(citasRepo, org.id);
      if (!reserva.lista) return c.json({ lista: false, faltan: reserva.faltan });

      try {
        if (providerId) {
          const provider = await citasRepo.findProvider(org.id, providerId);
          const zona = provider ? await citasRepo.findPropertyTimezone(provider.propertyId, org.id) : null;
          const { slots } = await queryAvailability(citasRepo, { organizationId: org.id, providerId, serviceId, dateStr: date });
          return c.json({ lista: true, zona_horaria: zona, slots: slots.map((s) => ({ starts_at: s.startsAt, ends_at: s.endsAt, provider_id: providerId })) });
        }

        // "Cualquiera": une los horarios de quienes ofrecen el servicio; cada horario conserva UN profesional (el primero libre).
        const candidatos = (await citasRepo.listActiveProviders(org.id, serviceId)).slice(0, MAX_PROFESIONALES_DISPONIBILIDAD);
        const servicio = await citasRepo.findService(org.id, serviceId);
        if (!servicio || !servicio.isActive) throw new AppointmentValidationError("Servicio no encontrado o inactivo");
        const unicos = new Map<string, { starts_at: string; ends_at: string; provider_id: string }>();
        let zona: string | null = null;
        for (const p of candidatos) {
          const { slots } = await queryAvailability(citasRepo, { organizationId: org.id, providerId: p.id, serviceId, dateStr: date });
          if (slots.length > 0 && zona === null) zona = await citasRepo.findPropertyTimezone(p.propertyId, org.id);
          for (const s of slots) if (!unicos.has(s.startsAt)) unicos.set(s.startsAt, { starts_at: s.startsAt, ends_at: s.endsAt, provider_id: p.id });
        }
        const slots = [...unicos.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
        return c.json({ lista: true, zona_horaria: zona ?? (await citasRepo.findPropertyTimezone(null, org.id)), slots });
      } catch (err) {
        if (err instanceof AppointmentValidationError) throw Errors.validation(err.message);
        throw err;
      }
    });
  });

  return app;
}
