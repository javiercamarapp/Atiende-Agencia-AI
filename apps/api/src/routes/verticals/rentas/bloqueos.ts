// Fase 4 -- /rentas/:propertyId/unidades/:unidadId/bloqueos: crear/listar/liberar
// bloqueos de propietario/mantenimiento/buffer sobre el calendario de una unidad.
//
// El motor puro (`crearBloqueo`, capa='bloqueo') se portó completo desde Fase 1 pero
// nunca se expuso por HTTP -- ver README de domain-rentas, sección "Fuera de fase"
// (ya actualizada por este cambio). Mismo patrón arquitectónico exacto que
// reservas.ts: motor transaccional siempre en @atiende/domain-rentas, la ruta le pasa
// el `TenantDbSession` del request DIRECTO (satisface `EjecutorTransaccional` por
// structural typing), sesión de staff obligatoria (authMiddleware + dbSession +
// requirePropertyMembership), filtrado fino de rol con assertVerticalRole dentro de
// cada handler.
//
// Decisión de negocio importante, heredada del motor y NO decidida aquí: un bloqueo
// NUNCA rechaza la creación de una reserva de canal que se solape (ni viceversa) -- el
// EXCLUDE de Postgres solo protege `capa='reserva'` (ver migrations/001_rentas_schema.sql,
// comentario junto a `ocupacion_sin_solape`). Un bloqueo que se solapa con una
// ocupación existente SIEMPRE se crea, y el solape queda registrado como
// `rentas.conflicto_calendario` (tipo `capa_cruzada`) para revisión humana -- igual
// que ya hace `crearReservaConfirmada` en sentido inverso. Esta ruta no inventa un
// comportamiento de "bloquea disponibilidad" que el motor de dominio no tiene.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { CANCELAR_ROLES, crearBloqueo, cancelarOcupacion, ESCRITURA_CALENDARIO_ROLES, RentasDomainError } from "@atiende/domain-rentas";
import type { RangoFechas } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { mapRentasDomainError } from "./reservas.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RAZONES_BLOQUEO = ["BLOQUEO_PROPIETARIO", "MANTENIMIENTO", "BUFFER_LIMPIEZA"] as const;
type RazonBloqueo = (typeof RAZONES_BLOQUEO)[number];

function requireFecha(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw Errors.validation(`${field}: formato de fecha esperado YYYY-MM-DD.`);
  }
  return value;
}

function requireRango(raw: unknown): RangoFechas {
  if (!raw || typeof raw !== "object") throw Errors.validation("rango: se esperaba un objeto {inicio, fin}.");
  const r = raw as { inicio?: unknown; fin?: unknown };
  return { inicio: requireFecha(r.inicio, "rango.inicio"), fin: requireFecha(r.fin, "rango.fin") };
}

function requireRazon(value: unknown): RazonBloqueo {
  if (typeof value !== "string" || !(RAZONES_BLOQUEO as readonly string[]).includes(value)) {
    throw Errors.validation(`razon: se esperaba uno de ${RAZONES_BLOQUEO.join(", ")}.`);
  }
  return value as RazonBloqueo;
}

interface CrearBloqueoBody {
  readonly rango?: unknown;
  readonly razon?: unknown;
}

export function rentasBloqueosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const repo = deps.rentasRepo;

  const base = "/rentas/:propertyId/unidades/:unidadId/bloqueos";
  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${base}/:ocupacionId/cancelar`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(base, async (c) => {
    assertVerticalRole(c, ESCRITURA_CALENDARIO_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const db = c.get("db");

    // Defensa en profundidad, mismo criterio que reservas.ts: nunca confiar en que el
    // cliente "sabe" que `unidadId` pertenece a `propertyId`.
    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");

    const raw = await readJsonCapped<CrearBloqueoBody>(c.req.raw, 2 * 1024);
    const rango = requireRango(raw.rango);
    const razon = requireRazon(raw.razon);

    try {
      const resultado = await crearBloqueo(db, { organizationId, propertyId, unidadId, rango, razon });
      return c.json({ id: resultado.ocupacionId, conflictosCapaCruzada: resultado.conflictosCapaCruzada.length }, 201);
    } catch (err) {
      if (err instanceof RentasDomainError) throw mapRentasDomainError(err);
      throw err;
    }
  });

  app.get(base, async (c) => {
    assertVerticalRole(c, ESCRITURA_CALENDARIO_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");

    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");

    const bloqueos = await repo.listBloqueos(propertyId, unidadId);
    return c.json({ bloqueos }, 200);
  });

  app.post(`${base}/:ocupacionId/cancelar`, async (c) => {
    assertVerticalRole(c, CANCELAR_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const ocupacionId = c.req.param("ocupacionId");
    const db = c.get("db");

    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");

    const ocupacion = await repo.findOcupacion(propertyId, unidadId, ocupacionId);
    if (!ocupacion) throw Errors.notFound("Bloqueo no encontrado en esta unidad.");
    // Espejo exacto del guardia inverso de reservas.ts (`capa !== "reserva"` ahí,
    // `capa !== "bloqueo"` aquí): esta ruta nunca debe poder cancelar una reserva de
    // canal -- para eso existe /reservas/:ocupacionId/cancelar, con sus propias reglas
    // de "reserva no directa".
    if (ocupacion.capa !== "bloqueo") throw Errors.validation("Esta ruta solo cancela bloqueos; usa /reservas/:ocupacionId/cancelar para una reserva.");

    try {
      const resultado = await cancelarOcupacion(db, ocupacionId);
      return c.json({ id: ocupacionId, estado: "cancelado", estadoAnterior: resultado.estadoAnterior }, 200);
    } catch (err) {
      if (err instanceof RentasDomainError) throw mapRentasDomainError(err);
      throw err;
    }
  });

  return app;
}
