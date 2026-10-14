// Revision de #551: MODIFICAR el pedido nunca pasa por el autopiloto de cancelacion (con la cancelacion automatica encendida «cámbiame el pedido a harina» dejaba el pedido cancelado).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import { describe, expect, it } from "vitest";
import { InMemoryAutopilotoRepository, crearHooksAutopilotoTurno } from "../../src/autopiloto/index.ts";
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

const CLIENTE: CustomerLookupResult = { isNew: false, name: "Deb", orderCount: 1, addresses: [], lastOrderItems: null, frequentItems: [], tier: null, agentNotes: [], pedidoReciente: { estado: "preparando", canal: "domicilio", sucursal: "Fco Montejo", confirmadoHoraLocal: "13:00", minutosDesdeConfirmacion: 3 } } as never;
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


const MODIFICACIONES = ["cámbiame el pedido a harina", "modifica el pedido, agrega 2 tacos"];

async function pendiente(t: Awaited<ReturnType<typeof montar>>) {
  t.encender();
  t.auto.configs.set(t.propertyId, { ...(await t.auto.leerConfig("", t.propertyId)).valor, cancelacionAuto: true, configurada: true });
}

describe("REVISOR #551: modificar el pedido con el autopiloto de cancelacion ENCENDIDO", () => {
  it("control: «cancela mi pedido» SI cancela (el montaje de la prueba es real)", async () => {
    const t = await montar({ status: "pending" });
    await pendiente(t);
    const r = await t.turno("cancela mi pedido por favor", t.hooks);
    expect(t.mem!.status).toBe("cancelado");
    expect(r.reply).toMatch(/cancelado/i);
  });
  it.each(MODIFICACIONES)("pedido pending (cancelacion automatica): «%s» no cancela, avisa al equipo y escala", async (texto) => {
    const t = await montar({ status: "pending" });
    await pendiente(t);
    // Con el pedido por confirmar (pending) el clasificador ve «por_confirmar»; la ficha del cliente de la prueba dice «preparando»: ambos son modificables.
    const r = await t.turno(texto, t.hooks);
    expect(t.mem!.status).toBe("pending");
    expect(r.reply).not.toMatch(/cancel/i);
    expect(r.reply).toMatch(/cambiar su pedido/i);
    expect((await t.auto.listarSolicitudes(t.fixture.organizationId, { propertyIds: null, estado: "pendiente", limite: 10 })).valor).toEqual([]);
  });
  it.each(MODIFICACIONES)("pedido en preparacion: «%s» no crea una solicitud de cancelacion", async (texto) => {
    const t = await montar({ status: "preparando" });
    t.encender();
    const r = await t.turno(texto, t.hooks);
    expect(r.reply).not.toMatch(/cancel/i);
    expect((await t.auto.listarSolicitudes(t.fixture.organizationId, { propertyIds: null, estado: "pendiente", limite: 10 })).valor).toEqual([]);
  });
  it("intentarCancelacionConAutopiloto solo actua si el texto habla de cancelar", async () => {
    const t = await montar({ status: "pending" });
    await pendiente(t);
    const { intentarCancelacionConAutopiloto } = await import("../../src/whatsapp/autopiloto-turno.ts");
    const args = { organizationId: t.fixture.organizationId, phone: TELEFONO, ahora: new Date("2026-10-06T18:00:00Z") };
    expect(await intentarCancelacionConAutopiloto(t.fixture.repo, t.hooks, { ...args, texto: "cámbiame el pedido a harina" })).toBeNull();
    expect(t.mem!.status).toBe("pending");
    expect(await intentarCancelacionConAutopiloto(t.fixture.repo, t.hooks, { ...args, texto: "cancela mi pedido" })).not.toBeNull();
  });
});
