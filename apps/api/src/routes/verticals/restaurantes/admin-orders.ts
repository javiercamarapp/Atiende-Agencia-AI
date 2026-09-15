// Fase 5 restaurantes — back-office CORE: pedidos en operación + historial de
// órdenes (ver diseño §1.3/§1.4). Un solo endpoint de listado (`GET
// .../admin/orders`) sirve ambas vistas del origen (PedidosSection.tsx —
// pendientes/en curso, filtro por status, sin rango de fechas — y su historial
// completo con filtro de fecha/sucursal/status): son la MISMA query compuesta
// (organización + alcance de sucursal + filtros opcionales), fragmentarla en dos
// rutas solo duplicaría el mismo código de paginación por cursor. El cambio de
// estado (`PATCH .../orders/:orderId/status`) usa la máquina de estados real de
// `@atiende/domain-restaurantes::order-lifecycle.ts` — nunca acepta un string
// crudo sin validar la transición.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { MANAGER_ROLES, changeOrderStatus, isOrderStatus, OrderStatusTransitionError, tryNotifyStaffRepartidorAssigned } from "@atiende/domain-restaurantes";
import type { Order, StaffOrderNotificationRecord } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { triggerRestaurantesWhatsAppDispatchInline } from "../../internal/whatsapp-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";
import { parseBranchId, resolveEffectivePropertyIds } from "./admin-scope.ts";

function serializeOrder(o: Order) {
  return {
    id: o.id,
    propertyId: o.propertyId,
    branch: o.branch,
    customerId: o.customerId,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    customerAddress: o.customerAddress,
    customerEmail: o.customerEmail,
    total: o.total,
    status: o.status,
    items: o.items,
    source: o.source,
    notes: o.notes,
    paymentMethod: o.paymentMethod,
    createdAt: o.createdAt,
    // Fase 8 — ver domain-restaurantes/src/roles.ts::REPARTIDOR_ROLES. El admin
    // necesita ver a quién despachó un pedido (y la incidencia, si la hay) desde
    // esta MISMA vista de operación/historial -- nunca un endpoint aparte.
    assignedRepartidorId: o.assignedRepartidorId,
    estimatedDeliveryAt: o.estimatedDeliveryAt,
    incidentNote: o.incidentNote,
  };
}

// Fase 9 — bandeja de notificaciones internas al staff (ver domain-restaurantes/src/
// order-notifications.ts): sin push real disponible en este monorepo, el panel
// admin la consulta por polling — ver comentario de cabecera del GET de abajo.
function serializeStaffNotification(n: StaffOrderNotificationRecord) {
  return {
    id: n.id,
    propertyId: n.propertyId,
    orderId: n.orderId,
    eventType: n.eventType,
    message: n.message,
    createdAt: n.createdAt,
    acknowledgedAt: n.acknowledgedAt,
    acknowledgedBy: n.acknowledgedBy,
  };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 30;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw Errors.validation("limit: se esperaba un entero entre 1 y 100.");
  return n;
}

function parseDate(raw: string | undefined, field: string): Date | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw Errors.validation(`${field}: se esperaba una fecha ISO 8601 válida.`);
  return parsed;
}

function parseStatus(raw: string | undefined) {
  if (raw === undefined || raw === "") return undefined;
  if (!isOrderStatus(raw)) throw Errors.validation("status: valor de estado desconocido.");
  return raw;
}

interface StatusBody {
  readonly status?: unknown;
}

interface AssignRepartidorBody {
  readonly repartidorId?: unknown;
  readonly estimatedDeliveryAt?: unknown;
}

export function restaurantesAdminOrdersRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/v1/restaurantes/:propertyId/admin/orders", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/v1/restaurantes/:propertyId/admin/orders/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/v1/restaurantes/:propertyId/admin/order-notifications", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/v1/restaurantes/:propertyId/admin/order-notifications/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // Sirve tanto "pedidos en operación" (?status=pending, sin fechas) como
  // "historial" (?dateFrom=&dateTo=&cursor=), ver comentario de cabecera.
  app.get("/v1/restaurantes/:propertyId/admin/orders", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const branchId = parseBranchId(c.req.query("branchId"));
    const propertyIds = await resolveEffectivePropertyIds(deps, c, organizationId, branchId);
    const status = parseStatus(c.req.query("status"));
    const dateFrom = parseDate(c.req.query("dateFrom"), "dateFrom");
    const dateTo = parseDate(c.req.query("dateTo"), "dateTo");
    const limit = parseLimit(c.req.query("limit"));
    const cursor = c.req.query("cursor") || undefined;

    const page = await repo.listOrders(organizationId, { propertyIds, status, dateFrom, dateTo, limit, cursor });
    return c.json({ orders: page.orders.map(serializeOrder), nextCursor: page.nextCursor });
  });

  app.get("/v1/restaurantes/:propertyId/admin/orders/:orderId", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const order = await repo.findOrderById(organizationId, c.req.param("orderId"));
    if (!order) throw Errors.notFound("Pedido no encontrado.");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null && !scope.includes(order.propertyId)) throw Errors.forbidden("No tienes acceso a este pedido.");
    return c.json({ order: serializeOrder(order) });
  });

  app.patch("/v1/restaurantes/:propertyId/admin/orders/:orderId/status", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const orderId = c.req.param("orderId");

    const order = await repo.findOrderById(organizationId, orderId);
    if (!order) throw Errors.notFound("Pedido no encontrado.");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null && !scope.includes(order.propertyId)) throw Errors.forbidden("No tienes acceso a este pedido.");

    const raw = await readJsonCapped<StatusBody>(c.req.raw, 2 * 1024);
    if (typeof raw.status !== "string" || !isOrderStatus(raw.status)) {
      throw Errors.validation("status: valor de estado desconocido.");
    }

    try {
      const updated = await changeOrderStatus(repo, organizationId, order, raw.status);
      // Cluster #3 (CRÍTICO) de la auditoría final — `changeOrderStatus` ya
      // encoló internamente (best-effort) el WhatsApp al cliente si el nuevo
      // status aplica (tryNotifyCustomerOnOrderStatusChange, ver
      // order-notifications.ts); disparo inline del drenado, mismo
      // `repo`/transacción (ver comentario de cabecera de
      // routes/internal/whatsapp-dispatch.ts), en vez de esperar al cron diario.
      await triggerRestaurantesWhatsAppDispatchInline(deps, repo);
      logEvent(c, "info", "restaurantes_admin_pedido_status_cambiado", { actorUserId: c.get("userId"), organizationId, orderId, status: raw.status });
      return c.json({ order: serializeOrder(updated) });
    } catch (err) {
      if (err instanceof OrderStatusTransitionError) throw Errors.conflict(err.message);
      throw err;
    }
  });

  // Fase 8 — dispatch real: el ÚNICO lugar que escribe `assigned_repartidor_id`/
  // `estimated_delivery_at` (ver domain-restaurantes/src/roles.ts::REPARTIDOR_ROLES,
  // "nunca lo pone el repartidor mismo"). `repartidorId` se valida contra
  // `core.membership` ANTES de escribir -- nunca se confía a ciegas en un uuid
  // recibido por body (mismo criterio que `resolveEffectivePropertyIds` ya aplica
  // para `branchId`): debe ser staff REAL de ESTA organización con
  // `verticalRole === "repartidor"`, nunca cualquier uuid (evita asignar un pedido a
  // un owner/admin/staff por error, o a un usuario de otra organización).
  //
  // Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido
  // no tiene UI"): la validación de abajo usaba `deps.coreRepo.findMembershipsByUserId`
  // (sesión de SISTEMA, `auth.uid()` siempre null en `ProductionCoreRepository`) contra
  // `core.membership`, cuya policy restringe SELECT a `user_id = auth.uid()` -- contra
  // Postgres real esa consulta SIEMPRE devolvía cero filas, así que
  // `esRepartidorDeEstaOrg` era SIEMPRE `false` y este PATCH nunca lograba despachar un
  // pedido en producción (solo "funcionaba" en los tests, que corren contra el repo en
  // memoria sin RLS). Se corrige usando `deps.coreStaffRepo(c.get("db"))` -- FÁBRICA
  // por-request con la sesión REAL ya abierta por `dbSession(engine)` (`auth.uid()` =
  // este mismo staff autenticado que está despachando) -- y la función `security
  // definer` `core.list_org_members_by_vertical_role` (ver
  // `packages/db/migrations/0004_list_org_members_by_vertical_role.sql`), MISMO
  // mecanismo que ahora también sirve el selector real de `GET .../admin/staff/
  // repartidores` (`admin-staff.ts`).
  app.patch("/v1/restaurantes/:propertyId/admin/orders/:orderId/assign-repartidor", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const orderId = c.req.param("orderId");

    const order = await repo.findOrderById(organizationId, orderId);
    if (!order) throw Errors.notFound("Pedido no encontrado.");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null && !scope.includes(order.propertyId)) throw Errors.forbidden("No tienes acceso a este pedido.");

    const raw = await readJsonCapped<AssignRepartidorBody>(c.req.raw, 2 * 1024);
    if (typeof raw.repartidorId !== "string" || raw.repartidorId.length === 0) {
      throw Errors.validation("repartidorId es obligatorio.");
    }
    let estimatedDeliveryAt: string | null = null;
    if (raw.estimatedDeliveryAt !== undefined && raw.estimatedDeliveryAt !== null) {
      if (typeof raw.estimatedDeliveryAt !== "string" || Number.isNaN(new Date(raw.estimatedDeliveryAt).getTime())) {
        throw Errors.validation("estimatedDeliveryAt: se esperaba una fecha ISO 8601 válida.");
      }
      estimatedDeliveryAt = new Date(raw.estimatedDeliveryAt).toISOString();
    }

    const repartidores = await deps.coreStaffRepo(c.get("db")).listMembersByVerticalRole(organizationId, "repartidor");
    const esRepartidorDeEstaOrg = repartidores.some((m) => m.userId === raw.repartidorId);
    if (!esRepartidorDeEstaOrg) {
      throw Errors.validation("repartidorId no corresponde a un repartidor de esta organización.");
    }

    const updated = await repo.assignRepartidorToOrder(organizationId, orderId, raw.repartidorId, estimatedDeliveryAt);
    if (!updated) throw Errors.notFound("Pedido no encontrado.");
    // Fase 9 — "pedido listo para repartidor" del gap original (ver
    // order-notifications.ts::notifyStaffRepartidorAssignedCore para la
    // justificación completa de por qué este es el evento real, no un status
    // "listo" inventado): best-effort, nunca revierte el dispatch ya persistido.
    await tryNotifyStaffRepartidorAssigned(repo, updated);
    logEvent(c, "info", "restaurantes_admin_pedido_repartidor_asignado", { actorUserId: c.get("userId"), organizationId, orderId, repartidorId: raw.repartidorId, estimatedDeliveryAt });
    return c.json({ order: serializeOrder(updated) });
  });

  // Fase 9 — bandeja de notificaciones internas al staff (ver order-notifications.ts):
  // sin push real disponible en este monorepo, el panel admin la consulta por
  // POLLING (?unacknowledgedOnly=true para el badge de "pendientes"). Mismo alcance
  // de sucursal que el resto de rutas admin (resolveEffectivePropertyIds).
  app.get("/v1/restaurantes/:propertyId/admin/order-notifications", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const branchId = parseBranchId(c.req.query("branchId"));
    const propertyIds = await resolveEffectivePropertyIds(deps, c, organizationId, branchId);
    const unacknowledgedOnly = c.req.query("unacknowledgedOnly") === "true";
    const limitRaw = c.req.query("limit");
    let limit = 50;
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1 || n > 200) throw Errors.validation("limit: se esperaba un entero entre 1 y 200.");
      limit = n;
    }
    const notifications = await repo.listStaffOrderNotifications(organizationId, propertyIds, { unacknowledgedOnly, limit });
    return c.json({ notifications: notifications.map(serializeStaffNotification) });
  });

  app.post("/v1/restaurantes/:propertyId/admin/order-notifications/:notificationId/acknowledge", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const notificationId = c.req.param("notificationId");
    // Mismo criterio de defensa en profundidad que el resto de rutas admin de este
    // archivo (findOrderById + scope check, ver arriba): un staff con membership
    // restringida a ciertas sucursales nunca debe poder reconocer la notificación de
    // una sucursal fuera de su alcance solo por adivinar el uuid. Se verifica ANTES
    // de escribir nada (nunca reconoce y luego rechaza) consultando el mismo listado
    // ya acotado por scope que usa el GET de arriba.
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null) {
      const visible = await repo.listStaffOrderNotifications(organizationId, scope, { limit: 500 });
      if (!visible.some((n) => n.id === notificationId)) throw Errors.notFound("Notificación no encontrada.");
    }
    try {
      const notification = await repo.acknowledgeStaffOrderNotification(organizationId, notificationId, actorId);
      logEvent(c, "info", "restaurantes_admin_notificacion_reconocida", { actorUserId: actorId, organizationId, notificationId });
      return c.json({ notification: serializeStaffNotification(notification) });
    } catch {
      throw Errors.notFound("Notificación no encontrada.");
    }
  });

  return app;
}
