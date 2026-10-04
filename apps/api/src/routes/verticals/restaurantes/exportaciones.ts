// R-17 -- exportar Historial y Clientes a CSV (compatible con Excel) y PDF. Solo owner/admin (STAFF_INVITE_ROLES): el archivo lleva telefonos
// COMPLETOS de clientes, por eso es mas angosto que la pantalla de Historial/Clientes (MANAGER_ROLES, que ya ve el telefono en pantalla pero no lo
// descarga en masa). Se genera en el servidor con la sesion RLS del propio usuario (mismo `listOrders`/`listCustomers` que las pantallas),
// paginando por cursor de 500 en 500 y con tope de filas: pasado el tope responde 413 con el mensaje de acotar el rango, nunca un archivo
// truncado en silencio. No hay streaming: la sesion de base de datos es la del request y se cierra al responder.
//
//   GET /v1/restaurantes/:propertyId/admin/exportar/historial?formato=csv|pdf&status=&dateFrom=&dateTo=&branchId=
//   GET /v1/restaurantes/:propertyId/admin/exportar/clientes?formato=csv|pdf&search=
//
// CSV: UTF-8 con BOM, separador coma, fechas en la zona horaria de CADA sucursal, dinero plano sin simbolo (ver domain-restaurantes/src/exportar).
// PDF: pie en cada pagina con fecha de generacion, alcance y numero de pagina. Bitacora (migracion 019/044, tipo `exportacion`): quien exporto,
// que y cuantas filas; NUNCA el texto de busqueda ni datos de clientes.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  COLUMNAS_CLIENTES,
  COLUMNAS_HISTORIAL,
  ORDEN_ESTADO_ETIQUETAS,
  STAFF_INVITE_ROLES,
  csvDesdeFilas,
  diaLocalSucursal,
  fechaHoraLocal,
  isOrderStatus,
} from "@atiende/domain-restaurantes";
import type { Customer, FilaHistorial, Order, OrderStatus } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds, parseBranchId } from "./admin-scope.ts";
import { tablaAPdf } from "./exportar-pdf.ts";

const PAGINA = 500;
/** Tope de filas de un CSV y de un PDF: acotado por memoria del request y por el limite de paginas del PDF. */
export const EXPORTAR_MAX_FILAS_CSV = 20_000;
export const EXPORTAR_MAX_FILAS_PDF = 2_000;

type Formato = "csv" | "pdf";

function leerFormato(raw: string | undefined): Formato {
  if (raw === "csv" || raw === "pdf") return raw;
  throw Errors.validation("formato debe ser «csv» o «pdf».");
}

function leerFecha(raw: string | undefined, campo: string): Date | undefined {
  if (raw === undefined || raw === "") return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw Errors.validation(`${campo}: se esperaba una fecha ISO 8601 válida.`);
  return d;
}

function demasiadas(max: number): never {
  throw Errors.payloadTooLarge(`Hay más de ${max} filas para exportar. Acota el rango de fechas o los filtros y vuelve a intentar.`);
}

function nombreArchivo(base: string, hoy: string, formato: Formato): string {
  return `atiende-${base}-${hoy}.${formato}`;
}

function respuesta(cuerpo: string | Uint8Array, formato: Formato, archivo: string): Response {
  return new Response(typeof cuerpo === "string" ? cuerpo : Buffer.from(cuerpo), {
    status: 200,
    headers: {
      "content-type": formato === "csv" ? "text/csv; charset=utf-8" : "application/pdf",
      "content-disposition": `attachment; filename="${archivo}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function restaurantesExportacionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const historial = "/v1/restaurantes/:propertyId/admin/exportar/historial";
  const clientes = "/v1/restaurantes/:propertyId/admin/exportar/clientes";
  for (const path of [historial, clientes]) app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(historial, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const formato = leerFormato(c.req.query("formato"));
    const branchId = parseBranchId(c.req.query("branchId"));
    const propertyIds = await resolveEffectivePropertyIds(deps, c, organizationId, branchId);
    const statusRaw = c.req.query("status");
    if (statusRaw !== undefined && statusRaw !== "" && !isOrderStatus(statusRaw)) throw Errors.validation("status: valor de estado desconocido.");
    const status: OrderStatus | undefined = statusRaw ? (statusRaw as OrderStatus) : undefined;
    const dateFrom = leerFecha(c.req.query("dateFrom"), "dateFrom");
    const dateTo = leerFecha(c.req.query("dateTo"), "dateTo");

    const tope = formato === "csv" ? EXPORTAR_MAX_FILAS_CSV : EXPORTAR_MAX_FILAS_PDF;
    const pedidos: Order[] = [];
    let cursor: string | undefined;
    do {
      const page = await repo.listOrders(organizationId, { propertyIds, status, dateFrom, dateTo, limit: PAGINA, cursor });
      pedidos.push(...page.orders);
      if (pedidos.length > tope) demasiadas(tope);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    // Zona horaria de CADA sucursal (una consulta por sucursal distinta, no por pedido).
    const zonas = new Map<string, string>();
    for (const o of pedidos) {
      if (zonas.has(o.propertyId)) continue;
      const { zonaHoraria } = await repo.findBranchZonaHoraria(o.propertyId);
      zonas.set(o.propertyId, diaLocalSucursal(new Date(), zonaHoraria).zonaHoraria);
    }
    const filas: FilaHistorial[] = pedidos.map((order) => ({ order, zonaHoraria: zonas.get(order.propertyId) ?? "UTC", sucursal: order.branch ?? "" }));

    const ahora = new Date();
    const zonaBase = diaLocalSucursal(ahora, (await repo.findBranchZonaHoraria(c.req.param("propertyId") ?? "")).zonaHoraria);
    const archivo = nombreArchivo("historial", zonaBase.fecha, formato);

    let cuerpo: string | Uint8Array;
    if (formato === "csv") cuerpo = csvDesdeFilas(COLUMNAS_HISTORIAL, filas);
    else {
      const alcance = branchId ? `Sucursal: ${pedidos.find((p) => p.propertyId === branchId)?.branch ?? "seleccionada"}` : "Alcance: todas las sucursales a las que tienes acceso";
      const filtros = [
        status ? `Estado: ${ORDEN_ESTADO_ETIQUETAS[status]}` : "Estado: todos",
        dateFrom ? `Desde: ${fechaHoraLocal(dateFrom.toISOString(), zonaBase.zonaHoraria)}` : "Desde: sin límite",
        dateTo ? `Hasta: ${fechaHoraLocal(dateTo.toISOString(), zonaBase.zonaHoraria)}` : "Hasta: sin límite",
      ].join(" · ");
      cuerpo = await tablaAPdf({
        titulo: "Historial de pedidos",
        contexto: [`${filas.length} ${filas.length === 1 ? "pedido" : "pedidos"} · ${filtros}`],
        columnas: [
          { titulo: "Pedido", ancho: 0.9 },
          { titulo: "Fecha", ancho: 1.3 },
          { titulo: "Sucursal", ancho: 1.4 },
          { titulo: "Cliente", ancho: 2 },
          { titulo: "Teléfono", ancho: 1.3 },
          { titulo: "Canal", ancho: 1.3 },
          { titulo: "Estado", ancho: 1.2 },
          { titulo: "Pago", ancho: 0.9 },
          { titulo: "Total", ancho: 1, numerica: true },
        ],
        filas: filas.map((f) => COLUMNAS_HISTORIAL.map((col) => String(col.valor(f) ?? ""))),
        pie: `Atiende · Restaurantes · Generado ${fechaHoraLocal(ahora.toISOString(), zonaBase.zonaHoraria)} (${zonaBase.zonaHoraria}) · ${alcance}`,
        generadoEn: ahora,
        mensajeSinFilas: "No hay pedidos con estos filtros.",
      });
    }

    logEvent(c, "info", "restaurantes_exportacion_historial", { actorUserId: c.get("userId"), organizationId, formato, filas: filas.length });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "historial.exportado",
      entityType: "exportacion",
      entityId: null,
      campo: `formato=${formato}`,
      antes: null,
      despues: `${filas.length} filas${status ? `; estado=${status}` : ""}${dateFrom ? "; con fecha inicial" : ""}${dateTo ? "; con fecha final" : ""}${branchId ? "; una sucursal" : ""}`,
    });
    return respuesta(cuerpo, formato, archivo);
  });

  app.get(clientes, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const formato = leerFormato(c.req.query("formato"));
    const search = c.req.query("search") || undefined;
    if (search !== undefined && search.length > 160) throw Errors.validation("search: demasiado largo.");

    const tope = formato === "csv" ? EXPORTAR_MAX_FILAS_CSV : EXPORTAR_MAX_FILAS_PDF;
    const lista: Customer[] = [];
    let cursor: string | undefined;
    do {
      const page = await repo.listCustomers(organizationId, { search, limit: PAGINA, cursor });
      lista.push(...page.customers);
      if (lista.length > tope) demasiadas(tope);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    const ahora = new Date();
    const zona = diaLocalSucursal(ahora, (await repo.findBranchZonaHoraria(c.req.param("propertyId") ?? "")).zonaHoraria);
    const archivo = nombreArchivo("clientes", zona.fecha, formato);

    let cuerpo: string | Uint8Array;
    if (formato === "csv") cuerpo = csvDesdeFilas(COLUMNAS_CLIENTES, lista);
    else {
      cuerpo = await tablaAPdf({
        titulo: "Clientes",
        contexto: [`${lista.length} ${lista.length === 1 ? "cliente" : "clientes"} · ${search ? "Con búsqueda aplicada" : "Sin búsqueda: todos los clientes de la organización"}`],
        columnas: [
          { titulo: "Nombre", ancho: 3 },
          { titulo: "Teléfono", ancho: 2 },
          { titulo: "Pedidos", ancho: 1, numerica: true },
        ],
        filas: lista.map((cl) => COLUMNAS_CLIENTES.map((col) => String(col.valor(cl) ?? ""))),
        pie: `Atiende · Restaurantes · Generado ${fechaHoraLocal(ahora.toISOString(), zona.zonaHoraria)} (${zona.zonaHoraria}) · Alcance: clientes de toda la organización`,
        generadoEn: ahora,
        mensajeSinFilas: "No hay clientes con este filtro.",
      });
    }

    logEvent(c, "info", "restaurantes_exportacion_clientes", { actorUserId: c.get("userId"), organizationId, formato, filas: lista.length });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "clientes.exportado",
      entityType: "exportacion",
      entityId: null,
      campo: `formato=${formato}`,
      antes: null,
      despues: `${lista.length} filas${search ? "; con búsqueda" : ""}`,
    });
    return respuesta(cuerpo, formato, archivo);
  });

  return app;
}
