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
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { MANAGER_ROLES, MOTIVOS_CANCELACION, assertOrderCanBeDispatched, cargaDeRepartidor, sugerirRepartidor, avisarProgramadosPromovidos, changeOrderStatus, esMotivoCancelacion, emitirAvisoProgramadoEnCocina, isOrderStatus, OrderStatusTransitionError, promoverProgramadosVencidos, RestaurantesConfigUnavailableError, tryNotifyStaffRepartidorAssigned } from "@atiende/domain-restaurantes";
import type { CandidatoRepartidor, CargaRepartidor, Order, OrderPickupInfo, OrderScheduleInfo, RestaurantesRepository, StaffOrderNotificationRecord } from "@atiende/domain-restaurantes";
import { cortarComandaDePedidoCancelado, encolarComandasDePromovidos } from "@atiende/domain-restaurantes/softrestaurant";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { dispatchWhatsAppVertical, triggerRestaurantesWhatsAppDispatchInline } from "../../internal/whatsapp-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";
import { parseBranchId, resolveEffectivePropertyIds } from "./admin-scope.ts";
import { softRestaurantComandaDeps, softRestaurantStoreFor } from "./softrestaurant-wiring.ts";

/** Canal, propina y hora de recogida (migracion 031). `null` en los tres cuando la base aun no esta migrada o
 * el pedido es anterior: los listados no seleccionan esas columnas, se leen aparte con SAVEPOINT. */
async function pickupInfoByOrder(repo: RestaurantesRepository, organizationId: string, orders: readonly Order[]): Promise<ReadonlyMap<string, OrderPickupInfo>> {
  const rows = await repo.listOrderPickupInfo(organizationId, orders.map((o) => o.id));
  return new Map(rows.map((r) => [r.orderId, r]));
}

/** Programacion (migracion 034) de varios pedidos. `[]` contra la base sin migrar (SAVEPOINT en el repo). */
async function scheduleInfoByOrder(repo: RestaurantesRepository, organizationId: string, orders: readonly Order[]): Promise<ReadonlyMap<string, OrderScheduleInfo>> {
  const rows = await repo.listOrderScheduleInfo(organizationId, orders.map((o) => o.id));
  return new Map(rows.map((r) => [r.orderId, r]));
}

/** Pedidos serializados con canal/propina/hora de recogida (031) y programacion (034) leidos aparte. */
async function serializeOrders(repo: RestaurantesRepository, organizationId: string, orders: readonly Order[]) {
  // Secuencial a proposito: ambas lecturas llevan SAVEPOINT sobre la MISMA transaccion y no deben intercalarse.
  const pickup = await pickupInfoByOrder(repo, organizationId, orders);
  const schedule = await scheduleInfoByOrder(repo, organizationId, orders);
  return orders.map((o) => serializeOrder(o, pickup.get(o.id), schedule.get(o.id)));
}

function serializeOrder(o: Order, pickup?: OrderPickupInfo, schedule?: OrderScheduleInfo) {
  return {
    id: o.id,
    // Folio corto («Venta 1001») = `orders.order_number` (columna de la migracion 001, sin SQL nuevo). `null` si el repositorio no lo trae (p. ej. el de memoria de los tests).
    orderNumber: o.orderNumber ?? null,
    // Entrega real (`orders.delivered_at`, migracion 001); `null` mientras no se entrega o si el repositorio no la trae.
    deliveredAt: o.deliveredAt ?? null,
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
    // PM PR-3: canal / propina / hora prometida de recogida (columnas de la migracion 031).
    canal: pickup?.canal ?? null,
    propina: pickup?.propina ?? null,
    horaRecogida: pickup?.horaRecogida ?? null,
    // R-11 (migracion 034): hora para la que se programo el pedido y cuando se promovio a `pending`. `null` en
    // pedidos normales o contra la base sin migrar.
    programadoPara: schedule?.programadoPara ?? o.programadoPara ?? null,
    promovidoAt: schedule?.promovidoAt ?? o.promovidoAt ?? null,
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
  /** `false` = no avisar por WhatsApp al cliente de este cambio (aviso opcional de "listo para recoger"). */
  readonly notifyCustomer?: unknown;
  /** Obligatorio al cancelar: motivo de la lista cerrada (`MOTIVOS_CANCELACION`); alimenta el historial de transiciones y el KPI de precision del agente. */
  readonly motivo?: unknown;
  /** Nota de la incidencia (solo con `status: "problema"`; 1-2000 caracteres). */
  readonly incidentNote?: unknown;
}

interface AssignRepartidorBody {
  readonly repartidorId?: unknown;
  readonly estimatedDeliveryAt?: unknown;
}

export function restaurantesAdminOrdersRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/v1/restaurantes/:propertyId/admin/orders", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/v1/restaurantes/:propertyId/admin/orders/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/v1/restaurantes/:propertyId/admin/repartidor-sugerido", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/v1/restaurantes/:propertyId/admin/scheduled-orders", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
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

    // R-11: auto-promocion de pedidos programados al CONSULTAR (sin cron). Solo cuando la consulta puede incluir
    // pedidos que acaban de pasar a `pending` (sin filtro de estado o con `pending`/`programado`); un historial
    // por fecha no la dispara. Nunca rompe el listado: un fallo se registra y se sigue.
    if (status === undefined || status === "pending" || status === "programado") {
      await promoverAlConsultar(c, repo, organizationId, propertyIds);
    }
    const page = await repo.listOrders(organizationId, { propertyIds, status, dateFrom, dateTo, limit, cursor });
    return c.json({ orders: await serializeOrders(repo, organizationId, page.orders), nextCursor: page.nextCursor });
  });

  // R-11: pestana "Programados" -- pedidos en estado `programado` (el mas proximo primero). Promueve antes de
  // listar, asi un pedido que ya entro en la anticipacion deja de aparecer aqui y aparece en pendientes.
  // `disponible:false` = la base aun no tiene la migracion 034 (lista vacia honesta, nunca un 500).
  app.get("/v1/restaurantes/:propertyId/admin/scheduled-orders", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const branchId = parseBranchId(c.req.query("branchId"));
    const propertyIds = await resolveEffectivePropertyIds(deps, c, organizationId, branchId);
    const limit = parseLimit(c.req.query("limit"));
    const promovidos = await promoverAlConsultar(c, repo, organizationId, propertyIds);
    const result = await repo.listScheduledOrders(organizationId, { propertyIds, limit });
    return c.json({
      disponible: result.disponible,
      orders: await serializeOrders(repo, organizationId, result.orders),
      promovidos: promovidos.map((o) => o.id),
      serverNow: new Date().toISOString(),
    });
  });

  /** Promueve a `pending` los programados vencidos de las sucursales del alcance. Nunca lanza. */
  async function promoverAlConsultar(
    c: Context<CoreAuthHonoEnv>,
    repo: RestaurantesRepository,
    organizationId: string,
    propertyIds: readonly string[] | null,
  ): Promise<readonly Order[]> {
    try {
      const r = await promoverProgramadosVencidos(repo, organizationId, { propertyIds });
      if (r.promovidos.length > 0) {
        logEvent(c, "info", "restaurantes_programados_promovidos", { organizationId, promovidos: r.promovidos.length });
        // R-29: la comanda al POS solo la puede encolar la sesion de SISTEMA (`pos_comanda_encolar`) y el pedido
        // recien promovido todavia no esta confirmado en esta transaccion de staff: se encola DESPUES del commit,
        // en su propia sesion de sistema. Idempotente; nunca afecta la respuesta (best-effort).
        const promovidos = r.promovidos;
        c.get("postCommitTasks").push(async () => {
          const resumen = await deps.engine.withAppSession({ userId: null }, (db) =>
            encolarComandasDePromovidos(softRestaurantComandaDeps(deps, db, deps.restaurantesRepo(db)), promovidos),
          );
          logEvent(c, "info", "restaurantes_programados_comanda_encolada", { organizationId, ...resumen });
        });
        // Aviso al staff (bandeja + campana) de que el programado entro a cocina, tambien tras el commit y en su propia
        // sesion de sistema: un fallo aqui no afecta la respuesta ni la comanda (tarea aparte).
        c.get("postCommitTasks").push(async () => {
          const resumen = await deps.engine.withAppSession({ userId: null }, (db) => avisarProgramadosPromovidos(deps.restaurantesRepo(db), db, promovidos));
          logEvent(c, "info", "restaurantes_programados_aviso_staff", { organizationId, ...resumen });
        });
      }
      return r.promovidos;
    } catch (err) {
      logEvent(c, "warn", "restaurantes_programados_promocion_fallida", { organizationId, error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  app.get("/v1/restaurantes/:propertyId/admin/orders/:orderId", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const order = await repo.findOrderById(organizationId, c.req.param("orderId"));
    if (!order) throw Errors.notFound("Pedido no encontrado.");
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null && !scope.includes(order.propertyId)) throw Errors.forbidden("No tienes acceso a este pedido.");
    return c.json({ order: (await serializeOrders(repo, organizationId, [order]))[0] });
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
    // Taxonomia cerrada de cancelacion (A-24/C-13): cancelar SIN motivo se rechaza antes de tocar el pedido.
    let motivoCancelacion: string | null = null;
    if (raw.status === "cancelado") {
      if (!esMotivoCancelacion(raw.motivo)) throw Errors.validation(`motivo: obligatorio al cancelar; uno de ${MOTIVOS_CANCELACION.join(", ")}.`);
      motivoCancelacion = raw.motivo;
    }

    try {
      // Blocker A (revisión de PR #169) — `changeOrderStatus` ahora recibe
      // `c.get("db")` para que su best-effort de notificación (tryNotify*, ver
      // order-notifications.ts) pueda envolverse en SAVEPOINT: esta ruta corre en
      // sesión de STAFF, y ese best-effort puede fallar de verdad (p.ej. el SELECT
      // a `restaurantes.whatsapp_channel_config` sin GRANT en la base sin migrar)
      // ANTES de llegar a `triggerInline` de abajo -- sin el SAVEPOINT, ese fallo
      // dejaba la transacción completa abortada y el cambio de estado de ESTE
      // MISMO pedido (el UPDATE que `changeOrderStatus` ya hizo) se perdía con un
      // 2xx pese a que `triggerInline` de abajo ya se protegía con su propio
      // SAVEPOINT.
      // `notifyCustomer: false` salta el aviso por WhatsApp al cliente (aviso OPCIONAL de "listo para recoger").
      if (raw.notifyCustomer !== undefined && typeof raw.notifyCustomer !== "boolean") throw Errors.validation("notifyCustomer: se esperaba true o false.");
      if (motivoCancelacion !== null) {
        // El trigger de `order_status_events` (migracion 050) lee este setting LOCAL a la transaccion: el motivo queda en el historial en la
        // misma transaccion del UPDATE. `set_config` no puede fallar por una base sin migrar; si la sesion no lo soporta (dobles de prueba) se omite.
        try {
          await c.get("db").query("select set_config('app.motivo', $1, true);", [motivoCancelacion]);
        } catch {
          // best-effort: el cambio de estado sigue su curso sin motivo en el historial
        }
      }
      if (raw.incidentNote !== undefined && raw.incidentNote !== null) {
        if (typeof raw.incidentNote !== "string" || raw.incidentNote.trim().length < 1 || raw.incidentNote.trim().length > 2000) throw Errors.validation("incidentNote: se esperaba un texto de 1 a 2000 caracteres.");
        if (raw.status !== "problema") throw Errors.validation('incidentNote solo aplica cuando status es "problema".');
      }
      const updated = await changeOrderStatus(repo, organizationId, order, raw.status, c.get("db"), {
        ...(raw.notifyCustomer === false ? { avisarCliente: false } : {}),
        ...(typeof raw.incidentNote === "string" ? { incidentNote: raw.incidentNote } : {}),
      });
      // Cluster #3 (CRÍTICO) de la auditoría final — `changeOrderStatus` ya
      // encoló internamente (best-effort) el WhatsApp al cliente si el nuevo
      // status aplica (tryNotifyCustomerOnOrderStatusChange, ver
      // order-notifications.ts); disparo inline del drenado, mismo
      // `repo`/transacción (ver comentario de cabecera de
      // routes/internal/whatsapp-dispatch.ts), en vez de esperar al cron diario.
      //
      // Auditoría a2b (CRÍTICO, primo de PR #166) — a diferencia de whatsapp.ts
      // (webhook, sesión de SISTEMA), esta ruta corre en sesión de STAFF
      // (`authMiddleware` -> `dbSession`, `auth.uid()` no nulo): `triggerInline`
      // ahora recibe `c.get("db")` para envolver el drenado en SAVEPOINT (ver
      // whatsapp-dispatch.ts) -- sin esto, `claim_messaging_outbox_batch` lanza
      // 42501 SIEMPRE en esta transacción y, sin SAVEPOINT, dejaba la transacción
      // completa abortada: el cambio de status de ESTE MISMO pedido (línea de
      // arriba) se perdía con un 2xx pese a que `changeOrderStatus` ya había
      // hecho commit lógico dentro de esta misma transacción. Este intento inline
      // en sesión de staff SIEMPRE es un no-op seguro (42501, guard de sesión de
      // sistema) -- el envío real lo hace la tarea post-commit de abajo (Blocker B,
      // revisión de PR #169, mismo patrón que hoteles/folios.ts::runHotelesEmailDispatch).
      await triggerRestaurantesWhatsAppDispatchInline(deps, c.get("db"), repo);
      // Blocker B (revisión de PR #169) — el drenado real solo puede pasar
      // DESPUÉS de que esta transacción confirme, en sesión de SISTEMA
      // (`dispatchWhatsAppVertical` ya existe y pasa el guard `auth.uid() is
      // null`). Sin esto, el WhatsApp al cliente ("tu pedido va en camino") solo
      // salía con el cron diario (`vercel.json`: "55 14 * * *"), hasta ~24h tarde.
      c.get("postCommitTasks").push(() => dispatchWhatsAppVertical(deps, "restaurantes", 5).then(() => undefined));
      // R-29: adelantar a mano un pedido programado a `pending` tambien lo manda a cocina: misma comanda al POS
      // que la promocion automatica (sesion de sistema, post-commit, idempotente por pedido).
      if (order.status === "programado" && updated.status === "pending") {
        const adelantado: Order = { ...updated, programadoPara: updated.programadoPara ?? order.programadoPara };
        c.get("postCommitTasks").push(async () => {
          // Campana (entra a cocina, o atrasado): el adelanto manual solo emite la campana (la bandeja del staff es de la promocion automatica).
          try {
            await deps.engine.withAppSession({ userId: null }, (db) => emitirAvisoProgramadoEnCocina(db, adelantado));
          } catch (err) {
            logEvent(c, "warn", "restaurantes_programados_aviso_adelanto_fallido", { organizationId, error: err instanceof Error ? err.message : String(err) });
          }
          await deps.engine.withAppSession({ userId: null }, (db) =>
            encolarComandasDePromovidos(softRestaurantComandaDeps(deps, db, deps.restaurantesRepo(db)), [adelantado]),
          );
        });
      }
      logEvent(c, "info", "restaurantes_admin_pedido_status_cambiado", { actorUserId: c.get("userId"), organizationId, orderId, status: raw.status });

      // FASE 3 (producto) — "cancelación o reembolso de pedidos" (el catálogo de
      // estados de order-lifecycle.ts no distingue un reembolso de una
      // cancelación simple -- 'cancelado' es el único estado terminal negativo
      // real, ver ORDER_STATUSES/ORDER_TRANSITIONS). Solo se audita ESE
      // estado -- las transiciones normales de operación (preparando/en_camino/
      // entregado/completado) no son la acción sensible que esta fase pide
      // cubrir. Best-effort real, nunca revierte el cambio de estado ya
      // aplicado.
      if (raw.status === "cancelado") {
        await repo.registrarAuditoria({
          organizationId,
          actorUserId: c.get("userId"),
          action: "pedido.cancelado",
          entityType: "pedido",
          entityId: orderId,
          campo: "status",
          antes: order.status,
          despues: "cancelado",
        });
        // Un pedido cancelado antes de llegar al POS no debe llegar a cocina despues (POS lento/caido + reintento del despachador).
        const corte = await cortarComandaDePedidoCancelado(softRestaurantStoreFor(deps, c.get("db")), organizationId, updated, c.get("userId"));
        if (corte.cortadas > 0) logEvent(c, "info", "restaurantes_comanda_cortada_por_cancelacion", { actorUserId: c.get("userId"), organizationId, orderId, cortadas: corte.cortadas });
      }

      return c.json({ order: (await serializeOrders(repo, organizationId, [updated]))[0] });
    } catch (err) {
      if (err instanceof OrderStatusTransitionError) throw Errors.conflict(err.message);
      if (err instanceof RestaurantesConfigUnavailableError) throw Errors.serviceUnavailable("Los estados de recoger todavía no están disponibles en esta base de datos (falta aplicar la migración 031).");
      throw err;
    }
  });

  // Autopiloto (semiautomatico): repartidor SUGERIDO para los pedidos a domicilio en `preparando` sin repartidor. Solo lectura:
  // NO asigna nada (la asignacion sigue siendo el PATCH .../assign-repartidor de abajo, con un clic del gerente). Regla determinista en
  // domain-restaurantes/src/repartidor-sugerido.ts (menos pedidos en_camino; empate: el que lleva mas sin recibir pedido).
  // `?orderIds=a,b,c` (hasta 30). Los pedidos fuera del alcance de sucursal del usuario, de otra organizacion, a recoger, ya asignados o fuera de
  // `preparando` se omiten de la respuesta (nunca revelan su existencia). Sin repartidores dados de alta: `sugerencias` vacio.
  app.get("/v1/restaurantes/:propertyId/admin/repartidor-sugerido", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const ids = [...new Set((c.req.query("orderIds") ?? "").split(",").map((x) => x.trim()).filter((x) => x.length > 0))];
    if (ids.length > 30) throw Errors.validation("orderIds: maximo 30 pedidos por consulta.");
    if (ids.some((id) => !/^[0-9a-fA-F-]{36}$/.test(id))) throw Errors.validation("orderIds: se esperaban ids de pedido validos.");
    if (ids.length === 0) return c.json({ sugerencias: {} });
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    const elegibles: Order[] = [];
    for (const id of ids) {
      const o = await repo.findOrderById(organizationId, id);
      if (!o || o.status !== "preparando" || o.assignedRepartidorId !== null) continue;
      if (scope !== null && !scope.includes(o.propertyId)) continue;
      elegibles.push(o);
    }
    if (elegibles.length === 0) return c.json({ sugerencias: {} });
    // A recoger no lleva repartidor: el canal vive en la migracion 031 y se lee aparte (SAVEPOINT en el repo; base sin migrar = domicilio).
    const pickup = await pickupInfoByOrder(repo, organizationId, elegibles);
    const aDomicilio = elegibles.filter((o) => pickup.get(o.id)?.canal !== "recoger");
    if (aDomicilio.length === 0) return c.json({ sugerencias: {} });
    const miembros = await deps.coreStaffRepo(c.get("db")).listMembersByVerticalRole(organizationId, "repartidor");
    const candidatos: CandidatoRepartidor[] = miembros.map((m) => ({ userId: m.userId, nombre: m.fullName, propertyIds: m.propertyIds ?? null }));
    const cargas = new Map<string, CargaRepartidor>();
    for (const m of candidatos) cargas.set(m.userId, cargaDeRepartidor(await repo.listOrdersForRepartidor(organizationId, m.userId)));
    const sugerencias: Record<string, { repartidorId: string; nombre: string; enCamino: number }> = {};
    for (const o of aDomicilio) {
      const s = sugerirRepartidor(o.propertyId, candidatos, cargas);
      if (s) sugerencias[o.id] = { repartidorId: s.repartidorId, nombre: s.nombre, enCamino: s.enCamino };
    }
    return c.json({ sugerencias });
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

    try {
      await assertOrderCanBeDispatched(repo, organizationId, order);
    } catch (err) {
      if (err instanceof OrderStatusTransitionError) throw Errors.conflict(err.message);
      throw err;
    }

    const updated = await repo.assignRepartidorToOrder(organizationId, orderId, raw.repartidorId, estimatedDeliveryAt);
    if (!updated) throw Errors.notFound("Pedido no encontrado.");
    // Fase 9 — "pedido listo para repartidor" del gap original (ver
    // order-notifications.ts::notifyStaffRepartidorAssignedCore para la
    // justificación completa de por qué este es el evento real, no un status
    // "listo" inventado): best-effort, nunca revierte el dispatch ya persistido.
    await tryNotifyStaffRepartidorAssigned(repo, updated);
    logEvent(c, "info", "restaurantes_admin_pedido_repartidor_asignado", { actorUserId: c.get("userId"), organizationId, orderId, repartidorId: raw.repartidorId, estimatedDeliveryAt });

    // FASE 3 (producto) — "asignación/cambio de repartidor" (mueve dinero: el
    // repartidor asignado es a quien se le liquida la entrega). Best-effort
    // real, nunca revierte el dispatch ya persistido.
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: order.assignedRepartidorId ? "repartidor.reasignado" : "repartidor.asignado",
      entityType: "repartidor",
      entityId: orderId,
      campo: "assignedRepartidorId",
      antes: order.assignedRepartidorId,
      despues: raw.repartidorId,
    });

    return c.json({ order: (await serializeOrders(repo, organizationId, [updated]))[0] });
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
    // Defensa en profundidad: un staff acotado a ciertas sucursales nunca reconoce la notificacion de otra.
    // El alcance viaja DENTRO de la escritura (property_id = any(scope)); un listado acotado a las N mas
    // recientes dejaba sin poder reconocer las pendientes viejas (QA-restaurantes-R1-features-08).
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    try {
      const notification = await repo.acknowledgeStaffOrderNotification(organizationId, notificationId, actorId, scope);
      logEvent(c, "info", "restaurantes_admin_notificacion_reconocida", { actorUserId: actorId, organizationId, notificationId });
      return c.json({ notification: serializeStaffNotification(notification) });
    } catch {
      throw Errors.notFound("Notificación no encontrada.");
    }
  });

  return app;
}
