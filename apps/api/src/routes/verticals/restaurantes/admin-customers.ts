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
import { CUSTOMER_FRECUENCIAS, CUSTOMER_TIERS, ClienteMemoriaNoDisponibleError, IMPORTACION_MAX_FILAS, MANAGER_ROLES, STAFF_INVITE_ROLES, UUID_PATTERN, getCustomerDetailById, maskPhone, prepararImportacionClientes } from "@atiende/domain-restaurantes";
import type { CustomerAddressChanges, CustomerFrecuencia, CustomerListItem, CustomerProfilePatch, CustomerTier, PreferenceAction } from "@atiende/domain-restaurantes";
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


// ---- Cliente 360 (migracion 049): ficha del cliente ----

/** Las funciones SQL de la ficha validan rol y organizacion; aqui solo se traducen sus errores a respuestas honestas. */
function traducirErrorCliente(err: unknown): never {
  if (err instanceof ClienteMemoriaNoDisponibleError) {
    throw Errors.serviceUnavailable("No disponible aún: la ficha del cliente requiere aplicar la migración 049 de restaurantes.");
  }
  const code = (err as { code?: string } | null)?.code;
  // El rol ya se valido en la ruta; un 42501 aqui es "no existe en tu organizacion" (nunca se confirma el dato de otro tenant).
  if (code === "42501") throw Errors.notFound("No encontrado.");
  if (code === "22023" || code === "23514") throw Errors.validation(code === "23514" ? "Fecha de nacimiento inválida: revisa el día y el mes." : err instanceof Error ? err.message : "Datos inválidos.");
  throw err;
}

function requireUuid(value: string | undefined, field: string): string {
  if (!value || !UUID_PATTERN.test(value)) throw Errors.validation(`${field}: se esperaba un identificador válido.`);
  return value;
}

function optionalText(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) throw Errors.validation(`${field}: se esperaba un texto de hasta ${maxLength} caracteres.`);
  const limpio = value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  return limpio === "" ? null : limpio;
}

function optionalSmallInt(value: unknown, field: string, min: number, max: number): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw Errors.validation(`${field}: se esperaba un entero entre ${min} y ${max}.`);
  return value;
}

function parseAddressChanges(body: Record<string, unknown>, requireAddress: boolean): CustomerAddressChanges {
  const address = optionalText(body.address, "address", 1000);
  if (requireAddress && !address) throw Errors.validation("address: la dirección es requerida.");
  const mapsUrl = optionalText(body.maps_url, "maps_url", 500);
  if (typeof mapsUrl === "string" && !/^https:\/\/\S+$/.test(mapsUrl)) throw Errors.validation("maps_url: debe ser un enlace que empiece con https://.");
  const propertyId = body.property_id === undefined || body.property_id === null ? body.property_id : requireUuid(typeof body.property_id === "string" ? body.property_id : undefined, "property_id");
  if (body.is_default !== undefined && typeof body.is_default !== "boolean") throw Errors.validation("is_default: se esperaba verdadero o falso.");
  const label = optionalText(body.label, "label", 60);
  const accessNotes = optionalText(body.access_notes, "access_notes", 300);
  const colonia = optionalText(body.colonia, "colonia", 120);
  return {
    ...(address !== undefined && address !== null ? { address } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(accessNotes !== undefined ? { accessNotes } : {}),
    ...(mapsUrl !== undefined ? { mapsUrl } : {}),
    ...(colonia !== undefined ? { colonia } : {}),
    ...(propertyId !== undefined ? { propertyId } : {}),
    ...(body.is_default !== undefined ? { isDefault: body.is_default as boolean } : {}),
  };
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


  // ---------------------------------------------------------------------------
  // Cliente 360 (migracion 049). Cada ruta exige MANAGER_ROLES (ARCO y politica: owner/admin) y la funcion SQL vuelve a
  // validar rol y organizacion; las escrituras dejan huella en la bitacora (sin PII: ids y nombres de campo).
  // ---------------------------------------------------------------------------

  // Politica de reincidencia (umbral de "no recogido" + pedidos falsos). Se registra ANTES de `/:customerId`.
  app.get("/v1/restaurantes/:propertyId/admin/customers/policy", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const policy = await repo.getCustomerPolicy(c.get("organizationId"));
    return c.json({ policy: { umbralNoRecogidos: policy.umbralNoRecogidos, ventanaDias: policy.ventanaDias } });
  });

  app.put("/v1/restaurantes/:propertyId/admin/customers/policy", async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 1024);
    const umbral = optionalSmallInt(body.umbralNoRecogidos, "umbralNoRecogidos", 0, 20);
    const ventana = optionalSmallInt(body.ventanaDias, "ventanaDias", 7, 365);
    if (umbral === undefined || umbral === null || ventana === undefined || ventana === null) throw Errors.validation("umbralNoRecogidos y ventanaDias son requeridos.");
    try {
      const policy = await repo.saveCustomerPolicy(c.get("organizationId"), { umbralNoRecogidos: umbral, ventanaDias: ventana });
      await repo.registrarAuditoria({ organizationId: c.get("organizationId"), actorUserId: c.get("userId"), action: "clientes.politica_actualizada", entityType: "configuracion", entityId: null, campo: "umbralNoRecogidos,ventanaDias", antes: null, despues: `${policy.umbralNoRecogidos} en ${policy.ventanaDias} dias` });
      return c.json({ policy });
    } catch (err) {
      return traducirErrorCliente(err);
    }
  });

  app.get("/v1/restaurantes/:propertyId/admin/customers/:customerId/ficha", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const customerId = requireUuid(c.req.param("customerId"), "customerId");
    try {
      const ficha = await repo.getCustomerFicha(organizationId, customerId);
      if (!ficha) throw Errors.notFound("Cliente no encontrado.");
      const tier = await repo.calcCustomerTier(organizationId, customerId);
      const notes = await repo.getCustomerNotes(organizationId, customerId);
      return c.json({ ficha: { ...ficha, tier, notes } });
    } catch (err) {
      return traducirErrorCliente(err);
    }
  });

  app.patch("/v1/restaurantes/:propertyId/admin/customers/:customerId", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const customerId = requireUuid(c.req.param("customerId"), "customerId");
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    const name = optionalText(body.name, "name", 160);
    const staffNotes = optionalText(body.staffNotes, "staffNotes", 1000);
    const dia = optionalSmallInt(body.fechaNacimientoDia, "fechaNacimientoDia", 1, 31);
    const mes = optionalSmallInt(body.fechaNacimientoMes, "fechaNacimientoMes", 1, 12);
    if ((dia === undefined) !== (mes === undefined)) throw Errors.validation("La fecha de nacimiento lleva día y mes juntos (o ambos vacíos).");
    if ((dia === null) !== (mes === null)) throw Errors.validation("La fecha de nacimiento lleva día y mes juntos (o ambos vacíos).");
    const patch: CustomerProfilePatch = {
      ...(name !== undefined ? { name } : {}),
      ...(staffNotes !== undefined ? { staffNotes } : {}),
      ...(dia !== undefined ? { fechaNacimientoDia: dia, fechaNacimientoMes: mes ?? null } : {}),
    };
    if (Object.keys(patch).length === 0) throw Errors.validation("No hay cambios que guardar.");
    try {
      await repo.updateCustomerProfile(c.get("organizationId"), customerId, patch);
      await repo.registrarAuditoria({ organizationId: c.get("organizationId"), actorUserId: c.get("userId"), action: "cliente.ficha_actualizada", entityType: "configuracion", entityId: customerId, campo: Object.keys(patch).join(","), antes: null, despues: null });
      return c.json({ ok: true });
    } catch (err) {
      return traducirErrorCliente(err);
    }
  });

  app.post("/v1/restaurantes/:propertyId/admin/customers/:customerId/addresses", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const customerId = requireUuid(c.req.param("customerId"), "customerId");
    const changes = parseAddressChanges(await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024), true);
    try {
      const id = await repo.saveCustomerAddress(c.get("organizationId"), customerId, null, changes);
      await repo.registrarAuditoria({ organizationId: c.get("organizationId"), actorUserId: c.get("userId"), action: "cliente.domicilio_guardado", entityType: "configuracion", entityId: customerId, campo: Object.keys(changes).join(","), antes: null, despues: null });
      return c.json({ id }, 201);
    } catch (err) {
      return traducirErrorCliente(err);
    }
  });

  app.patch("/v1/restaurantes/:propertyId/admin/customers/:customerId/addresses/:addressId", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const customerId = requireUuid(c.req.param("customerId"), "customerId");
    const addressId = requireUuid(c.req.param("addressId"), "addressId");
    const changes = parseAddressChanges(await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024), false);
    if (Object.keys(changes).length === 0) throw Errors.validation("No hay cambios que guardar.");
    try {
      const id = await repo.saveCustomerAddress(c.get("organizationId"), customerId, addressId, changes);
      await repo.registrarAuditoria({ organizationId: c.get("organizationId"), actorUserId: c.get("userId"), action: "cliente.domicilio_editado", entityType: "configuracion", entityId: customerId, campo: Object.keys(changes).join(","), antes: null, despues: null });
      return c.json({ id });
    } catch (err) {
      return traducirErrorCliente(err);
    }
  });

  app.delete("/v1/restaurantes/:propertyId/admin/customers/:customerId/addresses/:addressId", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const customerId = requireUuid(c.req.param("customerId"), "customerId");
    const addressId = requireUuid(c.req.param("addressId"), "addressId");
    try {
      const borrada = await repo.deleteCustomerAddress(c.get("organizationId"), customerId, addressId);
      if (!borrada) throw Errors.notFound("Domicilio no encontrado.");
      await repo.registrarAuditoria({ organizationId: c.get("organizationId"), actorUserId: c.get("userId"), action: "cliente.domicilio_borrado", entityType: "configuracion", entityId: customerId, campo: "domicilio", antes: null, despues: null });
      return c.json({ ok: true });
    } catch (err) {
      return traducirErrorCliente(err);
    }
  });

  app.post("/v1/restaurantes/:propertyId/admin/customers/:customerId/preferences", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const customerId = requireUuid(c.req.param("customerId"), "customerId");
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 2 * 1024);
    const action = body.accion;
    if (action !== "agregar" && action !== "descartar" && action !== "reactivar" && action !== "eliminar") throw Errors.validation("accion: se esperaba agregar, descartar, reactivar o eliminar.");
    const prefId = action === "agregar" ? null : requireUuid(typeof body.prefId === "string" ? body.prefId : undefined, "prefId");
    const kind = action === "agregar" ? optionalText(body.kind, "kind", 20) : null;
    const value = action === "agregar" ? optionalText(body.value, "value", 120) : null;
    if (action === "agregar" && (!kind || !value)) throw Errors.validation("kind y value son requeridos para agregar un gusto.");
    try {
      const id = await repo.applyCustomerPreferenceAction(c.get("organizationId"), customerId, action as PreferenceAction, { prefId, kind, value });
      await repo.registrarAuditoria({ organizationId: c.get("organizationId"), actorUserId: c.get("userId"), action: `cliente.gusto_${action}`, entityType: "configuracion", entityId: customerId, campo: "gusto", antes: null, despues: null });
      return c.json({ id }, action === "agregar" ? 201 : 200);
    } catch (err) {
      return traducirErrorCliente(err);
    }
  });

  // Marca (o desmarca) un pedido del cliente como falso; cuenta para la reincidencia y se ve en la ficha.
  app.post("/v1/restaurantes/:propertyId/admin/customers/:customerId/orders/:orderId/falso", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const customerId = requireUuid(c.req.param("customerId"), "customerId");
    const orderId = requireUuid(c.req.param("orderId"), "orderId");
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 1024);
    if (typeof body.falso !== "boolean") throw Errors.validation("falso: se esperaba verdadero o falso.");
    try {
      // QA R2 seguridad-05: el pedido debe ser de ESE cliente (antes el customerId de la URL solo se validaba como uuid). El alcance por
      // sucursal de la membresia lo exige la base (cliente_marcar_pedido_falso, 075): fuera de alcance responde 404 igual que un pedido ajeno.
      const ficha = await repo.getCustomerFicha(c.get("organizationId"), customerId);
      if (!ficha || !ficha.orders.some((o) => o.id === orderId)) throw Errors.notFound("No encontrado.");
      const falso = await repo.markOrderFake(c.get("organizationId"), orderId, body.falso);
      await repo.registrarAuditoria({ organizationId: c.get("organizationId"), actorUserId: c.get("userId"), action: falso ? "pedido.marcado_falso" : "pedido.desmarcado_falso", entityType: "pedido", entityId: orderId, campo: "pedido_falso", antes: null, despues: falso ? "falso" : "normal" });
      return c.json({ falso });
    } catch (err) {
      return traducirErrorCliente(err);
    }
  });

  // ARCO: acceso (exportar todo lo que se guarda del titular) y cancelacion de la memoria. Solo owner/admin.
  app.get("/v1/restaurantes/:propertyId/admin/customers/:customerId/arco-export", async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const customerId = requireUuid(c.req.param("customerId"), "customerId");
    try {
      const datos = await repo.exportCustomerData(c.get("organizationId"), customerId);
      if (!datos) throw Errors.notFound("Cliente no encontrado.");
      await repo.registrarAuditoria({ organizationId: c.get("organizationId"), actorUserId: c.get("userId"), action: "cliente.arco_exportado", entityType: "configuracion", entityId: customerId, campo: "arco", antes: null, despues: null });
      return c.json({ datos });
    } catch (err) {
      return traducirErrorCliente(err);
    }
  });

  app.post("/v1/restaurantes/:propertyId/admin/customers/:customerId/borrar-memoria", async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const customerId = requireUuid(c.req.param("customerId"), "customerId");
    try {
      const resultado = await repo.deleteCustomerMemory(c.get("organizationId"), customerId);
      logEvent(c, "info", "restaurantes_admin_cliente_memoria_borrada", { actorUserId: c.get("userId"), organizationId: c.get("organizationId"), customerId });
      await repo.registrarAuditoria({ organizationId: c.get("organizationId"), actorUserId: c.get("userId"), action: "cliente.memoria_borrada", entityType: "configuracion", entityId: customerId, campo: "domicilios,gustos,notas,nombre,nacimiento", antes: null, despues: `${resultado.domiciliosBorrados} domicilios, ${resultado.gustosBorrados} gustos` });
      return c.json({ resultado });
    } catch (err) {
      return traducirErrorCliente(err);
    }
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
