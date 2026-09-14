// Fase 8 restaurantes — superficie real del rol "repartidor" (ver diseño Fase 8 §1 y
// domain-restaurantes/src/roles.ts::REPARTIDOR_ROLES): un repartidor solo puede LEER
// los pedidos que tiene asignados y transicionarlos por el subconjunto de estados de
// `changeAssignedOrderStatus` (en_camino/entregado/problema) — nunca gestión
// (catálogo/sucursales/clientes/otros pedidos), a diferencia de admin-orders.ts que
// usa MANAGER_ROLES. Mismo patrón de montaje (authMiddleware + dbSession +
// requirePropertyMembership + assertVerticalRole dentro de cada handler) que el
// resto de rutas de staff de este vertical — ver admin-orders.ts, la referencia de
// convención citada en el diseño de esta fase.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { REPARTIDOR_ROLES, changeAssignedOrderStatus, isOrderStatus, OrderStatusTransitionError } from "@atiende/domain-restaurantes";
import type { Order } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

function serializeOrder(o: Order) {
  return {
    id: o.id,
    propertyId: o.propertyId,
    branch: o.branch,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    customerAddress: o.customerAddress,
    total: o.total,
    status: o.status,
    items: o.items,
    notes: o.notes,
    paymentMethod: o.paymentMethod,
    estimatedDeliveryAt: o.estimatedDeliveryAt,
    incidentNote: o.incidentNote,
    createdAt: o.createdAt,
  };
}

interface RepartidorStatusBody {
  readonly status?: unknown;
  readonly incidentNote?: unknown;
}

export function restaurantesRepartidorOrdersRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/v1/restaurantes/:propertyId/repartidor/orders", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/v1/restaurantes/:propertyId/repartidor/orders/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // Puerto de RepartidorDashboard.tsx::fetchOrders del origen — SIN filtros ni
  // paginación por cursor (ver domain-restaurantes/src/repository.ts, comentario de
  // `listOrdersForRepartidor`): la lista real de "lo que tengo asignado" de una sola
  // persona nunca fue paginada en el origen, un límite fijo generoso basta.
  app.get("/v1/restaurantes/:propertyId/repartidor/orders", async (c) => {
    assertVerticalRole(c, REPARTIDOR_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const orders = await repo.listOrdersForRepartidor(organizationId, c.get("userId"));
    return c.json({ orders: orders.map(serializeOrder) });
  });

  app.get("/v1/restaurantes/:propertyId/repartidor/orders/:orderId", async (c) => {
    assertVerticalRole(c, REPARTIDOR_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const order = await repo.findAssignedOrderById(organizationId, c.get("userId"), c.req.param("orderId"));
    // Nunca distingue "no existe" de "existe pero no es tuyo" -- mismo criterio que
    // admin-orders.ts (findOrderById + scope check -> 404/403 separados) NO aplica
    // aquí a propósito: a diferencia de un staff con alcance de sucursal (donde
    // confirmar "sí existe, pero no es de tu sucursal" no filtra nada sensible), aquí
    // confirmar la EXISTENCIA de un pedido ajeno sería exponer más de lo que el
    // propio repartidor necesita saber -- 404 uniforme, igual que
    // findAssignedOrderById ya devuelve null en ambos casos.
    if (!order) throw Errors.notFound("Pedido no encontrado.");
    return c.json({ order: serializeOrder(order) });
  });

  // Puerto de `update_assigned_order_status()` del origen (ver
  // domain-restaurantes/src/order-lifecycle.ts::changeAssignedOrderStatus para la
  // máquina de estados real + el constraint de incidentNote).
  app.patch("/v1/restaurantes/:propertyId/repartidor/orders/:orderId/status", async (c) => {
    assertVerticalRole(c, REPARTIDOR_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const repartidorId = c.get("userId");
    const orderId = c.req.param("orderId");

    const order = await repo.findAssignedOrderById(organizationId, repartidorId, orderId);
    if (!order) throw Errors.notFound("Pedido no encontrado.");

    const raw = await readJsonCapped<RepartidorStatusBody>(c.req.raw, 4 * 1024);
    if (typeof raw.status !== "string" || !isOrderStatus(raw.status)) {
      throw Errors.validation("status: valor de estado desconocido.");
    }
    if (raw.incidentNote !== undefined && raw.incidentNote !== null && typeof raw.incidentNote !== "string") {
      throw Errors.validation("incidentNote: debe ser texto o venir ausente.");
    }
    const incidentNote = typeof raw.incidentNote === "string" ? raw.incidentNote : null;

    try {
      const updated = await changeAssignedOrderStatus(repo, organizationId, repartidorId, order, raw.status, incidentNote);
      return c.json({ order: serializeOrder(updated) });
    } catch (err) {
      if (err instanceof OrderStatusTransitionError) throw Errors.conflict(err.message);
      throw err;
    }
  });

  return app;
}
