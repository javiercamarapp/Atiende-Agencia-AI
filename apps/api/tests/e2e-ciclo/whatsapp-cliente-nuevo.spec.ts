// R-23: ciclo e2e por WhatsApp -- cliente NUEVO. Meta (simulador, HTTP real y firma HMAC) -> webhook real ->
// agente con LLM guionado -> motor real de pedidos -> comanda al POS falso -> aviso al staff -> respuestas
// salientes por Graph API (simulador, ventana de 24 h) -> estados -> cierre por el repartidor.
import { afterEach, describe, expect, it } from "vitest";
import { authedGet, authedJson } from "../restaurantes-admin-kpis-fixtures.ts";
import { call, say, startCicloStack } from "../support/e2e-ciclo-restaurantes.ts";
import type { CicloStack } from "../support/e2e-ciclo-restaurantes.ts";

const PHONE = "5219991230001";

describe("e2e WhatsApp: cliente nuevo pide a domicilio", () => {
  let stack: CicloStack;
  afterEach(async () => {
    await stack?.stop();
  });

  it("registra al cliente, crea el pedido con precio del servidor, manda la comanda al POS y avisa al staff", async () => {
    stack = await startCicloStack();
    const { sim, products } = stack;
    const items = [
      { product_id: products.bistec3, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: "maiz" },
      { product_id: products.pastor, product_name: "Tacos al Pastor (orden de 3)", requested_quantity: 3, tortilla: "maiz" },
    ];
    stack.setScript([
      call("buscar_cliente", {}),
      call("buscar_sucursal_cercana", { colonia: "Francisco de Montejo" }),
      call("cotizar_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Francisco de Montejo", items }),
      say("Son 1 orden de bistec y 1 de pastor por $284. Paga en efectivo o tarjeta y confirma?"),
      call("confirmar_resumen", {}),
      call("crear_pedido", {
        branch_slug: "fco-montejo",
        canal: "domicilio",
        colonia_entrega: "Francisco de Montejo",
        customer_name: "Ana Prueba",
        customer_address: "Calle 21 #310 x 36 y 38, Francisco de Montejo",
        payment_method: "efectivo",
        items,
      }),
      say("Listo, tu pedido quedo registrado y va a cocina."),
    ]);

    const first = await sim.deliverText(PHONE, "Hola, quiero tacos de bistec y de pastor a domicilio en Francisco de Montejo");
    expect(first.status).toBe(200);
    // El aviso de privacidad va en el primer mensaje.
    expect(sim.lastSentTo(PHONE)?.text).toMatch(/privacidad|asistente virtual/i);

    const second = await sim.deliverText(PHONE, "Si, en efectivo. Soy Ana Prueba, Calle 21 #310 x 36 y 38");
    expect(second.status).toBe(200);

    const repo = stack.ctx.restaurantesRepo;
    const customer = await repo.findCustomerByPhone(stack.ctx.organizationId, "9991230001");
    expect(customer?.name).toBe("Ana Prueba");
    expect(await repo.listCustomerAddresses(customer!.id)).toHaveLength(1);
    const list = await repo.listOrders(stack.ctx.organizationId, { propertyIds: null, limit: 10 } as never);
    expect(list.orders).toHaveLength(1);
    const order = list.orders[0]!;
    expect(order).toMatchObject({ total: 284, source: "whatsapp", status: "pending", customerPhone: "9991230001" });

    // Comanda al POS: una sola, con el telefono de la conversacion (nunca el del LLM), idempotente por pedido.
    expect(stack.pos.comandas).toHaveLength(1);
    expect(stack.pos.llamadasCrear[0]).toMatchObject({ sucursal: "T2", tipo: "domicilio", cliente: { telefono: "9991230001" } });
    expect(stack.comandas.todas()[0]).toMatchObject({ estado: "confirmada" });

    // Notificacion in-app al staff (bandeja del panel): pedido nuevo, sin acusar.
    const owner = stack.ctx.staff.owner.token;
    const notifUrl = `/v1/restaurantes/${stack.propertyId}/admin/order-notifications`;
    const notifs = (await (await fetch(stack.url(notifUrl), authedGet(owner))).json()) as { notifications: Array<{ id: string; eventType: string; acknowledgedAt: string | null }> };
    expect(notifs.notifications.map((n) => n.eventType)).toContain("order.created");
    const ack = await fetch(stack.url(`${notifUrl}/${notifs.notifications[0]!.id}/acknowledge`), authedJson(owner, {}, "POST"));
    expect(ack.status).toBe(200);

    // Cocina -> preparando: el comensal recibe el aviso dentro de su ventana de 24 h.
    const patch = (status: string) => fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/orders/${order.id}/status`), authedJson(owner, { status }, "PATCH"));
    expect((await patch("preparando")).status).toBe(200);
    await stack.dispatchWhatsApp();
    expect(sim.lastSentTo(PHONE)?.text).toMatch(/ya lo estamos preparando/);

    // Despacho al repartidor y cierre de la entrega.
    const assign = await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/orders/${order.id}/assign-repartidor`), authedJson(owner, { repartidorId: stack.ctx.staff.repartidor.id }, "PATCH"));
    expect(assign.status).toBe(200);
    const rep = stack.ctx.staff.repartidor.token;
    const repPatch = (status: string) => fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/repartidor/orders/${order.id}/status`), authedJson(rep, { status }, "PATCH"));
    expect((await repPatch("en_camino")).status).toBe(200);
    expect((await repPatch("entregado")).status).toBe(200);
    await stack.dispatchWhatsApp();
    const textos = sim.sentTo(PHONE).map((m) => m.text ?? "");
    expect(textos.some((t) => /va en camino/.test(t))).toBe(true);
    expect(textos.some((t) => /fue entregado/.test(t))).toBe(true);
    expect(sim.rejected).toHaveLength(0);
  });
});
