// QA R1 -- pedido grande (agentes-09 y viaje-05, WhatsApp y voz): la regla de PM (> $4,000, > 5 kg, o > $2,500 si el numero no tiene
// historial y paga en efectivo) la hace cumplir el SERVIDOR en crear_pedido, aunque el modelo olvide escalar: el pedido NO entra a
// cocina, queda el aviso `escalada:pedido_grande` con el resumen y el modelo recibe un resultado normal (no un error).
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluarPedidoGrande, pesoTotalKg } from "../../src/pedido-grande.ts";
import { correrGuion } from "../../src/voz/simulador/correr-guion.ts";
import { BRANCH_SLUG_PRINCIPAL } from "../../src/voz/simulador/mundo-voz.ts";
import type { MemoriaTools, PasoAgente } from "../../src/voz/simulador/tipos.ts";
import { banco, call, item, say } from "./r1-arnes-whatsapp-pm.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("evaluarPedidoGrande / pesoTotalKg (puras)", () => {
  const base = { total: 100, pesoKg: 0, pagaEfectivo: false, sinHistorial: false };
  it("umbrales exactos: $4,000 y 5 kg NO son grandes; un centavo o un gramo mas, si", () => {
    expect(evaluarPedidoGrande({ ...base, total: 4000 })).toBeNull();
    expect(evaluarPedidoGrande({ ...base, total: 4000.01 })).toBe("total");
    expect(evaluarPedidoGrande({ ...base, pesoKg: 5 })).toBeNull();
    expect(evaluarPedidoGrande({ ...base, pesoKg: 5.25 })).toBe("peso");
  });
  it("> $2,500 solo si el numero no tiene historial Y paga en efectivo", () => {
    expect(evaluarPedidoGrande({ ...base, total: 2501, sinHistorial: true, pagaEfectivo: true })).toBe("sin_historial_efectivo");
    expect(evaluarPedidoGrande({ ...base, total: 2501, sinHistorial: true, pagaEfectivo: false })).toBeNull();
    expect(evaluarPedidoGrande({ ...base, total: 2501, sinHistorial: false, pagaEfectivo: true })).toBeNull();
    expect(evaluarPedidoGrande({ ...base, total: 2500, sinHistorial: true, pagaEfectivo: true })).toBeNull();
  });
  it("el peso sale del nombre del renglon por su cantidad; tacos y bebidas suman 0", () => {
    expect(pesoTotalKg([{ name: "Pastor — 2 kg", quantity: 3 }, { name: "Pastor — 500 g", quantity: 2 }, { name: "Taco Al Pastor (individual)", quantity: 10 }, { name: "Coca-Cola", quantity: 2 }])).toBe(7);
  });
});

describe("WhatsApp (T7, PM): el modelo 'olvida' escalar", () => {
  async function cotizarYConfirmar(b: Awaited<ReturnType<typeof banco>>, tel: string, items: ReturnType<typeof item>[], pago: "efectivo" | "tarjeta", extra: Record<string, unknown> = {}) {
    b.setGuion([call("cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", items }), say("Total cotizado. ¿Confirma?")]);
    await b.enviar(tel, "quiero para recoger");
    b.setGuion([call("confirmar_resumen", {}), call("crear_pedido", { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Fiesta", payment_method: pago, items, ...extra }), say("Listo, su pedido quedó registrado.")]);
    return b.enviar(tel, `si ${pago}`);
  }
  const pedidosPending = async (b: Awaited<ReturnType<typeof banco>>) => (await b.w.repo.listOrders(b.w.organizationId, { propertyIds: null, limit: 100 })).orders;

  it("agentes-09: $4,020 en efectivo de un numero sin historial NO se crea; queda el aviso pedido_grande en T7 y se abre el handoff", async () => {
    const b = await banco();
    const items = [item(b.pid("Pastor — 2 kg"), "Pastor — 2 kg", 2), item(b.pid("Taco Al Pastor (individual)"), "Taco Al Pastor (individual)", 10, "maiz")];
    const r = await cotizarYConfirmar(b, "+5219990000013", items, "efectivo");
    expect(r.orderId).toBeNull();
    expect(await pedidosPending(b)).toHaveLength(0);
    const aviso = b.callbacks().find((c) => c.reason === "escalada:pedido_grande");
    expect(aviso?.propertyId).toBe(b.t7);
    expect(aviso?.message).toMatch(/NO se mando a cocina/);
    expect(aviso?.message).toContain("4020");
    expect(r.escalated).toBe(true);
  });

  it("viaje-05: 6 kg ($6,600) en efectivo de un numero nuevo no entra a cocina", async () => {
    const b = await banco();
    const items = [item(b.pid("Bistec de Res — 2 kg"), "Bistec de Res — 2 kg", 3)];
    const r = await cotizarYConfirmar(b, "+5219990000025", items, "efectivo");
    expect(await pedidosPending(b)).toHaveLength(0);
    expect(b.callbacks().some((c) => c.reason === "escalada:pedido_grande")).toBe(true);
    expect(r.escalated).toBe(true);
  });

  it("el modelo no ve un error: el resultado de crear_pedido es el aviso y no sube al modelo caro", async () => {
    const b = await banco();
    const items = [item(b.pid("Bistec de Res — 2 kg"), "Bistec de Res — 2 kg", 3)];
    await cotizarYConfirmar(b, "+5219990000026", items, "efectivo");
    expect(b.roles().every((rol) => rol === "qa")).toBe(true);
  });

  it("4 kg y $3,600 (bajo los umbrales) SI se crean normal con tarjeta aunque el numero no tenga historial", async () => {
    const b = await banco();
    const items = [item(b.pid("Pastor — 2 kg"), "Pastor — 2 kg", 1), item(b.pid("Pastor — 1 kg"), "Pastor — 1 kg", 2)];
    const r = await cotizarYConfirmar(b, "+5219990000027", items, "tarjeta");
    expect(r.orderId).toBeTruthy();
    expect((await pedidosPending(b)).length).toBe(1);
    expect(b.callbacks().some((c) => c.reason === "escalada:pedido_grande")).toBe(false);
  });

  it("$3,600 en efectivo: de un numero SIN historial se retiene; de un cliente con historial se crea", async () => {
    const sinHistorial = await banco();
    const items = (b: Awaited<ReturnType<typeof banco>>) => [item(b.pid("Pastor — 2 kg"), "Pastor — 2 kg", 2)];
    const r1 = await cotizarYConfirmar(sinHistorial, "+5219990000028", items(sinHistorial), "efectivo");
    expect(r1.orderId).toBeNull();
    expect(sinHistorial.callbacks().some((c) => c.reason === "escalada:pedido_grande")).toBe(true);

    const conHistorial = await banco();
    (conHistorial.w.repo as unknown as { seedCustomer(c: unknown): void }).seedCustomer({ id: "00000000-0000-4000-8000-0000000000aa", organizationId: conHistorial.w.organizationId, phone: "9990000029", name: "Cliente Recurrente", orderCount: 3 });
    const r2 = await cotizarYConfirmar(conHistorial, "+5219990000029", items(conHistorial), "efectivo");
    expect(r2.orderId).toBeTruthy();
    expect(conHistorial.callbacks().some((c) => c.reason === "escalada:pedido_grande")).toBe(false);
  });

  it("si el negocio apago el motivo pedido_grande en su configuracion, el servidor no lo retiene", async () => {
    const b = await banco();
    const propia = await b.w.repo.findWhatsAppAgentConfig(b.w.organizationId, b.t7);
    expect(propia?.perfil).toBe("taqueria_pm");
    await b.w.repo.upsertWhatsAppAgentConfig(b.w.organizationId, b.t7, { ...propia!, escalationReasonsOff: ["pedido_grande"] });
    const r = await cotizarYConfirmar(b, "+5219990000030", [item(b.pid("Bistec de Res — 2 kg"), "Bistec de Res — 2 kg", 3)], "efectivo");
    expect(r.orderId).toBeTruthy();
  });

  it("una organizacion sin perfil de PM (agente generico) no usa los umbrales de PM", async () => {
    const b = await banco();
    const propia = await b.w.repo.findWhatsAppAgentConfig(b.w.organizationId, b.t7);
    await b.w.repo.upsertWhatsAppAgentConfig(b.w.organizationId, b.t7, { ...propia!, perfil: "generico" });
    const r = await cotizarYConfirmar(b, "+5219990000031", [item(b.pid("Bistec de Res — 2 kg"), "Bistec de Res — 2 kg", 3)], "efectivo");
    expect(r.orderId).toBeTruthy();
  });
});

describe("voz: pedido grande (viaje-05, canal de voz)", () => {
  const SUC = BRANCH_SLUG_PRINCIPAL;
  const bistec90 = (m: MemoriaTools) => {
    const p = m.producto("bistec");
    return [{ product_id: p.id, product_name: p.name, requested_quantity: 90, tortilla: "maiz" }];
  };
  const buscar: PasoAgente = { tool: "buscar_producto", args: { query: "bistec", branch_slug: SUC } };
  const cotizar: PasoAgente = { tool: "cotizar_pedido", args: (m) => ({ branch_slug: SUC, items: bistec90(m), canal: "domicilio", colonia_entrega: "Centro" }) };
  const confirmar: PasoAgente = { tool: "confirmar_resumen", args: (m) => ({ quote_hash: m.quoteHash() }) };
  const crear: PasoAgente = {
    tool: "crear_pedido",
    args: (m) => ({ branch_slug: SUC, customer_name: "Cliente QA", items: bistec90(m), payment_method: "efectivo", canal: "domicilio", colonia_entrega: "Centro", customer_address: "Calle 60 número 100, Centro" }),
  };

  it("30 ordenes de bistec ($4,920) en efectivo no entran a cocina; queda el aviso pedido_grande", async () => {
    const l = await correrGuion({
      id: "QA-V-pedido-grande",
      titulo: "pedido grande sin escalar",
      rasgos: ["pedido grande"],
      turnos: [
        { kind: "voz", cliente: "Quiero noventa tacos de bistec de maíz a domicilio en el Centro, para una fiesta", agente: [buscar, cotizar, { dice: "Son treinta órdenes, cuatro mil novecientos veinte pesos. ¿Es correcto?" }] },
        { kind: "voz", cliente: "Sí, en efectivo", agente: [confirmar, crear, { dice: "Su pedido lo confirmará la sucursal." }] },
      ],
      esperado: { resultado: "pedido_creado" },
    });
    expect((await l.mundo.pedidos()).some((p) => p.total === 4920)).toBe(false);
    expect(l.mundo.callbacks.some((c) => /pedido_grande/.test(String(c.reason)))).toBe(true);
  });
});
