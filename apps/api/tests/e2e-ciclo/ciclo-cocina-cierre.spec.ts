// R-23: de la cocina al cierre del dia. Pedidos creados por WhatsApp / voz con el motor real; el panel avanza cada
// estado y el comensal recibe UN aviso por estado (outbox -> Graph API simulada); cancelacion antes de cocina; un pedido para recoger
// no sale "en_camino"; saltos de estado invalidos se rechazan; el mismo comensal por dos canales es UN cliente; y el cierre del dia
// se genera (una vez) cuando el dia ya termino. Los agregados del cierre los calcula SQL real (scripts/verify-restaurantes-cierre-dia):
// aqui `calcular` se alimenta de los pedidos que dejo el ciclo para comprobar el cableado (periodo, idempotencia, aviso, auditoria).
import { afterEach, describe, expect, it, vi } from "vitest";
import { DATOS_VACIOS, InMemoryCierreRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../../src/app.ts";
import { authedGet, authedJson } from "../restaurantes-admin-kpis-fixtures.ts";
import { call, say, startCicloStack, startVoiceCall } from "../support/e2e-ciclo-restaurantes.ts";
import type { CicloStack } from "../support/e2e-ciclo-restaurantes.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("e2e cocina, avisos al comensal y cierre del dia", () => {
  let stack: CicloStack;
  afterEach(async () => {
    await stack?.stop();
  });

  const owner = () => stack.ctx.staff.owner.token;
  const admin = (p: string) => stack.url(`/v1/restaurantes/${stack.propertyId}/admin${p}`);
  const patchStatus = (orderId: string, status: string) => fetch(admin(`/orders/${orderId}/status`), authedJson(owner(), status === "cancelado" ? { status, motivo: "cliente_desistio" } : { status }, "PATCH"));
  const pedidos = async () => (await stack.ctx.restaurantesRepo.listOrders(stack.ctx.organizationId, { propertyIds: null, limit: 50 } as never)).orders;
  const avisos = (wa: string) => stack.sim.sentTo(wa).map((m) => m.text ?? "").filter((t) => /su pedido/i.test(t));

  /** Pedido por WhatsApp (guion del LLM; el servidor cotiza y crea). Devuelve el pedido creado. */
  async function pedirPorWhatsApp(wa: string, nombre: string, canal: "domicilio" | "recoger") {
    const items =
      canal === "domicilio"
        ? [
            { product_id: stack.products.bistec3, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: "maiz" },
            { product_id: stack.products.pastor, product_name: "Tacos al Pastor (orden de 3)", requested_quantity: 3, tortilla: "maiz" },
          ]
        : [{ product_id: stack.products.coca, product_name: "Coca-Cola", requested_quantity: 2 }];
    const dom = canal === "domicilio" ? { colonia_entrega: "Francisco de Montejo", customer_address: "Calle 21 #310 x 36 y 38, Francisco de Montejo" } : {};
    stack.setScript([
      call("cotizar_pedido", { branch_slug: "fco-montejo", canal, ...(canal === "domicilio" ? { colonia_entrega: "Francisco de Montejo" } : {}), items }),
      say("Te confirmo el total. Confirmas?"),
      call("confirmar_resumen", {}),
      call("crear_pedido", { branch_slug: "fco-montejo", canal, customer_name: nombre, payment_method: "efectivo", items, ...dom }),
      say("Listo, tu pedido quedo registrado."),
    ]);
    const antes = (await pedidos()).length;
    expect((await stack.sim.deliverText(wa, "Quiero hacer un pedido")).status).toBe(200);
    expect((await stack.sim.deliverText(wa, "Si, confirmo")).status).toBe(200);
    const despues = await pedidos();
    expect(despues).toHaveLength(antes + 1);
    return despues.find((o) => o.customerPhone === wa.slice(-10))!;
  }

  it("domicilio: preparando -> en camino -> entregado -> completado avisa UNA vez por estado y rechaza los saltos", async () => {
    stack = await startCicloStack();
    const wa = "5219991230201";
    const order = await pedirPorWhatsApp(wa, "Ana Domicilio", "domicilio");
    expect(order).toMatchObject({ total: 284, status: "pending" });

    // Saltos invalidos: la maquina de estados responde 4xx y el pedido sigue en pending.
    for (const salto of ["entregado", "en_camino", "completado"]) {
      const r = await patchStatus(order.id, salto);
      expect(r.status, `pending -> ${salto}`).toBe(409);
    }
    expect((await pedidos())[0]!.status).toBe("pending");
    expect(avisos(wa)).toHaveLength(0);

    expect((await patchStatus(order.id, "preparando")).status).toBe(200);
    // Reintento del mismo estado (doble clic): no es transicion valida y no duplica el aviso.
    expect((await patchStatus(order.id, "preparando")).status).toBe(409);
    await stack.dispatchWhatsApp();
    expect(avisos(wa)).toHaveLength(1);
    expect(avisos(wa)[0]).toMatch(/ya lo estamos preparando/);

    // Un pedido a domicilio no sale "listo para recoger".
    expect((await patchStatus(order.id, "listo_para_recoger")).status).toBe(409);

    const asignar = await fetch(admin(`/orders/${order.id}/assign-repartidor`), authedJson(owner(), { repartidorId: stack.ctx.staff.repartidor.id }, "PATCH"));
    expect(asignar.status).toBe(200);
    const rep = stack.ctx.staff.repartidor.token;
    const repartidor = (status: string) => fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/repartidor/orders/${order.id}/status`), authedJson(rep, { status }, "PATCH"));
    expect((await repartidor("preparando")).status).toBeGreaterThanOrEqual(400); // el repartidor no maneja cocina
    expect((await repartidor("en_camino")).status).toBe(200);
    expect((await repartidor("entregado")).status).toBe(200);
    await stack.dispatchWhatsApp();
    const textos = avisos(wa);
    expect(textos).toHaveLength(3);
    expect(textos[1]).toMatch(/va en camino/);
    expect(textos[2]).toMatch(/fue entregado/);

    // Cierre administrativo: `completado` no genera un aviso extra al comensal.
    expect((await patchStatus(order.id, "completado")).status).toBe(200);
    await stack.dispatchWhatsApp();
    expect(avisos(wa)).toHaveLength(3);
    expect((await pedidos())[0]!.status).toBe("completado");
    // Terminal: no se reabre.
    expect((await patchStatus(order.id, "preparando")).status).toBe(409);
    expect(stack.sim.rejected).toHaveLength(0);
  });

  it("recoger: preparando -> listo para recoger -> entregado; nunca sale en camino ni se asigna a repartidor", async () => {
    stack = await startCicloStack();
    const wa = "5219991230202";
    const order = await pedirPorWhatsApp(wa, "Beto Recoger", "recoger");
    expect(order.total).toBe(90);
    expect((await patchStatus(order.id, "preparando")).status).toBe(200);
    expect((await patchStatus(order.id, "en_camino")).status).toBe(409);
    const asignar = await fetch(admin(`/orders/${order.id}/assign-repartidor`), authedJson(owner(), { repartidorId: stack.ctx.staff.repartidor.id }, "PATCH"));
    expect(asignar.status).toBe(409);
    expect((await patchStatus(order.id, "listo_para_recoger")).status).toBe(200);
    expect((await patchStatus(order.id, "entregado")).status).toBe(200);
    await stack.dispatchWhatsApp();
    const textos = avisos(wa);
    expect(textos).toHaveLength(3);
    expect(textos[1]).toMatch(/listo|recoger/i);
    expect(textos[2]).toMatch(/fue entregado/);
    expect(textos.some((t) => /en camino/.test(t))).toBe(false);
  });

  it("cancelacion ANTES de cocina: el gerente cancela, el comensal recibe un solo aviso y la comanda que el POS aun no recibio NO se manda despues", async () => {
    stack = await startCicloStack();
    const wa = "5219991230203";
    // El POS esta caido al crear: la comanda queda en la cola de reintentos.
    stack.pos.inyectarFalla("crearComanda", { tipo: "timeout" });
    const order = await pedirPorWhatsApp(wa, "Caro Cancela", "recoger");
    expect(stack.pos.comandas).toHaveLength(0);

    expect((await patchStatus(order.id, "cancelado")).status).toBe(200);
    await stack.dispatchWhatsApp();
    expect(avisos(wa).filter((t) => /fue cancelado/.test(t))).toHaveLength(1);
    expect((await pedidos())[0]!.status).toBe("cancelado");
    // Terminal: ni cocina ni entrega lo reabren.
    expect((await patchStatus(order.id, "preparando")).status).toBe(409);

    // El POS vuelve y pasa el tiempo del reintento: cocina NO debe recibir un pedido cancelado.
    stack.pos.limpiarFallas();
    vi.setSystemTime(new Date(Date.now() + 30 * 60_000));
    await stack.dispatchPos();
    await stack.dispatchPos();
    expect(stack.pos.comandas, "una comanda de un pedido cancelado llego al POS").toHaveLength(0);
  });

  it("un mismo comensal por WhatsApp y voz es UN cliente con 2 pedidos y 2 comandas; el dia se cierra una sola vez", async () => {
    stack = await startCicloStack();
    const repo = stack.ctx.restaurantesRepo;
    const wa = "5219991230210"; // = 9991230210 en los otros canales

    // 1) WhatsApp
    const porWa = await pedirPorWhatsApp(wa, "Diana Omni", "recoger");
    // 2) Voz (caller ID en otro formato)
    const llamada = await startVoiceCall(stack, "+52 999 123 0210", "call-omni-1");
    const itemsVoz = [{ product_id: stack.products.coca, product_name: "Coca-Cola", requested_quantity: 3 }];
    const cot = await llamada.tool("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: itemsVoz });
    expect(cot.status).toBe(200);
    expect((await llamada.tool("confirmar_resumen", { quote_hash: (cot.body as Json).quote_hash })).status).toBe(200);
    const porVoz = await llamada.tool("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Diana Omni", payment_method: "efectivo", items: itemsVoz });
    expect(porVoz.status).toBe(200);
    expect((porVoz.body as Json).order).toMatchObject({ source: "voice", customerPhone: "9991230210", total: 135 });
    // Un solo cliente; los dos pedidos ligados a el, uno por canal, cada uno con su comanda.
    const todos = await pedidos();
    expect(todos.map((o) => o.source).sort()).toEqual(["voice", "whatsapp"]);
    expect(new Set(todos.map((o) => o.customerPhone))).toEqual(new Set(["9991230210"]));
    const cliente = await repo.findCustomerByPhone(stack.ctx.organizationId, "9991230210");
    expect(cliente?.name).toBe("Diana Omni");
    await vi.waitFor(async () => {
      await stack.dispatchPos();
      expect(stack.pos.comandas).toHaveLength(2);
    });
    expect(new Set(stack.comandas.todas().map((c) => c.orderId)).size).toBe(2);
    // El cliente de WhatsApp se reconoce por voz: historial de 2 pedidos (whatsapp y voz) al momento de la llamada del dia siguiente.
    const otra = await startVoiceCall(stack, "9991230210", "call-omni-2");
    expect((await otra.tool("buscar_cliente", {})).body).toMatchObject({ isNew: false, name: "Diana Omni", orderCount: 2 });

    // Cocina: el de voz se entrega; el de WhatsApp se cancela antes de cocina.
    const cancelado = todos.find((o) => o.id === porWa.id)!;
    for (const o of [todos.find((x) => x.source === "voice")!]) {
      for (const s of ["preparando", "listo_para_recoger", "entregado"]) expect((await patchStatus(o.id, s)).status, `${o.source} -> ${s}`).toBe(200);
    }
    expect((await patchStatus(cancelado.id, "cancelado")).status).toBe(200);
    const final = await pedidos();
    expect(final.filter((o) => o.status === "entregado")).toHaveLength(1);
    expect(final.filter((o) => o.status === "cancelado")).toHaveLength(1);

    // Cierre del dia: solo cuando el dia ya termino (hoy martes 6, cierre del martes 6 se rechaza; del 7 de oct en adelante, si).
    const entregados = final.filter((o) => o.status === "entregado");
    const cierreRepo = new InMemoryCierreRepository({
      sucursales: [{ organizationId: stack.ctx.organizationId, propertyId: stack.propertyId, zonaHoraria: "America/Merida" }],
      calcular: (_p, _t, inicio) =>
        inicio === "2026-10-06"
          ? { ...DATOS_VACIOS, pedidos: final.length, ventasCentavos: entregados.reduce((s, o) => s + Math.round(o.total * 100), 0), cancelados: 1, canceladosCentavos: Math.round(cancelado.total * 100), cancelacionPct: Math.round((100 / final.length) * 10) / 10 }
          : null,
    });
    const appCierre = buildApp({ ...stack.deps, cierreRepo: () => cierreRepo });
    const cierreUrl = `/v1/restaurantes/${stack.propertyId}/admin/cierres`;
    const generar = (fecha: string, token: string = owner()) => appCierre.request(`${cierreUrl}/generar`, authedJson(token, { tipo: "dia", fecha }, "POST"));
    expect((await generar("2026-10-06")).status).toBe(400); // el dia sigue en curso
    vi.setSystemTime(new Date("2026-10-07T15:00:00.000Z"));
    // Los tokens de acceso duran 15 min: al dia siguiente el gerente inicia sesion otra vez.
    const login = async (u: { email: string; password: string }) => ((await (await appCierre.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(u) })).json()) as { token: string }).token;
    const ownerManana = await login(stack.ctx.staff.owner);
    const repartidorManana = await login(stack.ctx.staff.repartidor);
    const primero = await generar("2026-10-06", ownerManana);
    expect(primero.status).toBe(201);
    const c1 = ((await primero.json()) as Json).cierre;
    expect(c1).toMatchObject({ fechaInicio: "2026-10-06", pedidos: 2, cancelados: 1, ventasCentavos: 13500 });
    const segundo = await generar("2026-10-06", ownerManana);
    expect(segundo.status).toBe(200);
    expect(((await segundo.json()) as Json).estado).toBe("existente");
    expect(cierreRepo.generaciones).toBe(2); // se pidio dos veces; el cierre es uno solo
    const lista = (await (await appCierre.request(`${cierreUrl}?tipo=dia`, authedGet(ownerManana))).json()) as Json;
    expect(lista.cierres).toHaveLength(1);
    expect(lista.pendientes).not.toContain("2026-10-06");
    // Un repartidor no genera cierres.
    expect((await generar("2026-10-05", repartidorManana)).status).toBe(403);
  });
});
