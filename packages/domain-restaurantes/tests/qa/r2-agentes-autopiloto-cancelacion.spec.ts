// QA adversarial R2 (lente AGENTES, restaurantes) -- cancelacion por WhatsApp con el autopiloto (#429).
// Con la bandera `cancelacion_agente` de la organizacion y la cancelacion automatica de la sucursal encendidas, el clasificador de alto riesgo
// decide "cancelacion" y el autopiloto CANCELA el pedido activo del telefono sin pasar por el modelo. Se ataca con mensajes que mencionan
// "cancelar" + "pedido" pero NO piden cancelar (preguntas de estado o de politica). Convencion: `it.fails` describe el comportamiento
// ESPERADO que hoy falla (defecto confirmado: QA-restaurantes-R2-agentes-NN); `it` = comportamiento correcto confirmado.
// Todo en memoria: ni base real, ni red, ni Meta.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import { describe, expect, it } from "vitest";
import { InMemoryAutopilotoRepository, crearHooksAutopilotoTurno } from "../../src/autopiloto/index.ts";
import type { PedidoMemoria } from "../../src/autopiloto/index.ts";
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
const MODELO = "RESPUESTA DEL MODELO";

function gateway() {
  const g = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  g.registerLadder("default", [new FakeLlmProvider({ id: "p", script: () => ({ text: MODELO, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }) })]);
  g.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
  return g;
}

async function montar(status: OrderStatus, opts: { readonly cancelacionAuto?: boolean } = {}) {
  const fixture = buildRestaurantFixture();
  fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PNID-1");
  const auto = new InMemoryAutopilotoRepository();
  const db = new SesionFalsa();
  const propertyId = (await fixture.repo.findBranch(fixture.organizationId, { slug: "fco-montejo" }))!.propertyId;
  const creado = await createOrder(fixture.repo, {
    organizationId: fixture.organizationId, branchSlug: "fco-montejo", customerName: "Deb", customerPhone: "9991234567", customerAddress: "Calle 80 #30",
    items: [{ productId: fixture.products.cocaCola, requestedQuantity: 2 }], source: "whatsapp", paymentMethod: "efectivo",
  });
  const order = status === "pending" ? creado : ((await fixture.repo.updateOrderStatus(fixture.organizationId, creado.id, "pending", status)) ?? creado);
  const mem: PedidoMemoria = { id: order.id, organizationId: order.organizationId, propertyId, status, total: order.total, clienteNombre: "Deb", telefono: "9991234567", canal: "domicilio", numero: 5, renglones: [{ nombre: "Coca-Cola", cantidad: 2 }] };
  auto.pedidos.set(order.id, mem);
  auto.configsOrg.set(fixture.organizationId, { cancelacionAgente: true });
  if (opts.cancelacionAuto) auto.configs.set(propertyId, { ...(await auto.leerConfig("", propertyId)).valor, cancelacionAuto: true, configurada: true });
  const hooks = crearHooksAutopilotoTurno({ auto, repo: fixture.repo, db });
  const handler = createLlmWhatsAppTurnHandler(fixture.repo, gateway(), { defaultRole: "default", escalatedRole: "escalated", autopiloto: hooks });
  const turno = (texto: string) => handler.handleInboundMessage({ organizationId: fixture.organizationId, phone: TELEFONO, messages: [{ role: "user", content: texto }], customer: CLIENTE });
  const solicitudes = async () => (await auto.listarSolicitudes(fixture.organizationId, { propertyIds: null, estado: "pendiente", limite: 10 })).valor;
  return { mem, turno, solicitudes, db };
}

describe("R2 autopiloto: preguntas que mencionan 'cancelar' + 'pedido' NO cancelan", () => {
  // QA-restaurantes-R2-agentes-01 (P1): una PREGUNTA de estado se lee como orden de cancelar y el autopiloto cancela el pedido real.
  it("R2-01a '¿mi pedido se canceló? sigo esperando' (pending + cancelacion automatica): el pedido sigue vivo", async () => {
    const t = await montar("pending", { cancelacionAuto: true });
    const r = await t.turno("¿Mi pedido se canceló? Sigo esperando");
    expect(t.mem.status).toBe("pending");
    expect(r.reply).not.toMatch(/quedó cancelado/);
  });

  it("R2-01b '¿si cancelo el pedido me cobran algo?' es una pregunta de politica: no cancela", async () => {
    const t = await montar("pending", { cancelacionAuto: true });
    await t.turno("¿Si cancelo el pedido me cobran algo?");
    expect(t.mem.status).toBe("pending");
  });

  it("R2-01c '¿hasta qué hora se puede cancelar un pedido?' no cancela", async () => {
    const t = await montar("pending", { cancelacionAuto: true });
    await t.turno("¿Hasta qué hora se puede cancelar un pedido?");
    expect(t.mem.status).toBe("pending");
  });

  it("R2-01d con el pedido en preparacion, la pregunta '¿mi pedido se canceló?' NO abre una solicitud de cancelacion para el staff", async () => {
    const t = await montar("preparando");
    await t.turno("¿Mi pedido se canceló? Sigo esperando");
    expect(await t.solicitudes()).toHaveLength(0);
  });

  // Lo que SI funciona (control).
  it("control: 'quiero cancelar mi pedido' con pending y cancelacion automatica cancela y lo dice una sola vez", async () => {
    const t = await montar("pending", { cancelacionAuto: true });
    const r = await t.turno("Quiero cancelar mi pedido");
    expect(t.mem.status).toBe("cancelado");
    expect(r.reply).toBe("Listo, su pedido quedó cancelado.");
  });

  it("tabla punta a punta (pending + cancelacion automatica): amenazas, correcciones y preguntas NO cancelan", async () => {
    for (const texto of [
    "Si no llega a las 3:30, cancelo el pedido",
    "Si no está aquí a las 9:15, cancelo el pedido",
    "Como no llegue en 10 minutos, cancelo el pedido",
    "De no llegar en 10 min, cancelo el pedido",
    "Si no llega en 10 min; cancelo el pedido",
    "De no llegar a las 3:30, cancelo el pedido",
    "Si no llega a las 15:30, cancelo el pedido",
    "Si no llega a las 9:15, cancelo el pedido",
    "Si no llega a las 3:30 hrs, cancelo el pedido",
    "Si no llega a las 3 con 30, cancelo el pedido",
    "Si no llega a las 3 y media, cancelo el pedido",
    "Si para las 3:30 no ha llegado, cancelo el pedido",
    "Si acaso no llega, cancelo el pedido",
    "Por si no llega, cancelo el pedido",
    "Cancelo el pedido si no llega a las 3:30",
    "En caso de que no llegue en 10 minutos, cancelo el pedido",
    "En caso de que no llegue a las 3:30, cancelen mi pedido",
    "Cuando no llegue a las 3:30, cancelo el pedido",
    "Al no llegar en 10 minutos, cancelo el pedido",
    "Cancelen el pedido, no, perdón, me equivoqué",
    "Cancelar mi pedido, no. Solo quiero cambiar la dirección",
    "Cancelar mi pedido, no; solo cambiar la dirección",
    "Cancelen mi pedido, no es cierto, ya llegó",
    "Cancelar el pedido, nunca",
    "Si no llega en los próximos 10 minutos, cancelo el pedido",
    "Si no llega ya, voy a tener que cancelar el pedido",
    "Si no me llega mi pedido antes de las 3:30, lo cancelo",
    "Si no llega a las 3:30 p.m., cancelo el pedido",
    "Si no llega a las 3.30, cancelo el pedido",
    "Mientras no llegue mi pedido en 10 min, lo cancelo",
    "Si no fuera molestia, cancela el pedido",
    "De no ser molestia, cancelen el pedido",
    "Si no hay repartidor, cancelen mi pedido",
    "No lo quiero tener que cancelar el pedido",
    "Ya no lo quiero cancelar",
    "¿Puedo cancelar mi pedido?",
    "¿Mi pedido se canceló?",
    ]) {
      const t = await montar("pending", { cancelacionAuto: true });
      await t.turno(texto);
      expect(t.mem.status, texto).toBe("pending");
    }
  });

  it("tabla punta a punta: ordenes reales de cancelar (con cortesias, motivos u horas) SI cancelan", async () => {
    for (const texto of [
    "Quiero cancelar mi pedido",
    "Cancela el pedido por favor, ya no lo quiero",
    "Ya no lo quiero, cancelen el pedido",
    "Si no es molestia, cancela mi pedido",
    "Si no les molesta, cancela mi pedido",
    "Si no hay problema, cancelen el pedido",
    "Si no hay inconveniente, cancelen mi pedido",
    "Cancelen mi pedido, es para las 3:30",
    "Cancela mi pedido, no llegó a tiempo",
    "No, cancelen el pedido",
    "Ya no, cancelen mi pedido",
    "No llegó, cancelen mi pedido",
    "Como nunca llegó, cancelen mi pedido",
    "Llevo una hora esperando y no llega, cancelen el pedido",
    "Ya no lo necesito, cancelen mi pedido",
    ]) {
      const t = await montar("pending", { cancelacionAuto: true });
      await t.turno(texto);
      expect(t.mem.status, texto).toBe("cancelado");
    }
  });

  it("control: negacion cerca del verbo ('no cancelen mi pedido', 'si no llega en 10 min, cancelo el pedido') no cancela", async () => {
    for (const texto of [
      "No cancelen mi pedido, ya voy por él",
      "Si no llega en 10 min cancelo el pedido",
      "Si no llega en 10 min, cancelo el pedido",
      "Si en 10 minutos no llega, cancelo el pedido",
      "Si no sale ya, cancelen mi pedido",
    ]) {
      const t = await montar("pending", { cancelacionAuto: true });
      await t.turno(texto);
      expect(t.mem.status, texto).toBe("pending");
    }
  });

  it("control: con el pedido ya en preparacion no cancela solo: crea UNA solicitud y no promete", async () => {
    const t = await montar("preparando", { cancelacionAuto: true });
    const r = await t.turno("Quiero cancelar mi pedido");
    expect(t.mem.status).toBe("preparando");
    expect(r.reply).toMatch(/sin prometerlo/);
    expect(await t.solicitudes()).toHaveLength(1);
  });

  // QA-restaurantes-R2-agentes-02 (P3): la forma mas comun de cancelar en Mexico ("ya no lo quiero, cancelen el pedido") se lee como NEGACION
  // ("ya no" cerca de "cancel") y el autopiloto no interviene: cae al aviso manual de siempre (seguro, pero el autopiloto no sirve para ese caso).
  it("R2-02 'Ya no lo quiero, cancelen el pedido' (preparando) crea la solicitud de cancelacion del autopiloto", async () => {
    const t = await montar("preparando", { cancelacionAuto: true });
    await t.turno("Ya no lo quiero, cancelen el pedido");
    expect(await t.solicitudes()).toHaveLength(1);
  });
});
