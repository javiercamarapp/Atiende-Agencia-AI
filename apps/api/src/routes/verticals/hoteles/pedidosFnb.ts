// REQ-AB-004 (P0/GOB) · /hoteles/:propertyId/pedidos-fnb — superficie MÍNIMA de
// pedidos de F&B necesaria para aplicar la regla de dominio: cuando el huésped
// declara una alergia/restricción alimentaria (campo estructurado O detectada
// defensivamente en texto libre, ver `resolveAllergyDeclared`), el pedido queda
// marcado y NINGÚN endpoint puede "asegurar" al huésped que el platillo es seguro
// hasta que un cocinero (rol `fnb`) lo confirme humanamente
// (`assertCanAssureDishIsSafe`). Port ~directo de
// hoteles/apps/api/src/routes/pedidosFnb.ts (ver diseño Fase 1 hoteles §4.2).
//
// Esto NO implementa enrutamiento a KDS/cocina, SLA de entrega ni cargo a folio — eso
// es un requisito deliberadamente más grande y fuera de esta fase también en el
// origen.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  AllergySafetyAssuranceBlockedError,
  assertCanAssureDishIsSafe,
  canAssureDishIsSafe,
  describeSafetyAssuranceMessage,
  resolveAllergyDeclared,
  TOMAR_PEDIDO_ROLES,
  CONFIRMAR_COCINA_ROLES,
  type FnbOrderItem,
  type FnbOrderRecord,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface ItemBody {
  readonly nombre?: unknown;
  readonly notas?: unknown;
}

interface CrearPedidoBody {
  readonly roomId?: unknown;
  readonly items?: readonly ItemBody[];
  readonly notas?: unknown;
  readonly alergiaDeclarada?: unknown;
}

interface ConfirmarCocinaBody {
  readonly nota?: unknown;
}

function parseItems(raw: unknown): FnbOrderItem[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) {
    throw Errors.validation("items: se esperaba un arreglo de 1 a 50 elementos.");
  }
  return raw.map((entry, index) => {
    const item = entry as ItemBody;
    if (typeof item.nombre !== "string" || item.nombre.trim().length === 0 || item.nombre.length > 150) {
      throw Errors.validation(`items[${index}].nombre: se esperaba un texto no vacío de hasta 150 caracteres.`);
    }
    const notas = typeof item.notas === "string" ? item.notas.trim().slice(0, 500) : undefined;
    return notas ? { nombre: item.nombre.trim(), notas } : { nombre: item.nombre.trim() };
  });
}

function serializePedido(order: FnbOrderRecord) {
  const safetyState = { allergyDeclared: order.allergyDeclared, kitchenConfirmedBy: order.kitchenConfirmedBy };
  return {
    id: order.id,
    roomId: order.roomId,
    items: order.items,
    notas: order.notes,
    alergiaDeclarada: order.allergyDeclared,
    alergiaDetectadaVia: order.allergyDeclaredVia,
    cocineroConfirmoEn: order.kitchenConfirmedAt,
    cocineroConfirmoPor: order.kitchenConfirmedBy,
    // Ambos campos SIEMPRE se calculan en vivo desde la guarda de dominio — nunca se
    // persisten como texto libre editable (REQ-AB-004: "sin confirmación, el sistema
    // no debe afirmarlo").
    puedeAsegurarSeguridad: canAssureDishIsSafe(safetyState),
    mensajeSeguridad: describeSafetyAssuranceMessage(safetyState),
    seguridadAseguradaEn: order.safetyAssuranceSentAt,
    creadoEn: order.createdAt,
  };
}

export function hotelesPedidosFnbRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/pedidos-fnb/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/pedidos-fnb", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/hoteles/:propertyId/pedidos-fnb", async (c) => {
    const repo = deps.hotelesRepo(c.get("db"));
    const orders = await repo.listFnbOrders(c.req.param("propertyId"));
    return c.json(orders.map(serializePedido));
  });

  app.post("/hoteles/:propertyId/pedidos-fnb", async (c) => {
    assertVerticalRole(c, TOMAR_PEDIDO_ROLES);
    const propertyId = c.req.param("propertyId");
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<CrearPedidoBody>(c.req.raw, 16 * 1024);
    const items = parseItems(raw.items);
    const notas = typeof raw.notas === "string" ? raw.notas.trim().slice(0, 1000) : null;
    const roomId = typeof raw.roomId === "string" ? raw.roomId : null;
    const alergiaDeclarada = raw.alergiaDeclarada === true;

    const repo = deps.hotelesRepo(c.get("db"));
    // Red de seguridad fail-closed: si el huésped no marcó el campo estructurado pero
    // SÍ escribió su alergia en una nota libre (notas generales o de algún platillo),
    // el pedido se trata igual que si lo hubiera declarado explícitamente.
    const { allergyDeclared, declaredVia } = resolveAllergyDeclared({
      structuredFlag: alergiaDeclarada,
      freeTextFields: [notas, ...items.map((it) => it.notas ?? null)],
    });

    const created = await repo.insertFnbOrder({
      organizationId,
      propertyId,
      roomId,
      items,
      notes: notas,
      allergyDeclared,
      allergyDeclaredVia: declaredVia,
      createdBy: c.get("userId"),
    });

    return c.json(serializePedido(created), 201);
  });

  app.get("/hoteles/:propertyId/pedidos-fnb/:orderId", async (c) => {
    const repo = deps.hotelesRepo(c.get("db"));
    const order = await repo.findFnbOrder(c.req.param("propertyId"), c.req.param("orderId"));
    if (!order) throw Errors.notFound("Pedido de F&B no encontrado.");
    return c.json(serializePedido(order));
  });

  // Confirmación humana del cocinero (REQ-AB-004): la ÚNICA forma de que
  // kitchenConfirmedBy deje de ser null. Rechaza confirmar un pedido que no declaró
  // alergia — no hay nada que un cocinero deba confirmar en ese caso.
  app.post("/hoteles/:propertyId/pedidos-fnb/:orderId/confirmar-cocina", async (c) => {
    assertVerticalRole(c, CONFIRMAR_COCINA_ROLES);
    const propertyId = c.req.param("propertyId");
    const orderId = c.req.param("orderId");
    const raw = await readJsonCapped<ConfirmarCocinaBody>(c.req.raw, 4 * 1024);
    const nota = typeof raw.nota === "string" ? raw.nota.trim().slice(0, 1000) : null;

    const repo = deps.hotelesRepo(c.get("db"));
    const existing = await repo.findFnbOrder(propertyId, orderId);
    if (!existing) throw Errors.notFound("Pedido de F&B no encontrado.");
    if (!existing.allergyDeclared) {
      throw Errors.conflict("Este pedido no declara alergia/restricción alimentaria; no requiere confirmación de cocina.");
    }

    const updated = await repo.confirmFnbKitchen(propertyId, orderId, c.get("userId"), nota);
    if (!updated) throw Errors.notFound("Pedido de F&B no encontrado.");
    return c.json(serializePedido(updated));
  });

  // Único endpoint que "asegura" al huésped que el platillo es seguro. Llama la
  // guarda de dominio ANTES de persistir nada: si el pedido tiene alergia declarada
  // sin confirmación, lanza 409 y la fila NUNCA se actualiza — safetyAssuranceSentAt
  // se queda en null, evidencia auditable de que el sistema no afirmó seguridad.
  app.post("/hoteles/:propertyId/pedidos-fnb/:orderId/asegurar-seguridad", async (c) => {
    assertVerticalRole(c, CONFIRMAR_COCINA_ROLES);
    const propertyId = c.req.param("propertyId");
    const orderId = c.req.param("orderId");

    const repo = deps.hotelesRepo(c.get("db"));
    const existing = await repo.findFnbOrder(propertyId, orderId);
    if (!existing) throw Errors.notFound("Pedido de F&B no encontrado.");

    try {
      assertCanAssureDishIsSafe({ allergyDeclared: existing.allergyDeclared, kitchenConfirmedBy: existing.kitchenConfirmedBy });
    } catch (err) {
      if (err instanceof AllergySafetyAssuranceBlockedError) throw Errors.conflict(err.message);
      throw err;
    }

    const updated = await repo.assureFnbSafety(propertyId, orderId, c.get("userId"));
    if (!updated) throw Errors.notFound("Pedido de F&B no encontrado.");
    return c.json(serializePedido(updated));
  });

  return app;
}
