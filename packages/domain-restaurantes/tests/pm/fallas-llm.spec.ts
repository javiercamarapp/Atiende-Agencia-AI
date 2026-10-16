// Batería PM F3b — E.11 Fallas del proveedor de LLM (WhatsApp): caída, respaldo, timeout, basura.
import { describe, expect, it, vi } from "vitest";
import { FakeLlmProvider } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "../fixtures.ts";
import { seedConfirmedOrderFlow } from "../support/order-flow-seed.ts";
import { makeGateway, NEW_CUSTOMER, PHONE, result, scriptedHandler } from "./harness.ts";

const turn = (f: ReturnType<typeof buildRestaurantFixture>, handler: ReturnType<typeof scriptedHandler>["handler"], content = "hola") =>
  handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content }], customer: NEW_CUSTOMER });

describe("E.11 LLM caído, lento o con basura", () => {
  it("T-FP03 el proveedor principal responde 429/500: el respaldo contesta en el MISMO turno", async () => {
    const f = buildRestaurantFixture();
    const gateway = makeGateway();
    const principal = new FakeLlmProvider({ id: "principal", failWith: () => Object.assign(new Error("429 rate limit"), { status: 429 }) });
    const respaldo = new FakeLlmProvider({ id: "respaldo", script: () => result({ text: "Hola, ¿qué se te antoja?" }, 0) });
    gateway.registerLadder("default", [principal, respaldo]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    const r = await turn(f, handler);
    expect(r.reply).toBe("Hola, ¿qué se te antoja?");
    expect(principal.callCount).toBe(1);
    expect(respaldo.callCount).toBe(1);
  });

  it("T-FP04 ambos proveedores caen sin pedido: mensaje honesto de problema técnico, sin silencio ni 'registrado'", async () => {
    const f = buildRestaurantFixture();
    const gateway = makeGateway();
    const cae = () => Object.assign(new Error("503"), { status: 503 });
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "a", failWith: cae }), new FakeLlmProvider({ id: "b", failWith: cae })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    const r = await turn(f, handler);
    expect(r.reply).toMatch(/problema técnico/i);
    expect(r.reply).not.toMatch(/registrado|cocina|folio/i);
    expect(r.orderId).toBeNull();
  });

  it("T-FP04b el modelo crea el pedido y LUEGO ambos proveedores caen: el cliente recibe la confirmación de éxito", async () => {
    const f = buildRestaurantFixture();
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, productName: "Coca-Cola", requestedQuantity: 1 }] });
    const gateway = makeGateway();
    let n = 0;
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: () => {
          if (n++ === 0) {
            return result({ calls: [{ name: "crear_pedido", args: { branch_slug: "fco-montejo", customer_name: "Ana", payment_method: "efectivo", canal: "recoger", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }] } }] }, 0);
          }
          throw Object.assign(new Error("cae a mitad de turno"), { status: 500 });
        },
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    const r = await turn(f, handler, "una coca");
    expect(r.orderId).not.toBeNull();
    expect(r.reply).toMatch(/ya quedó registrado/i);
  });

  it("T-FP05 el proveedor tarda más que el presupuesto del turno: responde con mensaje de espera/técnico en lugar de seguir iterando", async () => {
    const f = buildRestaurantFixture();
    let llamadas = 0;
    const { handler } = (() => {
      const gateway = makeGateway();
      gateway.registerLadder("default", [
        new FakeLlmProvider({
          id: "lento",
          script: async () => {
            llamadas++;
            await new Promise((r) => setTimeout(r, 40));
            return result({ calls: [{ name: "buscar_producto", args: { query: "coca", branch_slug: "fco-montejo" } }] }, llamadas);
          },
        }),
      ]);
      gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
      return { handler: createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", turnBudgetMs: 10, maxToolUseTurns: 6 }) };
    })();
    const r = await turn(f, handler);
    expect(llamadas).toBe(1);
    expect(r.reply.length).toBeGreaterThan(0);
    expect(r.reply).toMatch(/problema técnico/i);
  });

  it("T-FP06 si crear_pedido falla, la siguiente llamada del turno sube al modelo de respaldo caro", async () => {
    const f = buildRestaurantFixture();
    // B04: solo un FALLO de sistema sube de modelo (un rechazo de regla, como crear sin cotizar, no): la base cae al crear el cliente.
    await seedConfirmedOrderFlow(f.repo, f.organizationId, `wa:${PHONE}`, { branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, productName: "Coca-Cola", requestedQuantity: 1 }] });
    vi.spyOn(f.repo, "upsertCustomer").mockRejectedValue(new Error("base caida"));
    const gateway = makeGateway();
    const roles: string[] = [];
    let n = 0;
    const script = (rol: string) => () => {
      roles.push(rol);
      return n++ === 0
        ? result({ calls: [{ name: "crear_pedido", args: { branch_slug: "fco-montejo", customer_name: "Ana", payment_method: "efectivo", canal: "recoger", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }] } }] }, n)
        : result({ text: "Déjame cotizar primero." }, n);
    };
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "barato", script: script("barato") })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "caro", script: script("caro") })]);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    const r = await turn(f, handler, "una coca");
    expect(roles).toEqual(["barato", "caro"]);
    expect(r.orderId).toBeNull();
  });

  const basura: Array<[string, { text: string; toolCalls?: Array<{ id: string; name: string; argumentsJson: string }> }]> = [
    ["texto vacío sin herramientas", { text: "" }],
    ["herramienta inexistente", { text: "", toolCalls: [{ id: "x", name: "borrar_todo", argumentsJson: "{}" }] }],
    ["argumentos JSON 'null'", { text: "", toolCalls: [{ id: "x", name: "buscar_producto", argumentsJson: "null" }] }],
    ["argumentos JSON arreglo", { text: "", toolCalls: [{ id: "x", name: "crear_pedido", argumentsJson: "[1,2,3]" }] }],
    ["argumentos con tipos equivocados", { text: "", toolCalls: [{ id: "x", name: "cotizar_pedido", argumentsJson: JSON.stringify({ branch_slug: 5, items: "muchos", canal: {} }) }] }],
    ["items con basura", { text: "", toolCalls: [{ id: "x", name: "crear_pedido", argumentsJson: JSON.stringify({ branch_slug: "fco-montejo", customer_name: "A", payment_method: "efectivo", items: [null, 7, "x", { product_id: {} }] }) }] }],
    ["herramienta sin nombre", { text: "", toolCalls: [{ id: "x", name: "", argumentsJson: "{}" }] }],
  ];
  it.each(basura)("respuesta basura del modelo (%s): el turno termina con texto para el cliente, sin lanzar y sin crear pedido", async (_n, step) => {
    const f = buildRestaurantFixture();
    const gateway = makeGateway();
    let n = 0;
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "p", script: () => (n++ === 0 ? { ...step, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 } : result({ text: "¿Me repites tu pedido?" }, n)) })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e", script: () => result({ text: "¿Me repites tu pedido?" }, 0) })]);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    const r = await turn(f, handler, "hola");
    expect(typeof r.reply).toBe("string");
    expect(r.reply.length).toBeGreaterThan(0);
    expect(r.orderId).toBeNull();
    expect((await f.repo.listOrders(f.organizationId, { propertyIds: null, limit: 10 })).orders).toHaveLength(0);
  });

  it("un modelo que se pasa de largo con tool calls infinitos agota el tope (4) y no itera sin fin", async () => {
    const f = buildRestaurantFixture();
    const { handler, requests } = scriptedHandler(f.repo, [{ calls: [{ name: "buscar_producto", args: { query: "coca", branch_slug: "fco-montejo" } }] }]);
    const r = await turn(f, handler);
    expect(requests.length).toBe(4);
    expect(r.reply).toMatch(/se me complicó/i);
  });
});
