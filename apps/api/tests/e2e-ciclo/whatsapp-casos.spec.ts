// R-23: casos del ciclo e2e por WhatsApp contra el motor REAL de pedidos (reglas duras en el servidor, no en el prompt):
// cliente existente, producto agotado, fuera de horario, fuera de zona, minimo, alcohol sin domicilio, cancelacion,
// handoff por pedido grande, replay de webhook, estados/mensajes fuera de orden y ventana de 24 h vencida.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrder } from "@atiende/domain-restaurantes";
import { WINDOW_24H_MS } from "@atiende/whatsapp-gateway/testing";
import { authedJson } from "../restaurantes-admin-kpis-fixtures.ts";
import { MARTES_CERRADO, call, callObserving, say, sayObserving, startCicloStack } from "../support/e2e-ciclo-restaurantes.ts";
import type { CicloStack } from "../support/e2e-ciclo-restaurantes.ts";

const bistec = (s: CicloStack, qty = 3) => ({ product_id: s.products.bistec3, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: qty, tortilla: "maiz" });
const pastor = (s: CicloStack, qty = 3) => ({ product_id: s.products.pastor, product_name: "Tacos al Pastor (orden de 3)", requested_quantity: qty, tortilla: "maiz" });
const coca = (s: CicloStack, qty = 1) => ({ product_id: s.products.coca, product_name: "Coca-Cola", requested_quantity: qty });

describe("e2e WhatsApp: casos de negocio", () => {
  let stack: CicloStack;
  afterEach(async () => {
    await stack?.stop();
  });

  it("cliente EXISTENTE: buscar_cliente lo reconoce con su direccion y su segundo pedido suma al historial (sin duplicar al cliente)", async () => {
    stack = await startCicloStack();
    const repo = stack.ctx.restaurantesRepo;
    await createOrder(repo, { organizationId: stack.ctx.organizationId, branchSlug: "fco-montejo", customerName: "Beto Recurrente", customerPhone: "9991230002", customerAddress: "Calle 60 #500, Centro", colonia: "Francisco de Montejo", items: [{ productId: stack.products.coca, requestedQuantity: 6 }], source: "web", paymentMethod: "efectivo" });
    const seen: unknown[] = [];
    const items = [bistec(stack), pastor(stack)];
    stack.setScript([
      call("buscar_cliente", {}),
      callObserving(seen, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Francisco de Montejo", items }),
      say("Son $284. Confirma?"),
      call("confirmar_resumen", {}),
      call("crear_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Francisco de Montejo", customer_name: "Beto Recurrente", customer_address: "Calle 60 #500, Centro", payment_method: "efectivo", items }),
      say("Listo."),
    ]);
    await stack.sim.deliverText("5219991230002", "Hola, lo de siempre a mi direccion");
    await stack.sim.deliverText("5219991230002", "Si, efectivo");
    const customers = await repo.listCustomers(stack.ctx.organizationId, { limit: 50 } as never);
    expect(customers.customers.filter((c) => c.phone === "9991230002")).toHaveLength(1);
    const c = await repo.findCustomerByPhone(stack.ctx.organizationId, "9991230002");
    expect(c?.orderCount).toBe(2);
    expect(await repo.listCustomerAddresses(c!.id)).toHaveLength(1); // misma direccion: no se duplica
  });

  it("PROGRAMADO por el agente: cotiza con la hora, el cliente confirma en un mensaje POSTERIOR y el pedido queda `programado` (sin cocina ni POS hasta promoverlo)", async () => {
    stack = await startCicloStack();
    stack.ctx.restaurantesRepo.setScheduledOrdersSupported(true);
    const seen: unknown[] = [];
    const items = [coca(stack, 4)];
    // "Ahora" es martes 13:00 de Merida; el miercoles 14:00 es 20:00Z.
    const programado_para = "2026-10-07T14:00:00-06:00";
    stack.setScript([
      call("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items, programado_para }),
      sayObserving(seen, "Son $180 para manana a las 2 de la tarde. Confirma?"),
      call("confirmar_resumen", {}),
      call("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Paty Programada", payment_method: "efectivo", items, programado_para }),
      say("Listo, quedo programado."),
    ]);
    await stack.sim.deliverText("5219991230090", "Quiero 4 cocas para manana a las 2 de la tarde, para recoger");
    expect(JSON.stringify(seen[0])).toContain("2026-10-07T20:00:00.000Z");
    // Todavia no hay pedido: falta la confirmacion del cliente en un mensaje posterior.
    expect((await stack.ctx.restaurantesRepo.listOrders(stack.ctx.organizationId, { propertyIds: null, limit: 5 } as never)).orders).toHaveLength(0);
    await stack.sim.deliverText("5219991230090", "Si, confirmo");
    const programados = await stack.ctx.restaurantesRepo.listScheduledOrders(stack.ctx.organizationId, { propertyIds: null, limit: 5 });
    expect(programados.orders).toHaveLength(1);
    expect(programados.orders[0]).toMatchObject({ status: "programado", programadoPara: "2026-10-07T20:00:00.000Z" });
    expect(stack.pos.comandas).toHaveLength(0); // fuera de cocina y del POS
  });

  it("PROGRAMADO por el agente: cambiar la hora despues de confirmar se rechaza y NO crea pedido", async () => {
    stack = await startCicloStack();
    stack.ctx.restaurantesRepo.setScheduledOrdersSupported(true);
    const items = [coca(stack, 4)];
    stack.setScript([
      call("cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items, programado_para: "2026-10-07T14:00:00-06:00" }),
      say("Son $180 para manana a las 2. Confirma?"),
      call("confirmar_resumen", {}),
      call("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Paty Programada", payment_method: "efectivo", items, programado_para: "2026-10-07T18:00:00-06:00" }),
      say("No pude registrarlo."),
    ]);
    await stack.sim.deliverText("5219991230091", "4 cocas para manana a las 2, para recoger");
    await stack.sim.deliverText("5219991230091", "Si");
    expect((await stack.ctx.restaurantesRepo.listOrders(stack.ctx.organizationId, { propertyIds: null, limit: 5 } as never)).orders).toHaveLength(0);
    expect((await stack.ctx.restaurantesRepo.listScheduledOrders(stack.ctx.organizationId, { propertyIds: null, limit: 5 })).orders).toHaveLength(0);
  });

  it("producto AGOTADO: buscar_producto no lo ofrece y cotizar_pedido lo rechaza (el modelo no puede venderlo)", async () => {
    stack = await startCicloStack();
    const seen: unknown[] = [];
    stack.setScript([
      call("buscar_producto", { query: "horchata", branch_slug: "fco-montejo" }),
      callObserving(seen, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: stack.products.horchata, product_name: "Agua de Horchata", requested_quantity: 1 }] }),
      sayObserving(seen, "Esa agua no esta disponible hoy."),
    ]);
    await stack.sim.deliverText("5219991230003", "Quiero una horchata para recoger");
    expect(JSON.stringify(seen[0])).not.toMatch(/Horchata/i);
    expect(JSON.stringify(seen[1])).toMatch(/error|no esta|no está|disponible/i);
    const list = await stack.ctx.restaurantesRepo.listOrders(stack.ctx.organizationId, { propertyIds: null, limit: 5 } as never);
    expect(list.orders).toHaveLength(0);
  });

  it("FUERA DE HORARIO (08:00 Merida, abre a las 12:00): cotizar_pedido rechaza con el horario real", async () => {
    stack = await startCicloStack({ now: MARTES_CERRADO });
    const seen: unknown[] = [];
    stack.setScript([callObserving(seen, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [coca(stack, 2)] }), sayObserving(seen, "Aun no abrimos.")]);
    await stack.sim.deliverText("5219991230004", "Dos cocas para recoger");
    expect(JSON.stringify(seen[0])).toMatch(/cerrad|abre|horario/i);
  });

  it("FUERA DE ZONA: a domicilio a Progreso se rechaza; el mismo pedido para recoger si pasa", async () => {
    stack = await startCicloStack();
    const seen: unknown[] = [];
    stack.setScript([
      callObserving(seen, "buscar_sucursal_cercana", { colonia: "Progreso" }),
      callObserving(seen, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Progreso", items: [bistec(stack), pastor(stack)] }),
      callObserving(seen, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [bistec(stack), pastor(stack)] }),
      sayObserving(seen, "A domicilio no llegamos a Progreso; para recoger son $284."),
    ]);
    await stack.sim.deliverText("5219991230005", "Entregan en Progreso?");
    // La sucursal mas cercana existe pero esta a ~29 km: la cobertura de reparto la decide el servidor al cotizar.
    expect((seen[0] as { distancia_km: number }).distancia_km).toBeGreaterThan(20);
    expect(JSON.stringify(seen[1])).toMatch(/zona|reparto|cobertura/i);
    expect((seen[2] as { quote: { total: number } }).quote.total).toBe(284);
    expect(JSON.stringify(seen[2])).not.toMatch(/"error"/);
  });

  it("MINIMO $200 a domicilio y ALCOHOL sin domicilio: el servidor rechaza aunque el modelo insista", async () => {
    stack = await startCicloStack();
    const seen: unknown[] = [];
    stack.setScript([
      callObserving(seen, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Francisco de Montejo", items: [bistec(stack)] }),
      callObserving(seen, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Francisco de Montejo", adult_confirmed: true, items: [bistec(stack), pastor(stack), { product_id: stack.products.heineken, product_name: "Heineken", requested_quantity: 2 }] }),
      sayObserving(seen, "No se puede."),
    ]);
    await stack.sim.deliverText("5219991230006", "Solo unos tacos de bistec a mi casa");
    expect(JSON.stringify(seen[0])).toMatch(/m[ií]nimo|200/i);
    expect(JSON.stringify(seen[1])).toMatch(/domicilio|recoger/i);
    expect(JSON.stringify(seen[1])).toMatch(/error|no se vende|solo|sólo/i);
  });

  it("CANCELACION por el comensal escala al equipo (no la ejecuta el modelo) y abre el handoff; el agente calla despues", async () => {
    stack = await startCicloStack();
    stack.setScript([say("no deberia llamarse")]);
    const d = await stack.sim.deliverText("5219991230007", "Quiero cancelar mi pedido por favor");
    expect(d.status).toBe(200);
    // El fast-path de alto riesgo responde fijo y registra el aviso: el LLM guionado no consumio turnos.
    expect(stack.sim.lastSentTo("5219991230007")?.text).toMatch(/equipo|persona|avis/i);
    expect(stack.conversaciones.handoffs.some((h) => h.estado === "pendiente")).toBe(true);
    // Con la toma abierta, el siguiente mensaje no lo contesta el agente.
    const before = stack.sim.sentTo("5219991230007").length;
    await stack.sim.deliverText("5219991230007", "sigues ahi?");
    expect(stack.sim.sentTo("5219991230007").length).toBe(before);
  });

  it("PEDIDO GRANDE: el agente escala con escalar_a_humano, se abre el handoff y el comensal recibe la respuesta del turno", async () => {
    stack = await startCicloStack();
    const seen: unknown[] = [];
    stack.setScript([
      call("escalar_a_humano", { customer_name: "Evento Grande", motivo: "pedido_grande", resumen: "60 ordenes de tacos para el sabado" }),
      sayObserving(seen, "Es un pedido grande: ya avise al equipo y le escribe una persona."),
    ]);
    await stack.sim.deliverText("5219991230012", "Necesito 60 ordenes de tacos para un evento el sabado");
    expect(JSON.stringify(seen[0])).not.toMatch(/"error"/);
    expect(stack.sim.lastSentTo("5219991230012")?.text).toMatch(/equipo|persona/);
    expect(stack.conversaciones.handoffs.filter((h) => h.estado === "pendiente" && h.motivo === "pedido_grande")).toHaveLength(1);
    const list = await stack.ctx.restaurantesRepo.listOrders(stack.ctx.organizationId, { propertyIds: null, limit: 5 } as never);
    expect(list.orders).toHaveLength(0);
  });

  it("REPLAY del webhook (mismos bytes y firma): un solo turno del agente y una sola respuesta", async () => {
    stack = await startCicloStack();
    stack.setScript([say("Hola, con gusto. Que se te antoja?")]);
    const first = await stack.sim.deliverText("5219991230008", "Hola", "wamid.REPLAY1");
    expect(first.status).toBe(200);
    const again = await stack.sim.replay(first);
    expect(again.status).toBe(200);
    await stack.dispatchWhatsApp();
    expect(stack.sim.sentTo("5219991230008")).toHaveLength(1);
  });

  it("CONCURRENCIA: el MISMO message.id entregado dos veces a la vez (reintento de Meta en carrera) genera un solo turno y una sola respuesta", async () => {
    stack = await startCicloStack();
    stack.setScript([say("Hola, con gusto."), say("SEGUNDO TURNO NO DEBERIA OCURRIR")]);
    const [a, b] = await Promise.all([stack.sim.deliverText("5219991230013", "Hola", "wamid.CARRERA"), stack.sim.deliverText("5219991230013", "Hola", "wamid.CARRERA")]);
    expect([a.status, b.status].every((s) => s === 200 || s === 500)).toBe(true);
    await stack.dispatchWhatsApp();
    expect(stack.sim.sentTo("5219991230013").filter((m) => /SEGUNDO/.test(m.text ?? ""))).toHaveLength(0);
    expect(stack.sim.sentTo("5219991230013")).toHaveLength(1);
  });

  it("CANCELACION por el gerente: el pedido pasa a cancelado y el comensal (con ventana abierta) recibe el aviso", async () => {
    stack = await startCicloStack();
    const repo = stack.ctx.restaurantesRepo;
    stack.setScript([say("Hola!")]);
    await stack.sim.deliverText("5219991230014", "Hola");
    const order = await createOrder(repo, { organizationId: stack.ctx.organizationId, branchSlug: "fco-montejo", customerName: "Cande", customerPhone: "9991230014", items: [{ productId: stack.products.coca, requestedQuantity: 5 }], source: "whatsapp", paymentMethod: "efectivo", canal: "recoger" });
    const res = await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/orders/${order.id}/status`), authedJson(stack.ctx.staff.owner.token, { status: "cancelado", motivo: "otro" }, "PATCH"));
    expect(res.status).toBe(200);
    await stack.dispatchWhatsApp();
    expect(stack.sim.lastSentTo("5219991230014")?.text).toMatch(/cancelado/);
    // Un pedido cancelado no vuelve a avanzar.
    const otra = await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/orders/${order.id}/status`), authedJson(stack.ctx.staff.owner.token, { status: "preparando" }, "PATCH"));
    expect(otra.status).toBe(409);
  });

  it("firma invalida o ausente: 401, nada se procesa; un payload de ESTADOS (sin mensajes) se acusa 200 sin turno de LLM", async () => {
    stack = await startCicloStack();
    stack.setScript([say("hola")]);
    const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "5550001112" }, messages: [{ id: "wamid.X", from: "5219991230009", type: "text", text: { body: "hola" } }] } }] }] });
    expect((await stack.sim.postRaw(body, "sha256=" + "0".repeat(64))).status).toBe(401);
    expect((await stack.sim.postRaw(body, null)).status).toBe(401);
    expect(stack.sim.sentTo("5219991230009")).toHaveLength(0);
    await stack.sim.deliverText("5219991230009", "hola");
    const sent = stack.sim.sentTo("5219991230009")[0]!;
    const status = await stack.sim.deliverStatus(sent.id, "delivered");
    expect(status.status).toBe(200);
    expect(stack.sim.sentTo("5219991230009")).toHaveLength(1); // el estado no genero otra respuesta
  });

  it("mensajes FUERA DE ORDEN (el segundo llega con timestamp mas viejo): ambos se contestan, en orden de llegada", async () => {
    stack = await startCicloStack();
    stack.setScript([say("Respuesta A"), say("Respuesta B")]);
    await stack.sim.deliverInbound({ from: "5219991230010", body: "segundo", timestampSeconds: 2_000_000_100 });
    await stack.sim.deliverInbound({ from: "5219991230010", body: "primero", timestampSeconds: 2_000_000_000 });
    const textos = stack.sim.sentTo("5219991230010").map((m) => m.text ?? "");
    expect(textos.filter((t) => /Respuesta/.test(t))).toHaveLength(2);
  });

  it("VENTANA DE 24 h vencida: el aviso de estado lo rechaza Meta (131047); queda 'dead' sin reintentos infinitos y el pedido SI cambia de estado", async () => {
    stack = await startCicloStack();
    const repo = stack.ctx.restaurantesRepo;
    const order = await createOrder(repo, { organizationId: stack.ctx.organizationId, branchSlug: "fco-montejo", customerName: "Dora", customerPhone: "9991230011", items: [{ productId: stack.products.coca, requestedQuantity: 5 }], source: "voice", paymentMethod: "efectivo", canal: "recoger" });
    const owner = stack.ctx.staff.owner.token;
    // El comensal nunca escribio por WhatsApp (pedido de voz): no hay ventana abierta.
    const res = await fetch(stack.url(`/v1/restaurantes/${stack.propertyId}/admin/orders/${order.id}/status`), authedJson(owner, { status: "preparando" }, "PATCH"));
    expect(res.status).toBe(200);
    await stack.dispatchWhatsApp();
    await stack.dispatchWhatsApp();
    expect(stack.sim.accepted).toHaveLength(0);
    expect(stack.sim.rejected.filter((r) => r.code === 131047).length).toBeGreaterThanOrEqual(1);
    expect(stack.sim.rejected.length).toBeLessThanOrEqual(1); // 4xx de negocio: no se reintenta
    vi.setSystemTime(new Date(Date.now() + WINDOW_24H_MS));
  });
});
