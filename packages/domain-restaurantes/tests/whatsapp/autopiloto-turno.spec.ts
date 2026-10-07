// Autopiloto en el turno del agente de WhatsApp: cancelaciones (detras de la bandera por organizacion, apagada por omision) y quejas ligadas al pedido.
// El clasificador de alto riesgo NO cambia: con la bandera apagada, sin pedido activo, con la base sin migrar o ante un error, el turno sigue por el camino
// de siempre (aviso fijo al equipo y toma de handoff).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import { describe, expect, it } from "vitest";
import { InMemoryAutopilotoRepository, crearHooksAutopilotoTurno, subtipoQueja } from "../../src/autopiloto/index.ts";
import type { AutopilotoTurnoHooks, PedidoMemoria } from "../../src/autopiloto/index.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { createOrder } from "../../src/orders.ts";
import type { CustomerLookupResult, OrderStatus } from "../../src/types.ts";
import { buildRestaurantFixture } from "../fixtures.ts";

class SesionFalsa implements TenantDbSession {
  readonly emisiones: string[] = [];
  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    if (/core\.emit_notification/.test(sql)) {
      this.emisiones.push(String((params ?? [])[2]));
      return { rows: [{ emit_notification: 1 } as T] };
    }
    return { rows: [] };
  }
  async exec(): Promise<void> {}
}

const CLIENTE: CustomerLookupResult = { isNew: true };
const TELEFONO = "+5219991234567";

function gateway() {
  const g = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  // El clasificador responde ANTES del LLM: si algun turno llegara al modelo, esta respuesta delataria el desvio.
  g.registerLadder("default", [new FakeLlmProvider({ id: "p", script: () => ({ text: "RESPUESTA DEL MODELO", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }) })]);
  g.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
  return g;
}

async function montar(opts: { status?: OrderStatus; sinPedido?: boolean } = {}) {
  const fixture = buildRestaurantFixture();
  fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PNID-1");
  const auto = new InMemoryAutopilotoRepository();
  const db = new SesionFalsa();
  const propertyId = (await fixture.repo.findBranch(fixture.organizationId, { slug: "fco-montejo" }))!.propertyId;
  let mem: PedidoMemoria | null = null;
  if (!opts.sinPedido) {
    const creado = await createOrder(fixture.repo, {
      organizationId: fixture.organizationId, branchSlug: "fco-montejo", customerName: "Deb", customerPhone: "9991234567", customerAddress: "Calle 80 #30",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 2 }], source: "whatsapp", paymentMethod: "efectivo",
    });
    const status = opts.status ?? "pending";
    const order = status === "pending" ? creado : ((await fixture.repo.updateOrderStatus(fixture.organizationId, creado.id, "pending", status)) ?? creado);
    mem = { id: order.id, organizationId: order.organizationId, propertyId, status, total: order.total, clienteNombre: "Deb", telefono: "9991234567", canal: "domicilio", numero: 5, renglones: [{ nombre: "Coca-Cola", cantidad: 2 }] };
    auto.pedidos.set(order.id, mem);
  }
  const hooks = crearHooksAutopilotoTurno({ auto, repo: fixture.repo, db });
  const handler = (h?: AutopilotoTurnoHooks) => createLlmWhatsAppTurnHandler(fixture.repo, gateway(), { defaultRole: "default", escalatedRole: "escalated", ...(h ? { autopiloto: h } : {}) });
  const turno = (texto: string, h?: AutopilotoTurnoHooks) => handler(h).handleInboundMessage({ organizationId: fixture.organizationId, phone: TELEFONO, messages: [{ role: "user", content: texto }], customer: CLIENTE });
  const encender = () => auto.configsOrg.set(fixture.organizationId, { cancelacionAgente: true });
  return { fixture, auto, db, mem, hooks, turno, encender, propertyId };
}

describe("subtipoQueja (lista cerrada)", () => {
  it.each([
    ["me faltó la bebida de mi pedido", "faltante"],
    ["llegó incompleto", "faltante"],
    ["me mandaron otro platillo, está equivocado", "equivocado"],
    ["llegó frío", "frio"],
    ["llegó tarde, una hora", "tarde"],
    ["fueron muy groseros", "trato"],
    ["quiero poner una queja", "otro"],
  ])("%s -> %s", (texto, esperado) => {
    expect(subtipoQueja(texto)).toBe(esperado);
  });
});

describe("cancelacion pedida por WhatsApp con el autopiloto", () => {
  it("bandera APAGADA (por omision): camino de siempre, sin solicitud y con la toma de handoff", async () => {
    const t = await montar({ status: "preparando" });
    const r = await t.turno("Quiero cancelar mi pedido", t.hooks);
    expect(r.reply).toContain("solo lo puede confirmar alguien del restaurante");
    expect(r.escalacion).toEqual({ motivo: "cancelacion_modificacion" });
    expect((await t.auto.listarSolicitudes(t.fixture.organizationId, { propertyIds: null, estado: "pendiente", limite: 10 })).valor).toHaveLength(0);
    expect(t.mem!.status).toBe("preparando");
  });

  it("sin la opcion de autopiloto el turno es EXACTAMENTE el de antes aunque la bandera exista", async () => {
    const t = await montar({ status: "preparando" });
    t.encender();
    const r = await t.turno("Quiero cancelar mi pedido");
    expect(r.escalacion).toEqual({ motivo: "cancelacion_modificacion" });
    expect((await t.auto.listarSolicitudes(t.fixture.organizationId, { propertyIds: null, estado: "pendiente", limite: 10 })).valor).toHaveLength(0);
  });

  it("bandera encendida + pedido en preparacion: crea la solicitud, NO cancela, NO promete y no abre handoff", async () => {
    const t = await montar({ status: "preparando" });
    t.encender();
    const r = await t.turno("Quiero cancelar mi pedido", t.hooks);
    expect(r.reply).toMatch(/avis[ée] a la sucursal/i);
    expect(r.reply).toMatch(/sin prometerlo/);
    expect(r.reply).not.toMatch(/quedó cancelado/);
    expect(r.escalacion).toBeUndefined();
    const s = (await t.auto.listarSolicitudes(t.fixture.organizationId, { propertyIds: null, estado: "pendiente", limite: 10 })).valor;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ tipo: "cancelacion", orderId: t.mem!.id });
    expect(t.mem!.status).toBe("preparando");
    expect(t.db.emisiones).toContain("restaurantes.aprobacion.cancelacion");
  });

  it("repetir la peticion no duplica la solicitud ni la notificacion", async () => {
    const t = await montar({ status: "preparando" });
    t.encender();
    await t.turno("Quiero cancelar mi pedido", t.hooks);
    await t.turno("Quiero cancelar mi pedido", t.hooks);
    expect((await t.auto.listarSolicitudes(t.fixture.organizationId, { propertyIds: null, estado: "pendiente", limite: 10 })).valor).toHaveLength(1);
  });

  it("pending SIN comanda con la cancelacion automatica de la sucursal encendida: se cancela y la respuesta es la unica confirmacion (sin mensaje duplicado)", async () => {
    const t = await montar({ status: "pending" });
    t.encender();
    t.auto.configs.set(t.propertyId, { ...(await t.auto.leerConfig("", t.propertyId)).valor, cancelacionAuto: true, configurada: true });
    const r = await t.turno("Quiero cancelar mi pedido", t.hooks);
    expect(r.reply).toBe("Listo, su pedido quedó cancelado.");
    expect(t.mem!.status).toBe("cancelado");
    expect(t.fixture.repo.getOutbox().filter((o) => o.eventType === "order.status.cancelado")).toHaveLength(0);
  });

  it("sin pedido activo del telefono: camino de siempre (aviso fijo al equipo)", async () => {
    const t = await montar({ sinPedido: true });
    t.encender();
    const r = await t.turno("Quiero cancelar mi pedido", t.hooks);
    expect(r.reply).toContain("solo lo puede confirmar alguien del restaurante");
    expect(r.escalacion).toEqual({ motivo: "cancelacion_modificacion" });
  });

  it("base SIN migrar: la bandera se lee como apagada y el turno sigue por el camino de siempre", async () => {
    const t = await montar({ status: "preparando" });
    t.encender();
    t.auto.disponible = false;
    const r = await t.turno("Quiero cancelar mi pedido", t.hooks);
    expect(r.escalacion).toEqual({ motivo: "cancelacion_modificacion" });
  });

  it("un error del autopiloto no rompe el turno: cae al camino de siempre", async () => {
    const t = await montar({ status: "preparando" });
    const roto: AutopilotoTurnoHooks = { ...t.hooks, cancelacionActiva: async () => { throw new Error("falla simulada"); } };
    const r = await t.turno("Quiero cancelar mi pedido", roto);
    expect(r.reply).toContain("solo lo puede confirmar alguien del restaurante");
    expect(r.escalacion).toEqual({ motivo: "cancelacion_modificacion" });
  });

  it("el pedido sale del telefono del contexto: otro numero no toca el pedido ajeno", async () => {
    const t = await montar({ status: "preparando" });
    t.encender();
    const otro = await t.fixture.repo.findLatestOrderByPhone(t.fixture.organizationId, "9990000000", new Date(Date.now() - 86_400_000).toISOString());
    expect(otro ?? null).toBeNull();
    const r = await createLlmWhatsAppTurnHandler(t.fixture.repo, gateway(), { defaultRole: "default", escalatedRole: "escalated", autopiloto: t.hooks }).handleInboundMessage({
      organizationId: t.fixture.organizationId, phone: "+5219990000000", messages: [{ role: "user", content: "Quiero cancelar mi pedido" }], customer: CLIENTE,
    });
    expect(r.escalacion).toEqual({ motivo: "cancelacion_modificacion" });
    expect(t.mem!.status).toBe("preparando");
  });
});

describe("queja ligada al pedido con el autopiloto", () => {
  it("la respuesta al cliente NO cambia, el aviso al equipo lleva el subtipo y se crea la solicitud de compensacion ligada al ultimo pedido", async () => {
    const t = await montar({ status: "entregado" });
    const con = await t.turno("Me llegó incompleto, me faltó la bebida de mi pedido", t.hooks);
    const sin = await montar({ status: "entregado" });
    const sinAuto = await sin.turno("Me llegó incompleto, me faltó la bebida de mi pedido");
    expect(con.reply).toBe(sinAuto.reply);
    expect(con.escalacion).toEqual({ motivo: "queja" });
    // El aviso al equipo (handoff) guarda el subtipo de la lista cerrada; sin autopiloto el resumen es el texto del cliente, como siempre.
    const avisos = (t.fixture.repo as unknown as { callbackRequests: { reason?: string; message?: string }[] }).callbackRequests;
    expect(avisos.find((a) => a.reason === "escalada:queja")?.message).toMatch(/^\[queja:faltante\] Me llegó incompleto/);
    const avisosSin = (sin.fixture.repo as unknown as { callbackRequests: { reason?: string; message?: string }[] }).callbackRequests;
    expect(avisosSin.find((a) => a.reason === "escalada:queja")?.message).toBe("Me llegó incompleto, me faltó la bebida de mi pedido");
    const s = (await t.auto.listarSolicitudes(t.fixture.organizationId, { propertyIds: null, estado: "pendiente", limite: 10 })).valor;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ tipo: "compensacion", orderId: t.mem!.id, detalle: { subtipo: "faltante" } });
    expect(t.db.emisiones).toContain("restaurantes.aprobacion.compensacion");
    // Nada se compensa solo.
    expect([...t.auto.pedidos.values()].filter((p) => p.total === 0)).toHaveLength(0);
  });

  it("sin pedido entregado del telefono no inventa la solicitud", async () => {
    const t = await montar({ sinPedido: true });
    await t.turno("Llegó frío mi pedido, quiero poner una queja", t.hooks);
    expect((await t.auto.listarSolicitudes(t.fixture.organizationId, { propertyIds: null, estado: "pendiente", limite: 10 })).valor).toHaveLength(0);
  });

  it("un error al ligar la queja no tumba el turno ni cambia la respuesta", async () => {
    const t = await montar({ status: "entregado" });
    const roto: AutopilotoTurnoHooks = { ...t.hooks, registrarQueja: async () => { throw new Error("falla simulada"); } };
    const r = await t.turno("Llegó frío mi pedido, quiero poner una queja", roto);
    expect(r.escalacion).toEqual({ motivo: "queja" });
  });
});

