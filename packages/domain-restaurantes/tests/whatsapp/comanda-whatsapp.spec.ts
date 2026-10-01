// SoftRestaurant: los pedidos creados por el agente de WhatsApp tambien encolan su comanda (antes solo
// voz y web lo hacian). Se prueba el turno real (`createLlmWhatsAppTurnHandler`) con un modelo guionado,
// el helper real `encolarComandaParaPedido` y el store/adaptador en memoria.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { InMemoryRestaurantesRepository } from "../../src/in-memory-repository.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { MapaProductoCodigo } from "../../src/softrestaurant/catalog-map.ts";
import { FakeSoftRestaurantAdapter } from "../../src/softrestaurant/fake-adapter.ts";
import { InMemoryComandaOutboxStore } from "../../src/softrestaurant/outbox-memory-store.ts";
import { crearResolverSucursalPos, encolarComandaParaPedido, type DepsComandaPos } from "../../src/softrestaurant/outbox-service.ts";
import type { CustomerLookupResult } from "../../src/types.ts";
import { seedConfirmedOrderFlow } from "../support/order-flow-seed.ts";

const NEW_CUSTOMER: CustomerLookupResult = { isNew: true };
const PHONE = "+5219990000000";

function completion(partial: Partial<LlmCompletionResult>): LlmCompletionResult {
  return { text: "", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0, ...partial };
}

async function montar(modo: "apagado" | "sombra" | "activo", opciones: { codigos?: boolean; encolarLanza?: boolean } = {}) {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "pm", name: "Los Taquitos de PM" });
  const propertyId = randomUUID();
  repo.seedBranch({ propertyId, organizationId, name: "Francisco de Montejo T2", slug: "t2", status: "active", phone: null, address: null, lat: null, lng: null });
  const categoryId = randomUUID();
  repo.seedCategory({ id: categoryId, organizationId, name: "Bebidas" });
  const productId = randomUUID();
  repo.seedProduct({ id: productId, organizationId, categoryId, name: "Agua de Jamaica", description: null, searchKeywords: [] });
  repo.seedBranchProduct({ propertyId, productId, price: 35, isAvailable: true });

  const store = new InMemoryComandaOutboxStore();
  store.ponerModo(organizationId, modo);
  const port = new FakeSoftRestaurantAdapter();
  const deps: DepsComandaPos = {
    store,
    port,
    resolverCodigos: new MapaProductoCodigo(opciones.codigos === false ? [] : [{ productId, codigo: "FAKE-001" }]),
    resolverSucursal: crearResolverSucursalPos({ [propertyId]: "T2" }),
  };

  await seedConfirmedOrderFlow(repo, organizationId, `wa:${PHONE}`, { branchSlug: "t2", canal: "recoger", items: [{ productId, productName: "Agua de Jamaica", requestedQuantity: 1 }] });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  const resultadosDeHerramienta: string[] = [];
  let paso = 0;
  gateway.registerLadder("default", [
    new FakeLlmProvider({
      id: "p",
      script: (req) => {
        const actual = paso++;
        if (actual === 0) {
          return completion({
            toolCalls: [
              {
                id: "c1",
                name: "crear_pedido",
                argumentsJson: JSON.stringify({
                  branch_slug: "t2",
                  customer_name: "Marcela",
                  canal: "recoger",
                  items: [{ product_id: productId, product_name: "Agua de Jamaica", requested_quantity: 1 }],
                  payment_method: "efectivo",
                }),
              },
            ],
          });
        }
        const ultimo = [...req.messages].reverse().find((m) => m.role === "tool");
        if (ultimo && ultimo.role === "tool") resultadosDeHerramienta.push(ultimo.content);
        return completion({ text: "Listo, Marcela." });
      },
    }),
  ]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
  const handler = createLlmWhatsAppTurnHandler(repo, gateway, {
    defaultRole: "default",
    escalatedRole: "escalated",
    encolarComanda: (pedido) => (opciones.encolarLanza ? Promise.reject(new Error("outbox caido")) : encolarComandaParaPedido(deps, pedido)),
  });
  const turno = () => handler.handleInboundMessage({ organizationId, phone: PHONE, messages: [{ role: "user", content: "si, confirmo" }], customer: NEW_CUSTOMER });
  return { turno, store, port, organizationId, resultadosDeHerramienta };
}

describe("comanda de SoftRestaurant desde el turno de WhatsApp", () => {
  it("modo activo: el pedido de WhatsApp encola y envia UNA comanda y el modelo recibe el estado real (sin folio inventado)", async () => {
    const t = await montar("activo");
    const r = await t.turno();
    expect(r.orderId).not.toBeNull();
    const filas = (await t.store.listar(t.organizationId, { propertyIds: null, limite: 10, offset: 0 })).filas;
    expect(filas).toHaveLength(1);
    expect(filas[0]!.orderId).toBe(r.orderId);
    expect(filas[0]!.payload.tipo).toBe("recoger");
    expect(filas[0]!.payload.cliente.telefono).toBe("9990000000");
    const visto = JSON.parse(t.resultadosDeHerramienta[0]!) as { order: { id: string }; comanda: { estado: string; folio: string | null } };
    expect(visto.order.id).toBe(r.orderId);
    expect(["confirmada", "pendiente_de_confirmar"]).toContain(visto.comanda.estado);
    // El folio solo existe si el POS lo devolvio (el adaptador falso lo devuelve en `confirmada`).
    if (visto.comanda.estado === "pendiente_de_confirmar") expect(visto.comanda.folio).toBeNull();
  });

  it("producto sin codigo POS: el pedido NO se pierde, la comanda va a captura manual y el agente solo ve 'pendiente de confirmar'", async () => {
    const t = await montar("activo", { codigos: false });
    const r = await t.turno();
    expect(r.orderId).not.toBeNull();
    const filas = (await t.store.listar(t.organizationId, { propertyIds: null, limite: 10, offset: 0 })).filas;
    expect(filas).toHaveLength(1);
    expect(filas[0]!.estado).toBe("captura_manual");
    const visto = JSON.parse(t.resultadosDeHerramienta[0]!) as { comanda: { estado: string; folio: string | null } };
    expect(visto.comanda).toMatchObject({ estado: "pendiente_de_confirmar", folio: null });
  });

  it("modo sombra: encola pero el resultado de crear_pedido que ve el modelo es identico al de antes", async () => {
    const t = await montar("sombra");
    await t.turno();
    expect((await t.store.listar(t.organizationId, { propertyIds: null, limite: 10, offset: 0 })).filas).toHaveLength(1);
    expect(JSON.parse(t.resultadosDeHerramienta[0]!)).not.toHaveProperty("comanda");
  });

  it("bandera apagada: no se encola nada y el resultado es identico al de antes", async () => {
    const t = await montar("apagado");
    const r = await t.turno();
    expect(r.orderId).not.toBeNull();
    expect((await t.store.listar(t.organizationId, { propertyIds: null, limite: 10, offset: 0 })).filas).toHaveLength(0);
    expect(JSON.parse(t.resultadosDeHerramienta[0]!)).not.toHaveProperty("comanda");
  });

  it("si encolar lanza, el pedido ya creado sigue confirmado al cliente (la comanda nunca tumba el turno)", async () => {
    const t = await montar("activo", { encolarLanza: true });
    const r = await t.turno();
    expect(r.orderId).not.toBeNull();
    expect(r.reply).toBe("Listo, Marcela.");
    expect(JSON.parse(t.resultadosDeHerramienta[0]!)).not.toHaveProperty("comanda");
  });
});
