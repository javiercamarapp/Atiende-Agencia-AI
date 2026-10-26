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
import { emitirNotificacion } from "@atiende/db";
import { REPARTIDOR_ROLES, changeAssignedOrderStatus, isOrderStatus, maskPhone, toWhatsAppRecipient, OrderStatusTransitionError } from "@atiende/domain-restaurantes";
import type { Order } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { dispatchWhatsAppVertical, triggerRestaurantesWhatsAppDispatchInline } from "../../internal/whatsapp-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";

/** Tope de veces que un repartidor puede pedir el telefono de UN pedido (cada una queda en la bitacora de accesos). */
export const MAX_LLAMADAS_POR_PEDIDO = 5;
/** Estados en los que el repartidor aun puede necesitar llamar. Terminado el pedido, el numero deja de estar disponible. */
const ESTADOS_LLAMABLES: readonly string[] = ["pending", "preparando", "en_camino", "listo_para_recoger", "problema"];

function serializeOrder(o: Order) {
  return {
    id: o.id,
    propertyId: o.propertyId,
    branch: o.branch,
    customerName: o.customerName,
    // PRIVACIDAD: el repartidor nunca recibe el numero completo en listados ni fichas (solo los ultimos 4 digitos, para reconocerlo).
    // El numero real sale unicamente de `POST .../orders/:orderId/llamar`, que lo registra en la bitacora de accesos.
    customerPhone: maskPhone(o.customerPhone),
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

  // «Llamar»: UNICA vía por la que el repartidor obtiene el telefono completo de SU pedido asignado y aun no terminado. Cada
  // pulsacion queda en la bitacora (`restaurantes.registrar_acceso`, migracion 097; la leen owner/admin) y hay un tope por pedido. El
  // numero viaja solo en esta respuesta (E.164, para el enlace `tel:`); nunca en listados ni en la bitacora.
  app.post("/v1/restaurantes/:propertyId/repartidor/orders/:orderId/llamar", async (c) => {
    assertVerticalRole(c, REPARTIDOR_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const order = await repo.findAssignedOrderById(organizationId, c.get("userId"), c.req.param("orderId"));
    if (!order) throw Errors.notFound("Pedido no encontrado.");
    if (!ESTADOS_LLAMABLES.includes(order.status)) throw Errors.conflict("El pedido ya terminó: el teléfono del cliente ya no está disponible.");
    const telefono = toWhatsAppRecipient(order.customerPhone);
    if (!telefono) throw Errors.conflict("Este pedido no tiene un teléfono válido para llamar.");
    // Llave de idempotencia del cliente web (cabecera `Idempotency-Key`, como manda `repartidor-client.ts`; el cuerpo es un respaldo): un reintento
    // por mala red con la misma llave NO consume cupo. Sin llave valida, cada llamada cuenta.
    const llaveValida = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);
    const cuerpo = (await readJsonCapped<{ llave?: unknown }>(c.req.raw, 1024).catch(() => ({}))) as { llave?: unknown };
    const llave = llaveValida(c.req.header("Idempotency-Key")) ?? llaveValida(cuerpo.llave);
    const acceso = await repo.registrarAcceso({ organizationId, propertyId: order.propertyId, actorUserId: c.get("userId"), action: "pii.llamar", entityId: order.id, llave });
    // Sin bitacora no hay telefono: si la 097 no esta aplicada no se entrega el numero (ni sin auditoria ni sin tope).
    if (!acceso.registrado) throw Errors.serviceUnavailable("El registro de accesos no está disponible: por ahora no se puede mostrar el teléfono. Avisa a tu encargado.");
    if (acceso.intentos > MAX_LLAMADAS_POR_PEDIDO) {
      throw Errors.tooManyRequests("Ya pediste el teléfono de este pedido varias veces. Si necesitas más, avisa a tu encargado.");
    }
    return c.json({ telefono });
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
      // Blocker A (revisión de PR #169) — mismo hotfix que admin-orders.ts: se pasa
      // `c.get("db")` a `changeAssignedOrderStatus` para que su best-effort de
      // notificación pueda envolverse en SAVEPOINT (esta ruta también corre en
      // sesión de STAFF).
      const updated = await changeAssignedOrderStatus(repo, organizationId, repartidorId, order, raw.status, incidentNote, c.get("db"));
      // R-16: una incidencia del repartidor (status `problema`) es "algo que fallo" para el staff: aviso in-app por el productor
      // compartido (catalogo `restaurantes.pedido.incidencia_repartidor`; los destinatarios y las preferencias por persona las
      // resuelve la base). Uno por incidencia (clave = id del pedido + minuto UTC del reporte: un pedido que vuelve a `problema` tras resolverse avisa de nuevo y un reintento del mismo PATCH no duplica), sin PII ni texto de la nota; best-effort dentro de un SAVEPOINT
      // (emitirNotificacion): nunca revierte ni rompe el cambio de estado.
      if (updated.status === "problema") {
        await emitirNotificacion(c.get("db"), { evento: "restaurantes.pedido.incidencia_repartidor", organizationId, propertyId: updated.propertyId, clave: `${updated.id}-${new Date().toISOString().slice(0, 16).replace(/\D/g, "")}`, entidadTipo: "order", entidadId: updated.id });
      }
      // Cluster #3 (CRÍTICO) de la auditoría final — mismo disparo inline
      // best-effort que admin-orders.ts::PATCH .../status (changeAssignedOrderStatus
      // también puede encolar el WhatsApp al cliente vía
      // tryNotifyCustomerOnOrderStatusChange), mismo `repo`/transacción.
      //
      // Auditoría a2b (CRÍTICO, primo de PR #166) — mismo hotfix de SAVEPOINT que
      // admin-orders.ts (ver ese comentario y whatsapp-dispatch.ts): esta ruta
      // también corre en sesión de STAFF (repartidor autenticado), así que
      // `claim_messaging_outbox_batch` también lanza 42501 siempre aquí. Igual que
      // en admin-orders.ts, este intento inline SIEMPRE es un no-op seguro en
      // sesión de staff -- el envío real lo hace la tarea post-commit de abajo
      // (Blocker B, revisión de PR #169).
      await triggerRestaurantesWhatsAppDispatchInline(deps, c.get("db"), repo);
      // Blocker B (revisión de PR #169) — mismo criterio que admin-orders.ts: el
      // drenado real corre DESPUÉS del commit, en sesión de SISTEMA.
      c.get("postCommitTasks").push(() => dispatchWhatsAppVertical(deps, "restaurantes", 5).then(() => undefined));
      return c.json({ order: serializeOrder(updated) });
    } catch (err) {
      if (err instanceof OrderStatusTransitionError) throw Errors.conflict(err.message);
      throw err;
    }
  });

  return app;
}
