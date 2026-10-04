// R-23: paso a humano CON REGRESO. Un pedido grande escala al equipo (el agente calla); el gerente toma la conversacion, responde
// al comensal y la DEVUELVE al agente; el siguiente mensaje del comensal vuelve a contestarlo el agente y puede cerrar un pedido
// normal. Tambien: cerrar (en vez de devolver) reabre al agente y una toma ajena no la libera otro gerente sin ser administrador.
import { afterEach, describe, expect, it } from "vitest";
import { authedGet, authedJson } from "../restaurantes-admin-kpis-fixtures.ts";
import { call, say, sayObserving, startCicloStack } from "../support/e2e-ciclo-restaurantes.ts";
import type { CicloStack } from "../support/e2e-ciclo-restaurantes.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const PHONE = "5219991230101";

describe("e2e handoff con regreso al agente", () => {
  let stack: CicloStack;
  afterEach(async () => {
    await stack?.stop();
  });

  const admin = (path: string) => `/v1/restaurantes/${stack.propertyId}/admin${path}`;

  async function escalarPedidoGrande() {
    const seen: unknown[] = [];
    stack.setScript([
      call("escalar_a_humano", { customer_name: "Evento Grande", motivo: "pedido_grande", resumen: "60 ordenes de tacos para el sabado" }),
      sayObserving(seen, "Es un pedido grande: ya avise al equipo y le escribe una persona."),
    ]);
    await stack.sim.deliverText(PHONE, "Necesito 60 ordenes de tacos para un evento el sabado");
    expect(JSON.stringify(seen[0])).not.toMatch(/"error"/);
    const handoff = stack.conversaciones.handoffs.find((h) => h.estado === "pendiente" && h.motivo === "pedido_grande");
    expect(handoff).toBeDefined();
    return handoff!;
  }

  it("pedido grande: escala, el gerente toma, responde y DEVUELVE; el agente vuelve a contestar y cierra un pedido normal", async () => {
    stack = await startCicloStack();
    const owner = stack.ctx.staff.owner.token;
    const handoff = await escalarPedidoGrande();

    // La bandeja del panel lo muestra pendiente, sin pedido creado todavia.
    const bandeja = (await (await fetch(stack.url(admin("/conversaciones?estado=pendiente")), authedGet(owner))).json()) as Json;
    expect(bandeja.disponible).toBe(true);
    expect(JSON.stringify(bandeja.items)).toMatch(/pedido_grande/);
    expect((await stack.ctx.restaurantesRepo.listOrders(stack.ctx.organizationId, { propertyIds: null, limit: 5 } as never)).orders).toHaveLength(0);

    // Pendiente: el agente calla (el guion del LLM esta agotado: un turno de LLM reventaria el webhook).
    const antes = stack.sim.sentTo(PHONE).length;
    await stack.sim.deliverText(PHONE, "alguien me puede atender?");
    expect(stack.sim.sentTo(PHONE).length).toBe(antes);

    // El gerente toma la conversacion; mientras esta tomada el agente sigue callado.
    const tomar = await fetch(stack.url(admin(`/conversaciones/whatsapp/${handoff.conversationId}/tomar`)), authedJson(owner, {}, "POST"));
    expect(tomar.status).toBe(201);
    expect(stack.conversaciones.handoffs.find((h) => h.id === handoff.id)?.estado).toBe("tomada");
    const respuesta = await fetch(stack.url(admin(`/handoffs/${handoff.id}/responder`)), authedJson(owner, { texto: "Hola, soy Ana del equipo: te cotizo el evento ahora mismo." }, "POST"));
    expect(respuesta.status).toBe(201);
    expect(stack.conversaciones.outbox.some((o) => o.to.endsWith("9991230101") && /te cotizo el evento/.test(o.body))).toBe(true);
    const tomadaAntes = stack.sim.sentTo(PHONE).length;
    await stack.sim.deliverText(PHONE, "perfecto, gracias");
    expect(stack.sim.sentTo(PHONE).length).toBe(tomadaAntes);

    // Devolver al agente: queda `devuelta` y el comensal vuelve a recibir respuesta automatica.
    const devolver = await fetch(stack.url(admin(`/handoffs/${handoff.id}/devolver`)), authedJson(owner, {}, "POST"));
    expect(devolver.status).toBe(200);
    expect(await devolver.json()).toMatchObject({ estado: "devuelta", cambio: true });
    expect(stack.conversaciones.handoffs.find((h) => h.id === handoff.id)?.estado).toBe("devuelta");

    const items = [{ product_id: stack.products.coca, product_name: "Coca-Cola", requested_quantity: 6 }];
    stack.setScript([
      call("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items }),
      say("Son 6 Coca-Cola por $270 para recoger. Confirmas?"),
      call("confirmar_resumen", {}),
      call("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Evento Grande", payment_method: "efectivo", items }),
      say("Listo, tu pedido quedo registrado."),
    ]);
    await stack.sim.deliverText(PHONE, "mejor solo 6 cocas para recoger");
    expect(stack.sim.lastSentTo(PHONE)?.text).toMatch(/\$270/);
    await stack.sim.deliverText(PHONE, "si, confirmo");
    const { orders } = await stack.ctx.restaurantesRepo.listOrders(stack.ctx.organizationId, { propertyIds: null, limit: 5 } as never);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ total: 270, source: "whatsapp", status: "pending", customerPhone: "9991230101" });
    expect(stack.pos.comandas).toHaveLength(1);
    expect(stack.sim.rejected).toHaveLength(0);
  });

  it("cerrar el handoff (sin devolver) tambien libera al agente; un handoff ya cerrado no cambia dos veces", async () => {
    stack = await startCicloStack();
    const owner = stack.ctx.staff.owner.token;
    const handoff = await escalarPedidoGrande();
    const cerrar = () => fetch(stack.url(admin(`/handoffs/${handoff.id}/cerrar`)), authedJson(owner, {}, "POST"));
    const primera = await cerrar();
    expect(primera.status).toBe(200);
    expect(await primera.json()).toMatchObject({ estado: "cerrada", cambio: true });
    expect(await (await cerrar()).json()).toMatchObject({ cambio: false });

    stack.setScript([say("Hola de nuevo, en que te ayudo?")]);
    await stack.sim.deliverText(PHONE, "hola otra vez");
    expect(stack.sim.lastSentTo(PHONE)?.text).toMatch(/en que te ayudo/);
  });
});
