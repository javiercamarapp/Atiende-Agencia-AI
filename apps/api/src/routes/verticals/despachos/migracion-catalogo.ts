// Fase 5 (migración de catálogo contable): expone el clasificador (REQ-MIG-003 a
// 006, ver @atiende/domain-despachos/migracion-catalogo/matching.ts) y el flujo de
// decisión humana aprobar/rechazar/editar con sus guardias de cardinalidad
// (REQ-MIG-007/008, ver migrador.ts). El catálogo origen/destino se manda en el
// body de `/clasificar` (viven en las bases del cliente, fuera de este monorepo —
// ver cross-db-port.ts, adaptador fail-closed documentado); lo que SÍ persiste
// fusion es el mapeo resultante y sus decisiones (migrations/
// 20240101000037_002_despachos_migracion_catalogo_schema.sql).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  MIGRACION_CATALOGO_ROLES,
  DECIDIR_MAPEO_MIGRACION_ROLES,
  clasificarCatalogo,
  aprobarMapeo,
  rechazarMapeo,
  editarMapeo,
  MapeoNoEncontradoError,
  DecisionSinResponsableError,
  TransicionEstadoInvalidaError,
  DivisionUnoANoAutomaticaError,
  EstrategiaConciliacionRequeridaError,
} from "@atiende/domain-despachos";
import type { CuentaCatalogo, MapeoMigracionCuenta } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface CuentaCatalogoBody {
  readonly id?: unknown;
  readonly codigo?: unknown;
  readonly nombre?: unknown;
  readonly nivel?: unknown;
  readonly naturaleza?: unknown;
  readonly tipoAgregado?: unknown;
  readonly cuentaPadreCodigo?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw Errors.validation(`${field}: se esperaba un string no vacío.`);
  return value;
}

function parseCuenta(raw: unknown, campo: string, idx: number): CuentaCatalogo {
  if (typeof raw !== "object" || raw === null) throw Errors.validation(`${campo}[${idx}]: se esperaba un objeto.`);
  const c = raw as CuentaCatalogoBody;
  return {
    id: requireString(c.id, `${campo}[${idx}].id`),
    codigo: requireString(c.codigo, `${campo}[${idx}].codigo`),
    nombre: requireString(c.nombre, `${campo}[${idx}].nombre`),
    nivel: typeof c.nivel === "number" ? c.nivel : 1,
    naturaleza: typeof c.naturaleza === "string" ? c.naturaleza : "D",
    tipoAgregado: typeof c.tipoAgregado === "string" ? c.tipoAgregado : "",
    cuentaPadreCodigo: typeof c.cuentaPadreCodigo === "string" ? c.cuentaPadreCodigo : null,
  };
}

function serializeMapeo(m: MapeoMigracionCuenta) {
  return {
    id: m.id,
    origenCuentaId: m.origenCuentaId,
    destinoCuentaId: m.destinoCuentaId,
    tipoMatch: m.tipoMatch,
    score: m.score,
    estado: m.estado,
    aprobadoPor: m.aprobadoPor,
    aprobadoEn: m.aprobadoEn,
    nota: m.nota,
    estrategiaConciliacionSaldos: m.estrategiaConciliacionSaldos,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function mapDomainError(err: unknown): never {
  if (err instanceof MapeoNoEncontradoError) throw Errors.notFound(err.message);
  if (err instanceof DecisionSinResponsableError) throw Errors.validation(err.message);
  if (err instanceof TransicionEstadoInvalidaError) throw Errors.conflict(err.message);
  if (err instanceof DivisionUnoANoAutomaticaError) throw Errors.conflict(err.message);
  if (err instanceof EstrategiaConciliacionRequeridaError) throw Errors.conflict(err.message);
  throw err;
}

export function despachosMigracionCatalogoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/migracion-catalogo/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  /** Clasifica el catálogo origen completo contra el destino y PERSISTE un mapeo
   * por cada cuenta origen (REQ-MIG-003 a 006). El catálogo se manda ya cargado —
   * cargarlo de una base real del cliente es responsabilidad de un adaptador de
   * infraestructura fuera de este paquete (ver cross-db-port.ts). */
  app.post("/despachos/:propertyId/migracion-catalogo/clasificar", async (c) => {
    assertVerticalRole(c, MIGRACION_CATALOGO_ROLES);
    const raw = await readJsonCapped<{ readonly catalogoOrigen?: unknown; readonly catalogoDestino?: unknown }>(c.req.raw, 2 * 1024 * 1024);
    if (!Array.isArray(raw.catalogoOrigen)) throw Errors.validation("catalogoOrigen: se esperaba un arreglo.");
    if (!Array.isArray(raw.catalogoDestino)) throw Errors.validation("catalogoDestino: se esperaba un arreglo.");
    const catalogoOrigen = raw.catalogoOrigen.map((x, i) => parseCuenta(x, "catalogoOrigen", i));
    const catalogoDestino = raw.catalogoDestino.map((x, i) => parseCuenta(x, "catalogoDestino", i));

    const clasificaciones = clasificarCatalogo(catalogoOrigen, catalogoDestino);
    const repo = deps.despachosRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");

    const mapeos: MapeoMigracionCuenta[] = [];
    for (const clas of clasificaciones) {
      const mapeo = await repo.insertMapeoMigracion({
        organizationId,
        propertyId,
        origenCuentaId: clas.origenCuentaId,
        destinoCuentaId: clas.destinoCuentaId,
        tipoMatch: clas.tipoMatch,
        score: clas.score,
        estado: clas.estado,
        nota: clas.nota,
      });
      mapeos.push(mapeo);
    }

    return c.json({ mapeos: mapeos.map(serializeMapeo) });
  });

  app.get("/despachos/:propertyId/migracion-catalogo/mapeos", async (c) => {
    assertVerticalRole(c, MIGRACION_CATALOGO_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const estadoParam = c.req.query("estado");
    const estado = estadoParam && ["pendiente", "aprobado", "rechazado", "editado"].includes(estadoParam) ? (estadoParam as MapeoMigracionCuenta["estado"]) : undefined;
    const mapeos = await repo.listMapeosMigracion(propertyId, { estado });
    return c.json({ mapeos: mapeos.map(serializeMapeo) });
  });

  app.get("/despachos/:propertyId/migracion-catalogo/mapeos/:mapeoId", async (c) => {
    assertVerticalRole(c, MIGRACION_CATALOGO_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const mapeo = await repo.findMapeoMigracion(c.req.param("propertyId"), c.req.param("mapeoId"));
    if (!mapeo) throw Errors.notFound(`No existe el mapeo "${c.req.param("mapeoId")}".`);
    return c.json(serializeMapeo(mapeo));
  });

  async function otrosMapeosDe(repo: ReturnType<AppDeps["despachosRepo"]>, propertyId: string, mapeoId: string): Promise<readonly MapeoMigracionCuenta[]> {
    const todos = await repo.listMapeosMigracion(propertyId);
    return todos.filter((m) => m.id !== mapeoId);
  }

  app.post("/despachos/:propertyId/migracion-catalogo/mapeos/:mapeoId/aprobar", async (c) => {
    assertVerticalRole(c, DECIDIR_MAPEO_MIGRACION_ROLES);
    const raw = await readJsonCapped<{ readonly decididoPor?: unknown; readonly nota?: unknown; readonly estrategiaConciliacionSaldos?: unknown }>(c.req.raw, 8 * 1024);
    const propertyId = c.req.param("propertyId");
    const mapeoId = c.req.param("mapeoId");
    const repo = deps.despachosRepo(c.get("db"));
    const mapeo = await repo.findMapeoMigracion(propertyId, mapeoId);
    if (!mapeo) throw Errors.notFound(`No existe el mapeo "${mapeoId}".`);

    try {
      const otros = await otrosMapeosDe(repo, propertyId, mapeoId);
      const decididoPor = typeof raw.decididoPor === "string" ? raw.decididoPor : "";
      const actualizado = aprobarMapeo(
        mapeo,
        decididoPor,
        { nota: typeof raw.nota === "string" ? raw.nota : undefined, estrategiaConciliacionSaldos: typeof raw.estrategiaConciliacionSaldos === "string" ? raw.estrategiaConciliacionSaldos : undefined },
        otros,
      );
      const guardado = await repo.updateMapeoMigracion(actualizado);
      return c.json(serializeMapeo(guardado));
    } catch (err) {
      mapDomainError(err);
    }
  });

  app.post("/despachos/:propertyId/migracion-catalogo/mapeos/:mapeoId/rechazar", async (c) => {
    assertVerticalRole(c, DECIDIR_MAPEO_MIGRACION_ROLES);
    const raw = await readJsonCapped<{ readonly decididoPor?: unknown; readonly nota?: unknown }>(c.req.raw, 8 * 1024);
    const propertyId = c.req.param("propertyId");
    const mapeoId = c.req.param("mapeoId");
    const repo = deps.despachosRepo(c.get("db"));
    const mapeo = await repo.findMapeoMigracion(propertyId, mapeoId);
    if (!mapeo) throw Errors.notFound(`No existe el mapeo "${mapeoId}".`);

    try {
      const decididoPor = typeof raw.decididoPor === "string" ? raw.decididoPor : "";
      const nota = typeof raw.nota === "string" ? raw.nota : "";
      const actualizado = rechazarMapeo(mapeo, decididoPor, nota);
      const guardado = await repo.updateMapeoMigracion(actualizado);
      return c.json(serializeMapeo(guardado));
    } catch (err) {
      mapDomainError(err);
    }
  });

  app.post("/despachos/:propertyId/migracion-catalogo/mapeos/:mapeoId/editar", async (c) => {
    assertVerticalRole(c, DECIDIR_MAPEO_MIGRACION_ROLES);
    const raw = await readJsonCapped<{ readonly decididoPor?: unknown; readonly destinoCuentaId?: unknown; readonly nota?: unknown; readonly estrategiaConciliacionSaldos?: unknown }>(c.req.raw, 8 * 1024);
    const propertyId = c.req.param("propertyId");
    const mapeoId = c.req.param("mapeoId");
    const repo = deps.despachosRepo(c.get("db"));
    const mapeo = await repo.findMapeoMigracion(propertyId, mapeoId);
    if (!mapeo) throw Errors.notFound(`No existe el mapeo "${mapeoId}".`);

    try {
      const otros = await otrosMapeosDe(repo, propertyId, mapeoId);
      const decididoPor = typeof raw.decididoPor === "string" ? raw.decididoPor : "";
      const destinoCuentaId = typeof raw.destinoCuentaId === "string" ? raw.destinoCuentaId : "";
      const nota = typeof raw.nota === "string" ? raw.nota : "";
      const actualizado = editarMapeo(mapeo, decididoPor, destinoCuentaId, nota, otros, typeof raw.estrategiaConciliacionSaldos === "string" ? raw.estrategiaConciliacionSaldos : undefined);
      const guardado = await repo.updateMapeoMigracion(actualizado);
      return c.json(serializeMapeo(guardado));
    } catch (err) {
      mapDomainError(err);
    }
  });

  return app;
}
