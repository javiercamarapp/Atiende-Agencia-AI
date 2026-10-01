// R-23: ciclo e2e por VOZ. La telefonia emite el token de llamada con el caller ID; el agente (guion, sin red)
// invoca las tools por HTTP real; el telefono NUNCA sale de lo que dice el modelo. Cierra con el registro de la
// conversacion (voz-interno), la comanda al POS, el aviso al staff y el KPI.
import { afterEach, describe, expect, it } from "vitest";
import { createOrder } from "@atiende/domain-restaurantes";
import { authedGet } from "../restaurantes-admin-kpis-fixtures.ts";
import { E2E_SECRETS, ORG_SLUG, startCicloStack, startVoiceCall } from "../support/e2e-ciclo-restaurantes.ts";
import type { CicloStack } from "../support/e2e-ciclo-restaurantes.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("e2e voz: llamada de punta a punta", () => {
  let stack: CicloStack;
  afterEach(async () => {
    await stack?.stop();
  });

  it("cliente NUEVO llama: lo identifica el caller ID, arma el pedido con el motor real y queda comanda + aviso al staff + conversacion cerrada", async () => {
    stack = await startCicloStack();
    const call = await startVoiceCall(stack, "+52 999 123 0020", "call-e2e-1");
    const items = [
      { product_id: stack.products.bistec3, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: "maiz" },
      { product_id: stack.products.pastor, product_name: "Tacos al Pastor (orden de 3)", requested_quantity: 3, tortilla: "maiz" },
    ];
    // 1) buscar_cliente: sin telefono en el cuerpo -> sale del token. Cliente nuevo.
    const lookup = await call.tool("buscar_cliente", {});
    expect(lookup.body).toEqual({ isNew: true });
    // 2) sucursal, producto y cotizacion (el servidor calcula el total).
    expect((await call.tool("buscar_sucursal_cercana", { colonia: "Francisco de Montejo" })).body).toMatchObject({ encontrada: true, branch_slug: "fco-montejo" });
    const quote = await call.tool("cotizar_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Francisco de Montejo", items });
    expect(quote.status).toBe(200);
    expect((quote.body as Json).quote.total).toBe(284);
    // 3) crear sin confirmar: la maquina de estados lo rechaza.
    const sinConfirmar = await call.tool("crear_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Francisco de Montejo", customer_name: "Luis Llamada", customer_phone: "9990000000", customer_address: "Calle 21 #310, Francisco de Montejo", payment_method: "efectivo", items });
    expect(sinConfirmar.status).toBe(400);
    // 4) confirmar y crear: el `customer_phone` del modelo (otro numero) se IGNORA, manda el caller ID.
    expect((await call.tool("confirmar_resumen", { quote_hash: (quote.body as Json).quote_hash })).status).toBe(200);
    const created = await call.tool("crear_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Francisco de Montejo", customer_name: "Luis Llamada", customer_phone: "9990000000", customer_address: "Calle 21 #310, Francisco de Montejo", payment_method: "efectivo", items });
    expect(created.status).toBe(200);
    const order = (created.body as Json).order;
    expect(order).toMatchObject({ source: "voice", total: 284, status: "pending", customerPhone: "9991230020" });
    expect((created.body as Json).comanda).toMatchObject({ estado: "confirmada" });
    expect(stack.pos.comandas).toHaveLength(1);
    // Reintento del mismo crear_pedido (el proveedor de voz reintenta): no duplica pedido ni comanda.
    const retry = await call.tool("crear_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Francisco de Montejo", customer_name: "Luis Llamada", customer_address: "Calle 21 #310, Francisco de Montejo", payment_method: "efectivo", items });
    expect(retry.status).not.toBe(500);
    const list = await stack.ctx.restaurantesRepo.listOrders(stack.ctx.organizationId, { propertyIds: null, limit: 10 } as never);
    expect(list.orders).toHaveLength(1);
    expect(stack.pos.comandas).toHaveLength(1);

    // 5) cliente creado y reconocido en la siguiente llamada (otro formato de telefono).
    const next = await startVoiceCall(stack, "9991230020", "call-e2e-2");
    const again = await next.tool("buscar_cliente", {});
    expect(again.body).toMatchObject({ isNew: false, name: "Luis Llamada", orderCount: 1 });

    // 6) staff: aviso de pedido nuevo en la bandeja.
    const notifs = (await (await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/order-notifications`), authedGet(stack.ctx.staff.owner.token))).json()) as { notifications: Array<{ eventType: string }> };
    expect(notifs.notifications.map((n) => n.eventType)).toContain("order.created");

    // 7) registro de la conversacion por el servicio de voz (sistema) y KPI de herramienta.
    const sys = { "content-type": "application/json", "x-atiende-internal-secret": E2E_SECRETS.internalSecret };
    const orgId = stack.ctx.organizationId;
    const ini = await fetch(stack.url("/internal/restaurantes/voz/conversaciones"), { method: "POST", headers: sys, body: JSON.stringify({ organizationId: orgId, propertyId: stack.propertyId, externalId: "call-e2e-1", canal: "llamada", proveedor: "gemini-3.8-live", voiceId: "Kore", callerPhone: "+52 999 123 0020" }) });
    expect(ini.status).toBe(201);
    const { conversationId } = (await ini.json()) as { conversationId: string };
    const turno = await fetch(stack.url(`/internal/restaurantes/voz/conversaciones/${conversationId}/turnos`), { method: "POST", headers: sys, body: JSON.stringify({ organizationId: orgId, seq: 0, rol: "cliente", texto: "Quiero tacos, mi tarjeta es 4111 1111 1111 1111" }) });
    expect(turno.status).toBe(200);
    stack.voz.seedOrder(order.id, orgId);
    const cerrar = await fetch(stack.url(`/internal/restaurantes/voz/conversaciones/${conversationId}/cerrar`, ), { method: "POST", headers: sys, body: JSON.stringify({ organizationId: orgId, resultado: "pedido_creado", orderId: order.id }) });
    expect(cerrar.status).toBe(200);
    // El gerente ve la conversacion en el panel: transcripcion redactada y sin telefono en claro.
    const detalle = await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/voz/conversaciones/${conversationId}`), authedGet(stack.ctx.staff.owner.token));
    expect(detalle.status).toBe(200);
    const detalleTexto = await detalle.text();
    expect(detalleTexto).toMatch(/pedido_creado/);
    expect(detalleTexto).not.toMatch(/4111 1111 1111 1111/);
    expect(detalleTexto).not.toMatch(/9991230020/);
  });

  it("aislamiento: con token de llamada el modelo no puede pedir el historial de OTRO numero, y un secreto equivocado es 401", async () => {
    stack = await startCicloStack();
    await createOrder(stack.ctx.restaurantesRepo, { organizationId: stack.ctx.organizationId, branchSlug: "fco-montejo", customerName: "Victima", customerPhone: "9991230030", colonia: "Francisco de Montejo", customerAddress: "Calle 9 #1", items: [{ productId: stack.products.coca, requestedQuantity: 6 }], source: "web", paymentMethod: "efectivo" });
    const call = await startVoiceCall(stack, "9991230031", "call-e2e-3");
    const res = await call.tool("buscar_cliente", { phone: "9991230030" });
    expect(res.body).toEqual({ isNew: true }); // se ignora el telefono del cuerpo: es el 9991230031
    // sin token y con el secreto equivocado: 401
    const raw = JSON.stringify({ phone: "9991230030" });
    const bad = await fetch(stack.url(`/v1/restaurantes/${ORG_SLUG}/customers/lookup`), { method: "POST", headers: { "content-type": "application/json", "content-length": String(raw.length), "x-atiende-tool-secret": "otro" }, body: raw });
    expect(bad.status).toBe(401);
  });

  it("llamada fuera de horario / minimo: las reglas duras se aplican igual que por WhatsApp", async () => {
    stack = await startCicloStack();
    const call = await startVoiceCall(stack, "9991230040", "call-e2e-4");
    const q = await call.tool("cotizar_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Francisco de Montejo", items: [{ product_id: stack.products.bistec3, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: "maiz" }] });
    expect(q.status).toBe(400);
    expect(JSON.stringify(q.body)).toMatch(/200|m[ií]nimo/i);
  });
});
