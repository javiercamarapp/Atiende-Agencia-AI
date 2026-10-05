// Fase 5 restaurantes — back-office CORE: UI de administración de clientes (ver
// diseño §1.5). Nunca inventa campos nuevos — expone exactamente lo que
// `customers.ts::lookupCustomer`/`getCustomerDetailById` ya calculan (tier real por
// percentil, "lo de siempre" real, direcciones guardadas), mismo criterio que
// admin-kpis.ts con los KPIs de cliente. Los clientes son organization-wide (no
// por-sucursal, ver comentario de `getCustomerOverviewKpis` en repository.ts) — el
// `:propertyId` del path solo resuelve `organizationId` real vía
// `requirePropertyMembership`, igual que en las otras rutas de admin de esta fase.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { CUSTOMER_FRECUENCIAS, CUSTOMER_TIERS, IMPORTACION_MAX_FILAS, MANAGER_ROLES, getCustomerDetailById, maskPhone, prepararImportacionClientes } from "@atiende/domain-restaurantes";
import type { CustomerFrecuencia, CustomerListItem, CustomerTier } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { parseBranchId, resolveEffectivePropertyIds } from "./admin-scope.ts";

const MS_POR_DIA = 86_400_000;
/** 5,000 renglones con todos los campos al maximo caben holgados; el tope real de filas lo valida el dominio. */
const IMPORT_BODY_MAX_BYTES = 4 * 1024 * 1024;
const ERRORES_MAX_EN_RESPUESTA = 100;
const HUELLA_PATTERN = /^[0-9a-f]{64}$/;

function serializeCustomer(cust: CustomerListItem) {
  return { id: cust.id, name: cust.name, phone: cust.phone, orderCount: cust.orderCount, tier: cust.tier, lastOrderAt: cust.lastOrderAt };
}

function parseNivel(raw: string | undefined): CustomerTier | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!(CUSTOMER_TIERS as readonly string[]).includes(raw)) throw Errors.validation(`nivel: se esperaba uno de ${CUSTOMER_TIERS.join(", ")}.`);
  return raw as CustomerTier;
}

function parseFrecuencia(raw: string | undefined): CustomerFrecuencia | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!(CUSTOMER_FRECUENCIAS as readonly string[]).includes(raw)) throw Errors.validation(`frecuencia: se esperaba uno de ${CUSTOMER_FRECUENCIAS.join(", ")}.`);
  return raw as CustomerFrecuencia;
}

function parseInactivoDias(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1 || n > 3650) throw Errors.validation("inactivoDias: se esperaba un entero entre 1 y 3650.");
  return n;
}

interface ImportBody {
  readonly huella?: unknown;
  readonly filas?: unknown;
}

function leerImportBody(raw: ImportBody): { huella: string; filas: readonly unknown[] } {
  if (typeof raw.huella !== "string" || !HUELLA_PATTERN.test(raw.huella)) throw Errors.validation("huella: se esperaba el SHA-256 del archivo en hexadecimal minusculas (64 caracteres).");
  if (!Array.isArray(raw.filas) || raw.filas.length === 0) throw Errors.validation("filas: se esperaba un arreglo con al menos un renglon.");
  if (raw.filas.length > IMPORTACION_MAX_FILAS) throw Errors.validation(`filas: maximo ${IMPORTACION_MAX_FILAS} renglones por archivo.`);
  return { huella: raw.huella, filas: raw.filas };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 30;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw Errors.validation("limit: se esperaba un entero entre 1 y 100.");
  return n;
}

export function restaurantesAdminCustomersRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/v1/restaurantes/:propertyId/admin/customers", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/v1/restaurantes/:propertyId/admin/customers/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  const serviceUnavailable054 = () => Errors.serviceUnavailable("Esta funcion requiere la migracion 054 de restaurantes, aun no aplicada en esta base.");

  app.get("/v1/restaurantes/:propertyId/admin/customers", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const search = c.req.query("search") || undefined;
    if (search !== undefined && search.length > 160) throw Errors.validation("search: demasiado largo.");
    const limit = parseLimit(c.req.query("limit"));
    const cursor = c.req.query("cursor") || undefined;
    const nivel = parseNivel(c.req.query("nivel"));
    const frecuencia = parseFrecuencia(c.req.query("frecuencia"));
    const inactivoDias = parseInactivoDias(c.req.query("inactivoDias"));
    const branchId = parseBranchId(c.req.query("branchId"));
    // La sucursal se valida contra las del staff (un staff acotado no ve otra); la cartera en si es de toda la organizacion.
    const propertyId = branchId === null ? undefined : (await resolveEffectivePropertyIds(deps, c, c.get("organizationId"), branchId))?.[0];

    const page = await repo.listCustomers(c.get("organizationId"), { search, limit, cursor, nivel, frecuencia, inactivoDias, propertyId });
    return c.json({ customers: page.customers.map(serializeCustomer), nextCursor: page.nextCursor, filtrosDisponibles: page.filtrosDisponibles });
  });

  // KPIs de cartera: total, recurrentes, ticket promedio y el cliente mas frecuente (telefono enmascarado).
  app.get("/v1/restaurantes/:propertyId/admin/customers/kpis", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const kpis = await repo.getCarteraKpis(organizationId);
    if (!kpis.disponible) return c.json({ disponible: false });
    let masFrecuente: { nombre: string | null; telefonoEnmascarado: string; pedidos: number; diasDesdeUltimoPedido: number | null } | null = null;
    if (kpis.masFrecuente) {
      const cliente = await repo.findCustomerById(organizationId, kpis.masFrecuente.customerId);
      if (cliente) {
        const ultimo = kpis.masFrecuente.ultimoPedidoEn ? Date.parse(kpis.masFrecuente.ultimoPedidoEn) : null;
        masFrecuente = {
          nombre: cliente.name,
          telefonoEnmascarado: maskPhone(cliente.phone),
          pedidos: kpis.masFrecuente.orderCount,
          diasDesdeUltimoPedido: ultimo === null ? null : Math.max(0, Math.floor((Date.now() - ultimo) / MS_POR_DIA)),
        };
      }
    }
    return c.json({ disponible: true, total: kpis.total, recurrentes: kpis.recurrentes, ticketPromedio: kpis.ticketPromedio, masFrecuente });
  });

  // Importar cartera (CSV/Excel ya leido en el navegador). La vista previa NO escribe nada.
  app.post("/v1/restaurantes/:propertyId/admin/customers/import/preview", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const { filas } = leerImportBody(await readJsonCapped<ImportBody>(c.req.raw, IMPORT_BODY_MAX_BYTES));
    const prep = prepararImportacionClientes(filas);
    return c.json({
      total: prep.total,
      validos: prep.validas.length,
      duplicadosEnArchivo: prep.duplicadosEnArchivo,
      totalErrores: prep.errores.length,
      errores: prep.errores.slice(0, ERRORES_MAX_EN_RESPUESTA),
      muestra: prep.validas.slice(0, 5).map((f) => ({ nombre: f.name, telefonoEnmascarado: maskPhone(f.phone), direccion: f.address, notas: f.notes })),
    });
  });

  app.post("/v1/restaurantes/:propertyId/admin/customers/import", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const { huella, filas } = leerImportBody(await readJsonCapped<ImportBody>(c.req.raw, IMPORT_BODY_MAX_BYTES));
    const prep = prepararImportacionClientes(filas);
    if (prep.validas.length === 0) throw Errors.validation("El archivo no tiene ningun renglon valido: revisa los telefonos.");
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const r = await repo.importarClientes(organizationId, huella, prep.validas);
    if (!r.disponible) throw serviceUnavailable054();
    if (!r.yaImportado) {
      logEvent(c, "info", "restaurantes_clientes_importados", { actorUserId: c.get("userId"), organizationId, total: r.total, creados: r.creados, actualizados: r.actualizados, sinCambios: r.sinCambios });
      await repo.registrarAuditoria({
        organizationId,
        actorUserId: c.get("userId"),
        action: "clientes.importados",
        entityType: "configuracion",
        entityId: null,
        campo: "clientes.importacion",
        antes: null,
        despues: `archivo=${huella.slice(0, 12)} creados=${r.creados} actualizados=${r.actualizados} sin_cambios=${r.sinCambios} rechazados=${r.rechazados + prep.errores.length}`,
      });
    }
    return c.json({
      resultado: {
        yaImportado: r.yaImportado,
        total: prep.total,
        creados: r.creados,
        actualizados: r.actualizados,
        sinCambios: r.sinCambios,
        rechazados: r.rechazados + prep.errores.length,
        errores: prep.errores.slice(0, ERRORES_MAX_EN_RESPUESTA),
      },
    });
  });

  app.get("/v1/restaurantes/:propertyId/admin/customers/:customerId", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const detail = await getCustomerDetailById(repo, c.get("organizationId"), c.req.param("customerId"));
    if (!detail) throw Errors.notFound("Cliente no encontrado.");
    if (detail.isNew) return c.json({ customer: detail });
    const notes = await repo.getCustomerNotes(c.get("organizationId"), c.req.param("customerId"));
    return c.json({ customer: { ...detail, notes } });
  });

  return app;
}
