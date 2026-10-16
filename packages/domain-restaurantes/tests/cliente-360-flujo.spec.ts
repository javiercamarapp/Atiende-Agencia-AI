// Cliente 360 de punta a punta sobre el motor unico de pedidos (repositorio en memoria, registro de herramientas real):
// identificar por telefono, domicilios, gustos aprendidos, repetir con precios de hoy, reincidencia y base sin migrar.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { lookupCustomer } from "../src/customers.ts";
import { OrderValidationError } from "../src/errors.ts";
import { invokeAgentTool, type AgentToolContext } from "../src/agent-tools/registry.ts";
import { createOrder } from "../src/orders.ts";
import type { Order } from "../src/types.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PHONE = "9991234567";

function nuevoMundo() {
  const fixture = buildRestaurantFixture();
  const ctx = (channel: AgentToolContext["channel"] = "whatsapp", phone: string | null = PHONE): AgentToolContext => ({ organizationId: fixture.organizationId, channel, phone });
  let n = 0;
  // Cada pedido lleva una nota distinta: sin ella dos pedidos identicos dentro de 5 minutos se deduplican (a proposito).
  async function pedir(over: Partial<Parameters<typeof createOrder>[1]> = {}) {
    n += 1;
    return createOrder(fixture.repo, {
      ...(over.idempotencyKey ? {} : { notes: `pedido ${n}` }),
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Ana",
      customerPhone: PHONE,
      customerAddress: "Calle 50 #200, Col. Centro",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 2 }],
      source: "whatsapp",
      paymentMethod: "efectivo",
      ...over,
    });
  }
  return { ...fixture, ctx, pedir };
}

function conocido(r: Awaited<ReturnType<typeof lookupCustomer>>) {
  if (r.isNew) throw new Error("se esperaba un cliente conocido");
  return r;
}

describe("identificacion y cliente nuevo", () => {
  it("un telefono nunca visto es cliente nuevo y no tiene pedidos que repetir", async () => {
    const w = nuevoMundo();
    expect(await lookupCustomer(w.repo, w.organizationId, "9990000000")).toEqual({ isNew: true });
    const hist = await invokeAgentTool(w.repo, w.ctx("whatsapp", "9990000000"), "historial_pedidos", {});
    expect(hist.result).toEqual({ pedidos: [], total_pedidos_anteriores: 0 });
    await expect(invokeAgentTool(w.repo, w.ctx("whatsapp", "9990000000"), "repetir_pedido", { branch_slug: "fco-montejo" })).rejects.toBeInstanceOf(OrderValidationError);
  });

  it("el mismo cliente por WhatsApp (+521...) y por voz (10 digitos) es UN solo cliente con la misma memoria", async () => {
    const w = nuevoMundo();
    await w.pedir({ customerPhone: "+52 1 999 123 4567" });
    const porWhatsApp = conocido(await lookupCustomer(w.repo, w.organizationId, "5219991234567"));
    const porVoz = conocido(await lookupCustomer(w.repo, w.organizationId, "9991234567"));
    expect(porVoz.name).toBe("Ana");
    expect(porVoz.domicilios).toEqual(porWhatsApp.domicilios);
    expect(porVoz.orderCount).toBe(porWhatsApp.orderCount);
  });
});

describe("domicilios guardados", () => {
  it("guarda etiqueta, referencias y colonia al confirmar el pedido y el ultimo usado va primero", async () => {
    const w = nuevoMundo();
    await w.pedir({ customerAddress: "Calle Uno 10, Col. Centro", addressLabel: "casa", accessNotes: "porton verde", colonia: "Centro" });
    await w.pedir({ customerAddress: "Av. Dos 20, Col. Norte", addressLabel: "oficina", mapsUrl: "https://maps.example.com/o" });
    const r = conocido(await lookupCustomer(w.repo, w.organizationId, PHONE));
    expect(r.domicilios?.map((d) => d.label)).toEqual(["oficina", "casa"]);
    expect(r.domicilios?.[1]).toMatchObject({ accessNotes: "porton verde", colonia: "Centro", branchSlug: "fco-montejo", timesUsed: 1 });
    expect(r.domicilios?.[0]?.mapsUrl).toBe("https://maps.example.com/o");

    // Volver a pedir a la casa: el uso suma y vuelve a ir primero (sin duplicar el domicilio).
    await w.pedir({ customerAddress: "Calle Uno 10, Col. Centro", items: [{ productId: w.products.cocaCola, requestedQuantity: 3 }] });
    const otra = conocido(await lookupCustomer(w.repo, w.organizationId, PHONE));
    expect(otra.domicilios).toHaveLength(2);
    expect(otra.domicilios?.[0]).toMatchObject({ label: "casa", timesUsed: 2 });
  });

  it("un pedido para recoger no inventa ni borra domicilios", async () => {
    const w = nuevoMundo();
    await w.pedir({ customerAddress: "Calle Uno 10, Col. Centro" });
    await w.pedir({ canal: "recoger", customerAddress: undefined });
    const r = conocido(await lookupCustomer(w.repo, w.organizationId, PHONE));
    expect(r.domicilios).toHaveLength(1);
  });

  it("un link de Maps que no es https no se guarda (el modelo no inventa enlaces)", async () => {
    const w = nuevoMundo();
    await w.pedir({ mapsUrl: "javascript:alert(1)" });
    const r = conocido(await lookupCustomer(w.repo, w.organizationId, PHONE));
    expect(r.domicilios?.[0]?.mapsUrl).toBeNull();
  });

  it("crear_pedido usa la ubicacion COMPARTIDA real solo si el modelo lo pide; nunca coordenadas inventadas", async () => {
    const w = nuevoMundo();
    const ctx: AgentToolContext = { ...w.ctx(), sharedLocation: { lat: 21.01, lng: -89.6 } };
    const args = { branch_slug: "fco-montejo", customer_name: "Ana", customer_address: "Calle 9 #1", items: [{ product_id: w.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }], payment_method: "efectivo" as const };
    await invokeAgentTool(w.repo, ctx, "crear_pedido", { ...args, usar_ubicacion_compartida: true });
    const r = conocido(await lookupCustomer(w.repo, w.organizationId, PHONE));
    expect(r.domicilios?.[0]?.mapsUrl).toBe("https://www.google.com/maps?q=21.01,-89.6");
    await invokeAgentTool(w.repo, ctx, "crear_pedido", { ...args, customer_address: "Otra calle 5", items: [{ product_id: w.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] });
    const sin = conocido(await lookupCustomer(w.repo, w.organizationId, PHONE));
    expect(sin.domicilios?.find((d) => d.address === "Otra calle 5")?.mapsUrl).toBeNull();
  });
});

describe("gustos aprendidos", () => {
  it("se aprenden de pedidos confirmados y solo se proponen desde la segunda vez", async () => {
    const w = nuevoMundo();
    const tacos = (tortilla: "maiz" | "harina") => ({ items: [{ productId: w.products.tacosPastor, requestedQuantity: 3, tortilla }] });
    await w.pedir(tacos("maiz"));
    expect(conocido(await lookupCustomer(w.repo, w.organizationId, PHONE)).gustos?.filter((g) => g.kind === "tortilla")).toEqual([]);
    await w.pedir({ ...tacos("maiz"), notes: "sin cebolla" });
    const r = conocido(await lookupCustomer(w.repo, w.organizationId, PHONE));
    expect(r.gustos?.find((g) => g.kind === "tortilla")).toMatchObject({ value: "maiz", veces: 2, fuente: "pedido" });
  });

  it("gusto cambiado: despues de 2 pedidos con harina, la propuesta pasa a harina", async () => {
    const w = nuevoMundo();
    const tacos = (tortilla: "maiz" | "harina") => ({ items: [{ productId: w.products.tacosPastor, requestedQuantity: 3, tortilla }] });
    for (let i = 0; i < 3; i++) await w.pedir(tacos("maiz"));
    await w.pedir(tacos("harina"));
    expect(conocido(await lookupCustomer(w.repo, w.organizationId, PHONE)).gustos?.find((g) => g.kind === "tortilla")?.value).toBe("maiz");
    await w.pedir(tacos("harina"));
    expect(conocido(await lookupCustomer(w.repo, w.organizationId, PHONE)).gustos?.find((g) => g.kind === "tortilla")?.value).toBe("harina");
  });

  it("el cierre es idempotente por pedido: reintentar el MISMO pedido no cuenta dos veces", async () => {
    const w = nuevoMundo();
    const idempotencyKey = randomUUID();
    const primero = await w.pedir({ idempotencyKey, paymentMethod: "tarjeta" });
    const reintento = await w.pedir({ idempotencyKey, paymentMethod: "tarjeta" });
    expect(reintento.id).toBe(primero.id);
    const mem = await w.repo.getCustomerMemory(w.organizationId, PHONE);
    expect(mem?.preferences.find((p) => p.kind === "pago")?.timesSeen).toBe(1);
    expect(mem?.addresses[0]?.timesUsed).toBe(1);
  });
});

describe("pedidos anteriores y repetir", () => {
  it("historial_pedidos lista solo los del mismo numero (sin cancelados) y repetir re-cotiza con precios de HOY", async () => {
    const w = nuevoMundo();
    await w.pedir({ items: [{ productId: w.products.cocaCola, requestedQuantity: 2 }, { productId: w.products.quesobich, requestedQuantity: 1 }] });
    await w.pedir({ customerPhone: "9990009999", customerName: "Otra persona", items: [{ productId: w.products.cocaCola, requestedQuantity: 9 }] });
    const cancelado = await w.pedir({ items: [{ productId: w.products.cocaCola, requestedQuantity: 7 }], customerAddress: "Calle cancelada 1" });
    await w.repo.updateOrderStatus(w.organizationId, cancelado.id, "pending", "cancelado");

    const hist = (await invokeAgentTool(w.repo, w.ctx(), "historial_pedidos", {})).result as { pedidos: { productos: { name: string; quantity: number }[]; total: number }[] };
    expect(hist.pedidos).toHaveLength(1);
    expect(hist.pedidos[0]!.productos).toEqual([{ name: "Coca-Cola", quantity: 2 }, { name: "Quesobich de Queso", quantity: 1 }]);

    // El precio sube y un producto deja de estar disponible: el total que vale es el de HOY y se avisa de los cambios.
    await w.repo.upsertBranchProductState(w.propertyId, w.products.cocaCola, 50, true);
    await w.repo.upsertBranchProductState(w.propertyId, w.products.quesobich, 120, false);
    const rep = (await invokeAgentTool(w.repo, w.ctx(), "repetir_pedido", { branch_slug: "fco-montejo", canal: "recoger" })).result as {
      quote: { total: number; lines: { name: string; price: number }[] };
      repeticion: { total_anterior: number; cambios: { producto: string; motivo: string; precio_anterior: number; precio_actual: number | null }[] };
    };
    expect(rep.quote.lines).toHaveLength(1);
    expect(rep.quote.lines[0]).toMatchObject({ name: "Coca-Cola", price: 50 });
    expect(rep.quote.total).toBe(100);
    expect(rep.repeticion.total_anterior).toBe(2 * 45 + 120);
    expect(rep.repeticion.cambios).toEqual(
      expect.arrayContaining([
        { producto: "Coca-Cola", motivo: "precio_cambio", precio_anterior: 45, precio_actual: 50 },
        { producto: "Quesobich de Queso", motivo: "ya_no_disponible", precio_anterior: 120, precio_actual: null },
      ]),
    );
  });

  it("repetir un numero de pedido que no es del cliente se rechaza", async () => {
    const w = nuevoMundo();
    await w.pedir();
    await expect(invokeAgentTool(w.repo, w.ctx(), "repetir_pedido", { branch_slug: "fco-montejo", pedido_numero: 999 })).rejects.toBeInstanceOf(OrderValidationError);
  });

  it("repetir sin telefono en el contexto se rechaza (el modelo no elige de quien es el historial)", async () => {
    const w = nuevoMundo();
    await expect(invokeAgentTool(w.repo, w.ctx("whatsapp", null), "historial_pedidos", { phone: PHONE })).rejects.toBeInstanceOf(OrderValidationError);
  });

  it("si ningun producto sigue disponible, lo dice en vez de cotizar vacio", async () => {
    const w = nuevoMundo();
    await w.pedir();
    await w.repo.upsertBranchProductState(w.propertyId, w.products.cocaCola, 45, false);
    await expect(invokeAgentTool(w.repo, w.ctx(), "repetir_pedido", { branch_slug: "fco-montejo" })).rejects.toThrow(/ninguno de los productos/i);
  });
});

function noRecogidoReciente(w: ReturnType<typeof nuevoMundo>, customerId: string, hace: number, status: Order["status"] = "no_recogido"): void {
  w.repo.seedOrderForCustomer({
    id: randomUUID(),
    organizationId: w.organizationId,
    propertyId: w.propertyId,
    customerId,
    customerName: "Ana",
    customerPhone: PHONE,
    customerAddress: null,
    customerEmail: null,
    branch: "Francisco de Montejo",
    total: 45,
    status,
    items: [],
    source: "whatsapp",
    notes: null,
    paymentMethod: "efectivo",
    callTranscript: null,
    callRecordingUrl: null,
    dedupeFingerprint: null,
    idempotencyKey: null,
    createdAt: new Date(Date.now() - hace * 86_400_000).toISOString(),
    assignedRepartidorId: null,
    estimatedDeliveryAt: null,
    incidentNote: null,
  });
}

describe("reincidencia de no recogido y pedido falso", () => {
  const crear = (w: ReturnType<typeof nuevoMundo>, channel: AgentToolContext["channel"] = "whatsapp") =>
    invokeAgentTool(w.repo, w.ctx(channel), "crear_pedido", {
      branch_slug: "fco-montejo",
      customer_name: "Ana",
      customer_address: "Calle 9 #1",
      items: [{ product_id: w.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }],
      payment_method: "efectivo",
    });

  it("con 2 no recogidos en 90 dias el pedido se RETIENE: aviso al staff con todo el pedido y el agente no acusa", async () => {
    const w = nuevoMundo();
    const base = await w.pedir();
    noRecogidoReciente(w, base.customerId!, 10);
    noRecogidoReciente(w, base.customerId!, 30);
    const avisos: { reason?: string; message?: string; customerPhone: string }[] = [];
    const original = w.repo.createCallbackRequest.bind(w.repo);
    vi.spyOn(w.repo, "createCallbackRequest").mockImplementation((input) => {
      avisos.push(input);
      return original(input);
    });
    const out = await crear(w);
    expect(out.orderId).toBeNull();
    const result = out.result as { pedido_retenido: boolean; mensaje: string };
    expect(result.pedido_retenido).toBe(true);
    expect(result.mensaje).toMatch(/la sucursal confirma su pedido en un momento/i);
    expect(result.mensaje).not.toMatch(/falso|fraude|no recogi/i);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ reason: "aprobacion_pedido_cliente", customerPhone: PHONE });
    expect(avisos[0]!.message).toMatch(/PEDIDO RETENIDO/);
    expect(avisos[0]!.message).toMatch(/1x Coca-Cola/);
    // No se creo ningun pedido nuevo (solo el inicial).
    expect((await w.repo.getCustomerMemory(w.organizationId, PHONE))?.orders).toHaveLength(1);
  });

  it("los no recogidos viejos (fuera de la ventana) no cuentan; con 1 reciente tampoco alcanza el umbral", async () => {
    const w = nuevoMundo();
    const base = await w.pedir();
    noRecogidoReciente(w, base.customerId!, 10);
    noRecogidoReciente(w, base.customerId!, 200);
    expect((await crear(w)).orderId).not.toBeNull();
  });

  it("los pedidos marcados como falsos por el staff cuentan igual que los no recogidos", async () => {
    const w = nuevoMundo();
    const base = await w.pedir();
    const otro = await w.pedir({ items: [{ productId: w.products.cocaCola, requestedQuantity: 4 }] });
    await w.repo.markOrderFake(w.organizationId, base.id, true);
    await w.repo.markOrderFake(w.organizationId, otro.id, true);
    expect((await crear(w)).orderId).toBeNull();
    await w.repo.markOrderFake(w.organizationId, otro.id, false);
    expect((await crear(w)).orderId).not.toBeNull();
  });

  it("la politica es configurable y se apaga con 0", async () => {
    const w = nuevoMundo();
    const base = await w.pedir();
    noRecogidoReciente(w, base.customerId!, 10);
    noRecogidoReciente(w, base.customerId!, 20);
    await w.repo.saveCustomerPolicy(w.organizationId, { umbralNoRecogidos: 3, ventanaDias: 90 });
    expect((await crear(w)).orderId).not.toBeNull();
    noRecogidoReciente(w, base.customerId!, 25);
    expect((await crear(w)).orderId).toBeNull();
    await w.repo.saveCustomerPolicy(w.organizationId, { umbralNoRecogidos: 0, ventanaDias: 90 });
    expect((await crear(w)).orderId).not.toBeNull();
  });
});

describe("base SIN migrar (migracion 049 pendiente)", () => {
  it("el agente sigue funcionando como antes: lookup por el camino anterior, pedidos sin cierre y herramientas con aviso honesto", async () => {
    const w = nuevoMundo();
    await w.pedir();
    w.repo.setCliente360Supported(false);
    const r = conocido(await lookupCustomer(w.repo, w.organizationId, PHONE));
    expect(r.name).toBe("Ana");
    expect(r.domicilios).toBeUndefined();
    expect(r.gustos).toBeUndefined();
    const nuevo = await w.pedir({ items: [{ productId: w.products.cocaCola, requestedQuantity: 5 }] });
    expect(nuevo.id).toBeTruthy();
    await expect(invokeAgentTool(w.repo, w.ctx(), "historial_pedidos", {})).rejects.toThrow(/todavía no está disponible/);
    // El cierre no corrio: al migrar no hay datos a medias (solo el pedido inicial se habia aprendido).
    w.repo.setCliente360Supported(true);
    expect((await w.repo.getCustomerMemory(w.organizationId, PHONE))?.preferences.find((p) => p.kind === "pago")?.timesSeen).toBe(1);
  });

  it("la reincidencia no se evalua sin la migracion (el pedido se crea normal, nunca se retiene a ciegas)", async () => {
    const w = nuevoMundo();
    const base = await w.pedir();
    noRecogidoReciente(w, base.customerId!, 10);
    noRecogidoReciente(w, base.customerId!, 20);
    w.repo.setCliente360Supported(false);
    const out = await invokeAgentTool(w.repo, w.ctx(), "crear_pedido", {
      branch_slug: "fco-montejo",
      customer_name: "Ana",
      customer_address: "Calle 9 #1",
      items: [{ product_id: w.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }],
      payment_method: "efectivo",
    });
    expect(out.orderId).not.toBeNull();
  });
});
