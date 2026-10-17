// R12 romper (ronda 2) -- categoria E: FALLAS DE INFRAESTRUCTURA. Cola de cocina / impresion caida, notificaciones al equipo caidas, conexion perdida a mitad de crear_pedido (antes o
// despues de guardar), reintentos y reenvios de webhook fuera de orden, mensaje duplicado de dos instancias, estados de pedido que llegan en desorden. Modelo simulado +
// repositorio en memoria; la capa Postgres real (SAVEPOINT, reclamos, leases) esta en scripts/verify-restaurantes-pm-r12-romper-2/.
// Criterio: el cliente recibe una respuesta honesta, no se pierde ni se duplica un pedido, y una pieza caida (cocina, avisos) no tumba lo que ya se guardo.
import { FakeLlmProvider } from "@atiende/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAIM_STALE_MS } from "../../src/agent-tools/order-flow.ts";
import { OrderStatusTransitionError, assertValidOrderStatusTransition, nextValidStatuses } from "../../src/order-lifecycle.ts";
import { handleInboundWhatsAppMessage } from "../../src/whatsapp/inbound.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import type { OrderStatus } from "../../src/types.ts";
import { seedConfirmedOrderFlow } from "../support/order-flow-seed.ts";
import { NEW_CUSTOMER, PHONE, buildRestaurantFixture, flujo, gatewayDe, handlerConGuion, itemsCoca, llamada, ordenes, pasoDelTurno, texto } from "./arnes.ts";
import type { Fixture } from "./arnes.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const crearPedidoCon = (f: Fixture, payment = "efectivo") => llamada("crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Ana", payment_method: payment, items: itemsCoca(f, 2) });
const sembrar = (f: Fixture) => seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, productName: "Coca-Cola", requestedQuantity: 2 }] });
const mensajes = [{ role: "user" as const, content: "dos coca para recoger" }, { role: "assistant" as const, content: "Total $90.00. ¿Confirma?" }, { role: "user" as const, content: "si" }];

describe("R12-E1 cocina / impresion / avisos caidos DESPUES de guardar el pedido", () => {
  it("la cola de la comanda lanza un error: el pedido queda guardado, el cliente lo sabe y no se pierde nada", async () => {
    const f = buildRestaurantFixture();
    await sembrar(f);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const provider = new FakeLlmProvider({ id: "g", script: (req) => (pasoDelTurno(req) === 0 ? crearPedidoCon(f) : texto("Listo, su pedido quedó registrado.")) });
    const handler = createLlmWhatsAppTurnHandler(f.repo, gatewayDe([provider]), {
      defaultRole: "default",
      escalatedRole: "escalated",
      encolarComanda: async () => {
        throw new Error("SoftRestaurant 503");
      },
    });
    const r = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: mensajes, customer: NEW_CUSTOMER } as never);
    expect(r.orderId).toBeTruthy();
    expect(await ordenes(f)).toHaveLength(1);
    expect(r.reply).toMatch(/registrado/);
  });

  it("el aviso al equipo de 'pedido nuevo' falla (cola de mensajes caida): el pedido NO se revierte", async () => {
    const f = buildRestaurantFixture();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(f.repo, "enqueueMessagingOutbox").mockRejectedValue(new Error("outbox caido"));
    const s = flujo(f);
    await s.quote(2);
    s.next();
    await s.confirm();
    const out = await s.seguro("crear_pedido", { ...s.base(2), customer_name: "Ana", payment_method: "efectivo" });
    expect(out.orderId).toBeTruthy();
    expect(await ordenes(f)).toHaveLength(1);
  });

  it("el cierre de ciclo del cliente (ficha 360) falla: el pedido ya guardado no se pierde", async () => {
    const f = buildRestaurantFixture();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(f.repo, "addCustomerAddressIfNew").mockRejectedValue(new Error("tabla sin migrar"));
    const s = flujo(f);
    const base = { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Centro", items: itemsCoca(f, 2) };
    await s.seguro("cotizar_pedido", base);
    s.next();
    await s.confirm();
    const out = await s.seguro("crear_pedido", { ...base, customer_name: "Ana", payment_method: "efectivo", customer_address: "Calle 50 #200 x 3 y 5" });
    // O se crea, o se rechaza limpio con error de sistema: nunca un pedido a medias ni una excepcion cruda.
    const total = (await ordenes(f)).length;
    expect(total === 1 ? out.orderId : out.orderId === null).toBeTruthy();
  });
});

describe("R12-E2 la conexion se pierde a mitad de crear_pedido", () => {
  it("se pierde ANTES de guardar: el pedido NO existe, el cliente no lee 'registrado', y al reintentar (pasada la ventana del reclamo) se crea UNO", async () => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    await s.quote(2);
    s.next();
    await s.confirm();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(f.repo, "upsertCustomer").mockRejectedValueOnce(new Error("connection terminated unexpectedly"));
    const primero = await s.seguro("crear_pedido", { ...s.base(2), customer_name: "Ana", payment_method: "efectivo" });
    expect(primero.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
    // Dentro de la ventana del reclamo (60 s) el servidor pide esperar en vez de arriesgar un duplicado...
    const pronto = await s.seguro("crear_pedido", { ...s.base(2), customer_name: "Ana", payment_method: "efectivo" });
    expect(pronto.orderId).toBeNull();
    // ...y pasada la ventana se crea exactamente uno.
    vi.setSystemTime(new Date(Date.now() + CLAIM_STALE_MS + 1000));
    const despues = await s.seguro("crear_pedido", { ...s.base(2), customer_name: "Ana", payment_method: "efectivo" });
    expect(despues.orderId).toBeTruthy();
    expect(await ordenes(f)).toHaveLength(1);
  });

  it("se pierde DESPUES de guardar (la respuesta nunca llega): el reintento NO crea un segundo pedido", async () => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    await s.quote(2);
    s.next();
    await s.confirm();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = f.repo.createOrderIdempotent.bind(f.repo);
    vi.spyOn(f.repo, "createOrderIdempotent").mockImplementationOnce(async (...a) => {
      await original(...a); // el pedido SI se guardo
      throw new Error("connection terminated unexpectedly"); // pero la respuesta se perdio
    });
    const primero = await s.seguro("crear_pedido", { ...s.base(2), customer_name: "Ana", payment_method: "efectivo" });
    expect(primero.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + CLAIM_STALE_MS + 1000));
    const reintento = await s.seguro("crear_pedido", { ...s.base(2), customer_name: "Ana", payment_method: "efectivo" });
    expect(reintento.orderId).toBeTruthy();
    expect(await ordenes(f)).toHaveLength(1); // sigue siendo UNO
  });

  it("el modelo dice 'quedo registrado' tras una conexion perdida ANTES de guardar: la respuesta final no lo afirma (honestidad)", async () => {
    const f = buildRestaurantFixture();
    await sembrar(f);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(f.repo, "upsertCustomer").mockRejectedValue(new Error("connection terminated unexpectedly"));
    const { handler } = handlerConGuion(f.repo, (req) => (pasoDelTurno(req) === 0 ? crearPedidoCon(f) : texto("Listo, su pedido quedó registrado y ya está en cocina.")));
    const r = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: mensajes, customer: NEW_CUSTOMER } as never);
    expect(r.orderId).toBeNull();
    expect(await ordenes(f)).toHaveLength(0);
    expect(r.reply).not.toMatch(/qued[óo] registrado|ya est[áa] en cocina/i);
  });
});

describe("R12-E3 reintentos y reenvios del webhook (fuera de orden, tardios, de dos instancias)", () => {
  it("un 'si' que llega ANTES que el pedido (fuera de orden) no crea nada; despues llega el pedido y se cotiza normal", async () => {
    const f = buildRestaurantFixture();
    // El modelo es optimista: ante un "si" intenta confirmar y crear sin que exista cotizacion.
    const { handler } = handlerConGuion(f.repo, (req) => {
      const ultimo = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const paso = pasoDelTurno(req);
      if (/^si$/i.test(ultimo.trim())) {
        if (paso === 0) return llamada("confirmar_resumen", {});
        if (paso === 1) return crearPedidoCon(f);
        return texto("¿Qué le gustaría pedir?");
      }
      return texto("Con gusto, ¿para recoger o a domicilio?");
    });
    const base = { organizationId: f.organizationId, phone: PHONE, phoneNumberId: "pn-1" };
    const b = await handleInboundWhatsAppMessage(f.repo, handler, { ...base, messageId: "wamid.fo-b", body: "si" });
    const a = await handleInboundWhatsAppMessage(f.repo, handler, { ...base, messageId: "wamid.fo-a", body: "quiero dos coca" });
    expect(b.ok).toBe(true);
    expect(a.ok).toBe(true);
    expect(await ordenes(f)).toHaveLength(0);
    expect(b.reply).not.toMatch(/qued[óo] registrado|confirmado/i);
  });

  it("un reenvio de Meta de un mensaje YA procesado, dias despues, se acusa sin turno nuevo, sin respuesta y sin pedido", async () => {
    const f = buildRestaurantFixture();
    const { handler, provider } = handlerConGuion(f.repo, () => texto("Hola, ¿qué le gustaría pedir?"));
    const args = { organizationId: f.organizationId, messageId: "wamid.replay", phone: PHONE, body: "hola", phoneNumberId: "pn-1" };
    expect((await handleInboundWhatsAppMessage(f.repo, handler, args)).reply).toBeTruthy();
    vi.setSystemTime(new Date(Date.now() + 3 * 86_400_000));
    const replay = await handleInboundWhatsAppMessage(f.repo, handler, args);
    expect(replay).toEqual({ ok: true, retryable: false });
    expect(provider.callCount).toBe(1);
  });

  it("DOS INSTANCIAS (dos manejadores) reciben el mismo mensaje de Meta a la vez: un solo turno, una sola respuesta, un solo pedido", async () => {
    const f = buildRestaurantFixture();
    await sembrar(f);
    const a = handlerConGuion(f.repo, (req) => (pasoDelTurno(req) === 0 ? llamada("confirmar_resumen", {}) : pasoDelTurno(req) === 1 ? crearPedidoCon(f) : texto("Listo, su pedido quedó registrado.")));
    const b = handlerConGuion(f.repo, (req) => (pasoDelTurno(req) === 0 ? llamada("confirmar_resumen", {}) : pasoDelTurno(req) === 1 ? crearPedidoCon(f) : texto("Listo, su pedido quedó registrado.")));
    const args = { organizationId: f.organizationId, messageId: "wamid.dos-instancias", phone: PHONE, body: "si", phoneNumberId: "pn-1" };
    const [ra, rb] = await Promise.all([handleInboundWhatsAppMessage(f.repo, a.handler, args), handleInboundWhatsAppMessage(f.repo, b.handler, args)]);
    expect([ra.ok, rb.ok]).toEqual([true, true]);
    expect(a.provider.callCount + b.provider.callCount).toBeGreaterThan(0);
    expect(await ordenes(f)).toHaveLength(1);
    const respuestas = [ra, rb].filter((r) => r.reply);
    expect(respuestas).toHaveLength(1);
  });

  it("la respuesta no se pudo encolar (outbox caido) en el PRIMER intento: el mensaje queda reintentable y el reintento (outbox sano) responde una vez sin repetir el pedido", async () => {
    const f = buildRestaurantFixture();
    await sembrar(f);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { handler } = handlerConGuion(f.repo, (req) => (pasoDelTurno(req) === 0 ? llamada("confirmar_resumen", {}) : pasoDelTurno(req) === 1 ? crearPedidoCon(f) : texto("Listo, su pedido quedó registrado.")));
    const fallo = vi.spyOn(f.repo, "enqueueMessagingOutbox").mockRejectedValueOnce(new Error("outbox caido"));
    const args = { organizationId: f.organizationId, messageId: "wamid.outbox-caido", phone: PHONE, body: "si", phoneNumberId: "pn-1" };
    const primero = await handleInboundWhatsAppMessage(f.repo, handler, args);
    expect(primero.retryable).toBe(true);
    fallo.mockRestore();
    const segundo = await handleInboundWhatsAppMessage(f.repo, handler, args);
    expect(segundo.ok).toBe(true);
    expect(await ordenes(f)).toHaveLength(1);
  });
});

describe("R12-E4 estados del pedido que llegan en desorden o repetidos (POS, repartidor, panel)", () => {
  const todos: readonly OrderStatus[] = ["pending", "preparando", "en_camino", "entregado", "cancelado", "completado", "problema", "listo_para_recoger", "no_recogido", "programado", "por_aprobar"];

  it("un estado ATRASADO que intenta retroceder el pedido (entregado -> preparando, completado -> en_camino, cancelado -> pending...) se rechaza con un error de transicion", () => {
    const regresiones: ReadonlyArray<readonly [OrderStatus, OrderStatus]> = [
      ["entregado", "preparando"], ["entregado", "en_camino"], ["entregado", "pending"], ["completado", "en_camino"], ["completado", "preparando"], ["cancelado", "pending"],
      ["cancelado", "preparando"], ["en_camino", "pending"], ["en_camino", "preparando"], ["preparando", "pending"], ["pending", "entregado"], ["programado", "preparando"],
    ];
    for (const [de, a] of regresiones) expect(() => assertValidOrderStatusTransition(de, a), `${de} -> ${a}`).toThrow(OrderStatusTransitionError);
  });

  it("repetir el MISMO estado (webhook reenviado) tampoco es una transicion: se rechaza sin cambiar nada", () => {
    for (const s of todos) expect(() => assertValidOrderStatusTransition(s, s), s).toThrow(OrderStatusTransitionError);
  });

  it("los estados terminales (cancelado, completado) no tienen salida; ninguna transicion valida apunta a un estado inexistente", () => {
    expect(nextValidStatuses("cancelado")).toEqual([]);
    expect(nextValidStatuses("completado")).toEqual([]);
    for (const s of todos) for (const a of nextValidStatuses(s)) expect(todos).toContain(a);
  });

  it("una actualizacion con el estado de origen DESACTUALIZADO (otra persona o un reintento lo cambio antes) no pisa nada: devuelve null", async () => {
    const f = buildRestaurantFixture();
    const s = flujo(f);
    await s.quote(2);
    s.next();
    await s.confirm();
    const creado = await s.seguro("crear_pedido", { ...s.base(2), customer_name: "Ana", payment_method: "efectivo" });
    const id = creado.orderId!;
    expect(await f.repo.updateOrderStatus(f.organizationId, id, "pending", "preparando")).not.toBeNull();
    // El reintento atrasado todavia cree que esta en pending:
    expect(await f.repo.updateOrderStatus(f.organizationId, id, "pending", "cancelado")).toBeNull();
    expect((await f.repo.findOrderById(f.organizationId, id))?.status).toBe("preparando");
  });
});
