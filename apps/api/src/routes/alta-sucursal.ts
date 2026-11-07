// Onboarding P0: alta de sucursal / propiedad desde el producto (migracion 0071, core.crear_propiedad_organizacion y
// core.superadmin_crear_propiedad). Antes ninguna de estas verticales podia crear su primera sucursal sin SQL a mano: el alta de
// organizacion del superadmin no crea core.property y la tabla solo tiene GRANT para service_role.
//
//   POST /v1/restaurantes/:orgSlug/admin/alta-sucursal       { nombre, zonaHoraria? }   dueño/administrador de toda la organizacion
//   POST /v1/citas/:orgSlug/admin/alta-sucursal              { nombre, zonaHoraria? }
//   POST /v1/hoteles/:orgSlug/admin/alta-propiedad           { nombre, zonaHoraria? }
//   POST /v1/licitaciones/:orgSlug/admin/alta-propiedad      { nombre }                  (una sola propiedad por organizacion)
//   POST /superadmin/organizaciones/:organizationId/propiedades { nombre, zonaHoraria?, motivo }   alta asistida (step-up, SENSITIVE_ROUTES)
//
// La sucursal/propiedad NACE INACTIVA (no recibe pedidos ni aparece al cliente). El dueño/administrador la activa EXPLICITAMENTE con
//   POST <ruta de alta de su vertical>/:propertyId/activar     (core.activar_propiedad_organizacion)
// que responde 409 `configuracion_incompleta` con `faltantes` (ids de paso: menu, horario, zona_de_entrega, servicio, proveedor,
// habitaciones, tarifas) mientras falte configuracion obligatoria. Licitaciones no tiene pasos: la activacion pasa directo.
//
// Despachos (cartera: POST /v1/despachos/:org/admin/cartera) y rentas (catalogo: rentas.crear_propiedad) ya tienen su propio alta con datos
// de su vertical; la base los rechaza aqui con 400.
//
// Rutas por slug (no por :propertyId): la organizacion todavia no tiene ninguna propiedad. Por eso no usan requirePropertyMembership; la
// autorizacion real (owner/admin con alcance de toda la organizacion; superadmin con su propio uid) la decide la funcion SQL, que tambien
// escribe la bitacora (core.propiedad_alta_log). Aqui: forma del request, tope por actor y traduccion de rechazos. Sin la 0071: 503 honesto.
import { Hono } from "hono";
import { authMiddleware, dbSession } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { AltaPropiedadError, AltaPropiedadNoDisponibleError } from "@atiende/db";
import type { PropiedadActivada, PropiedadCreada } from "@atiende/db";
import { Errors } from "../errors.ts";
import { readJsonCapped, requestActor } from "../http-security.ts";
import { logEvent } from "../logger.ts";
import type { AppDeps } from "../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOPE = { max: 20, windowMs: 60 * 60_000 } as const;
const NO_DISPONIBLE = "El alta de sucursales todavía no está disponible en este despliegue (falta aplicar la migración 0071_alta_sucursal_propiedad).";

export const RUTAS_ALTA_PROPIEDAD: ReadonlyArray<{ readonly vertical: string; readonly path: string }> = [
  { vertical: "restaurantes", path: "/v1/restaurantes/:orgSlug/admin/alta-sucursal" },
  { vertical: "citas", path: "/v1/citas/:orgSlug/admin/alta-sucursal" },
  { vertical: "hoteles", path: "/v1/hoteles/:orgSlug/admin/alta-propiedad" },
  { vertical: "licitaciones", path: "/v1/licitaciones/:orgSlug/admin/alta-propiedad" },
];

interface AltaBody {
  readonly nombre?: unknown;
  readonly zonaHoraria?: unknown;
  readonly motivo?: unknown;
}

function leerCuerpo(raw: AltaBody): { nombre: string; zonaHoraria: string | null } {
  if (typeof raw.nombre !== "string") throw Errors.validation("nombre requerido.");
  const nombre = raw.nombre.trim();
  if (nombre.length < 2 || nombre.length > 120) throw Errors.validation("nombre: de 2 a 120 caracteres.");
  let zonaHoraria: string | null = null;
  if (raw.zonaHoraria !== undefined && raw.zonaHoraria !== null) {
    if (typeof raw.zonaHoraria !== "string" || raw.zonaHoraria.length > 100) throw Errors.validation("zonaHoraria: se esperaba un nombre IANA (ej. America/Merida).");
    zonaHoraria = raw.zonaHoraria.trim() || null;
  }
  return { nombre, zonaHoraria };
}

function traducir(err: unknown): never {
  if (err instanceof AltaPropiedadNoDisponibleError) throw Errors.serviceUnavailable(NO_DISPONIBLE);
  if (err instanceof AltaPropiedadError) {
    switch (err.codigo) {
      case "forbidden":
        throw Errors.forbidden(err.message);
      case "validation":
        throw Errors.validation(err.message);
      case "not_found":
        throw Errors.notFound("Organización no encontrada.");
      case "conflict":
        throw Errors.conflict(err.message);
      case "tope":
        throw Errors.conflict(err.message);
      case "incompleta":
        // La ruta de activacion responde el 409 con `faltantes` antes de llegar aqui; por si otra ruta lo recibe, mismo codigo HTTP.
        throw Errors.conflict(err.message);
    }
  }
  throw err;
}

function serializar(p: PropiedadCreada) {
  return { propertyId: p.propertyId, slug: p.slug, status: p.status };
}

function serializarActivada(p: PropiedadActivada) {
  return { propertyId: p.propertyId, status: p.status, yaEstabaActiva: p.yaEstabaActiva };
}

export function altaSucursalRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  async function limitar(req: Request, callerId: string): Promise<void> {
    const ok = await rateLimit(`admin:alta-propiedad:${requestActor(req, callerId)}`, TOPE.max, TOPE.windowMs, { category: "admin" });
    if (!ok) throw Errors.tooManyRequests("Demasiadas altas de sucursal en poco tiempo.");
  }

  for (const { vertical, path } of RUTAS_ALTA_PROPIEDAD) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine));
    app.post(path, async (c) => {
      const orgSlug = c.req.param("orgSlug") ?? "";
      if (!SLUG_RE.test(orgSlug)) throw Errors.notFound("Organización no encontrada.");
      const repo = deps.altaPropiedadRepo;
      if (!repo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
      const callerId = c.get("userId");
      await limitar(c.req.raw, callerId);
      const { nombre, zonaHoraria } = leerCuerpo(await readJsonCapped<AltaBody>(c.req.raw, 2 * 1024));
      let creada: PropiedadCreada;
      try {
        creada = await repo(c.get("db")).crearComoDueno(callerId, { orgSlug, vertical, nombre, zonaHoraria });
      } catch (err) {
        return traducir(err);
      }
      logEvent(c, "info", "alta_propiedad_dueno", { actorUserId: callerId, vertical, propertyId: creada.propertyId });
      return c.json(serializar(creada), 201);
    });

    const activar = `${path}/:propertyId/activar`;
    app.use(activar, authMiddleware(deps.env), dbSession(deps.engine));
    app.post(activar, async (c) => {
      const orgSlug = c.req.param("orgSlug") ?? "";
      const propertyId = c.req.param("propertyId") ?? "";
      if (!SLUG_RE.test(orgSlug) || !UUID_RE.test(propertyId)) throw Errors.notFound("Sucursal no encontrada.");
      const repo = deps.altaPropiedadRepo;
      if (!repo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
      const callerId = c.get("userId");
      await limitar(c.req.raw, callerId);
      let activada: PropiedadActivada;
      try {
        activada = await repo(c.get("db")).activarComoDueno(callerId, { orgSlug, vertical, propertyId });
      } catch (err) {
        if (err instanceof AltaPropiedadError && err.codigo === "incompleta") {
          return c.json({ code: "configuracion_incompleta", message: `No se puede activar todavía: ${err.message}`, faltantes: err.faltantes }, 409);
        }
        if (err instanceof AltaPropiedadError && err.codigo === "not_found") throw Errors.notFound("Sucursal no encontrada.");
        return traducir(err);
      }
      if (!activada.yaEstabaActiva) logEvent(c, "info", "activacion_propiedad_dueno", { actorUserId: callerId, vertical, propertyId: activada.propertyId });
      return c.json(serializarActivada(activada), 200);
    });
  }

  app.post("/superadmin/organizaciones/:organizationId/propiedades", async (c) => {
    const organizationId = c.req.param("organizationId");
    if (!UUID_RE.test(organizationId)) throw Errors.notFound("Organización no encontrada.");
    const repo = deps.altaPropiedadRepo;
    if (!repo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const callerId = c.get("userId");
    await limitar(c.req.raw, callerId);
    const raw = await readJsonCapped<AltaBody>(c.req.raw, 2 * 1024);
    const { nombre, zonaHoraria } = leerCuerpo(raw);
    const motivo = typeof raw.motivo === "string" ? raw.motivo.trim() : "";
    if (motivo.length < 20 || motivo.length > 500) throw Errors.validation("motivo obligatorio (20 a 500 caracteres).");
    let creada: PropiedadCreada;
    try {
      creada = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).crearComoSuperadmin(callerId, { organizationId, nombre, zonaHoraria, motivo }));
    } catch (err) {
      return traducir(err);
    }
    logEvent(c, "info", "superadmin_alta_propiedad", { actorUserId: callerId, organizationId, propertyId: creada.propertyId });
    return c.json(serializar(creada), 201);
  });

  return app;
}
