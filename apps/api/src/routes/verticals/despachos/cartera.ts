// D-21 -- cartera de clientes del despacho: alta y ficha fiscal de contribuyente por property (RFC validado,
// razón social, régimen(es), CP fiscal, periodicidad de pagos provisionales, responsable). SIN llamadas al SAT.
//
//  GET  /v1/despachos/:orgSlug/admin/cartera              clientes (properties de despachos) con su ficha, o sin ella
//  POST /v1/despachos/:orgSlug/admin/cartera              alta de un cliente nuevo (property + ficha), solo membresía de TODA la organización
//  GET  /despachos/:propertyId/cartera/ficha              ficha del cliente activo
//  PUT  /despachos/:propertyId/cartera/ficha              crea/actualiza la ficha de una property existente (el RFC ya registrado no cambia)
//
// Autorización: ver = VER_CARTERA_ROLES; escribir = GESTIONAR_CARTERA_ROLES (admin/contador). El alta además exige
// `propertyIds === null` en la membresía (crear un cliente es una operación de organización: un staff acotado a ciertos
// clientes no puede inflar la cartera). La base repite todo (migración 018, funciones security definer con guard).
// Compatibilidad con la base sin migrar: el listado responde `estado: "no_disponible"` con las properties sin ficha y las
// escrituras 503; nunca un 500.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { cfdiCatalogs } from "@atiende/billing";
import {
  CarteraDatosInvalidosError,
  CarteraNoDisponibleError,
  CarteraSinPermisoError,
  CarteraTopeExcedidoError,
  ClienteRfcDuplicadoError,
  GESTIONAR_CARTERA_ROLES,
  PostgresCarteraRepository,
  VER_CARTERA_ROLES,
  semaforoDeSolicitud,
  validarFichaCliente,
  validarNombreCliente,
} from "@atiende/domain-despachos";
import type { CarteraRepository, ClienteFichaRecord, ErrorCampo } from "@atiende/domain-despachos";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { pilotoDe } from "./piloto-comun.ts";

const MAX_BODY_BYTES = 8 * 1024;

export function serializeFicha(f: ClienteFichaRecord) {
  return {
    propertyId: f.propertyId,
    rfc: f.rfc,
    tipoPersona: f.tipoPersona,
    razonSocial: f.razonSocial,
    regimenesFiscales: f.regimenesFiscales.map((clave) => ({ clave, nombre: cfdiCatalogs.REGIMENES_FISCALES[clave] ?? clave })),
    cpFiscal: f.cpFiscal,
    periodicidad: f.periodicidad,
    responsableId: f.responsableId,
    creadoEn: f.createdAt,
    actualizadoEn: f.updatedAt,
  };
}

function validacion(errores: readonly ErrorCampo[]) {
  return Errors.validation(errores.map((e) => `${e.campo}: ${e.mensaje}`).join(" "));
}

/** Errores de dominio de la cartera -> HTTP (la base ya devolvió un mensaje sin detalles internos). */
function traducir(err: unknown): never {
  if (err instanceof CarteraNoDisponibleError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof ClienteRfcDuplicadoError) throw Errors.conflict(err.message);
  if (err instanceof CarteraSinPermisoError) throw Errors.forbidden(err.message);
  if (err instanceof CarteraTopeExcedidoError) throw Errors.conflict(err.message);
  if (err instanceof CarteraDatosInvalidosError) throw Errors.validation(err.message);
  throw err;
}

export function despachosCarteraRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const carteraDe = (db: TenantDbSession): CarteraRepository => (deps.carteraRepo ? deps.carteraRepo(db) : new PostgresCarteraRepository(db));

  // ---- Nivel organización (resuelve el despacho por slug, igual que admin/branches) ----
  app.use("/v1/despachos/:orgSlug/admin/cartera", authMiddleware(deps.env), dbSession(deps.engine));

  async function contextoOrg(c: Context<CoreAuthHonoEnv>) {
    const orgSlug = c.req.param("orgSlug") ?? "";
    const db = c.get("db");
    const org = await deps.despachosRepo(db).findOrganizationBySlug(orgSlug);
    if (!org || !org.isActive) throw Errors.notFound(`Negocio "${orgSlug}" no encontrado o inactivo.`);
    const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
    const membership = memberships.find((m) => m.organizationId === org.id);
    if (!membership) throw Errors.forbidden("No perteneces a esta organización.");
    return { org, membership, db };
  }

  app.get("/v1/despachos/:orgSlug/admin/cartera", async (c) => {
    const { org, membership, db } = await contextoOrg(c);
    if (!(VER_CARTERA_ROLES as readonly string[]).includes(membership.verticalRole)) throw Errors.forbidden(`Tu rol (${membership.verticalRole}) no puede ver la cartera.`);
    const r = await carteraDe(db).listar(org.id);
    // Alcance de la membresía: un staff acotado solo ve los clientes que tiene asignados.
    const visibles = membership.propertyIds === null ? r.clientes : r.clientes.filter((cl) => membership.propertyIds!.includes(cl.propertyId));
    // paridad3 D-31: semaforo de documentos del cliente para el periodo que se esta cerrando (el mes anterior al «hoy» de negocio).
    const hoy = hoyFechaNegocio();
    const [anio, mes] = Number(hoy.slice(5, 7)) === 1 ? [Number(hoy.slice(0, 4)) - 1, 12] : [Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)) - 1];
    const resumenes = await pilotoDe(deps, db).resumenSolicitudesPeriodo(anio, mes);
    const porProperty = new Map((resumenes.disponible ? resumenes.valor : []).map((x) => [x.propertyId, x] as const));
    const ahora = Date.now();
    return c.json({
      estado: r.estado,
      puedeDarDeAlta: membership.propertyIds === null && (GESTIONAR_CARTERA_ROLES as readonly string[]).includes(membership.verticalRole),
      documentosPeriodo: { periodo: `${anio}-${String(mes).padStart(2, "0")}`, disponible: resumenes.disponible },
      clientes: visibles.map((cl) => {
        const x = porProperty.get(cl.propertyId);
        return {
          propertyId: cl.propertyId,
          nombre: cl.nombre,
          ficha: cl.ficha ? serializeFicha(cl.ficha) : null,
          documentos: resumenes.disponible ? { semaforo: semaforoDeSolicitud(x, ahora), total: x?.total ?? 0, pendientes: x?.pendientes ?? 0, enRevision: x?.enRevision ?? 0, recibidos: x?.recibidos ?? 0, noAplica: x?.noAplica ?? 0 } : null,
        };
      }),
    });
  });

  app.post("/v1/despachos/:orgSlug/admin/cartera", async (c) => {
    const { org, membership, db } = await contextoOrg(c);
    if (!(GESTIONAR_CARTERA_ROLES as readonly string[]).includes(membership.verticalRole)) throw Errors.forbidden(`Tu rol (${membership.verticalRole}) no puede dar de alta clientes.`);
    if (membership.propertyIds !== null) throw Errors.forbidden("Dar de alta clientes requiere acceso a toda la organización.");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_BODY_BYTES);
    const nombre = validarNombreCliente(raw.nombre);
    const ficha = validarFichaCliente(raw);
    const errores: ErrorCampo[] = [];
    if (!nombre.ok) errores.push({ campo: "nombre", mensaje: nombre.mensaje });
    if (!ficha.ok) errores.push(...ficha.errores);
    if (!nombre.ok || !ficha.ok) throw validacion(errores);
    try {
      const { propertyId } = await carteraDe(db).alta(org.id, nombre.nombre, ficha.valor);
      return c.json({ propertyId, nombre: nombre.nombre }, 201);
    } catch (err) {
      return traducir(err);
    }
  });

  // ---- Nivel property (cliente activo) ----
  app.use("/despachos/:propertyId/cartera/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/despachos/:propertyId/cartera/ficha", async (c) => {
    assertVerticalRole(c, VER_CARTERA_ROLES);
    const ficha = await carteraDe(c.get("db")).obtenerFicha(c.req.param("propertyId"));
    return c.json({ ficha: ficha ? serializeFicha(ficha) : null });
  });

  app.put("/despachos/:propertyId/cartera/ficha", async (c) => {
    assertVerticalRole(c, GESTIONAR_CARTERA_ROLES);
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_BODY_BYTES);
    const ficha = validarFichaCliente(raw);
    if (!ficha.ok) throw validacion(ficha.errores);
    const repo = carteraDe(c.get("db"));
    const propertyId = c.req.param("propertyId");
    try {
      await repo.guardarFicha(propertyId, ficha.valor);
    } catch (err) {
      return traducir(err);
    }
    const guardada = await repo.obtenerFicha(propertyId);
    return c.json({ ficha: guardada ? serializeFicha(guardada) : null });
  });

  return app;
}
