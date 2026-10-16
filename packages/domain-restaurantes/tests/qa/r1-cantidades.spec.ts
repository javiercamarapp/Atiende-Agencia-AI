// QA R1 -- cantidades: tope de piezas por renglon (agentes-10), cantidad no numerica por WhatsApp (viaje-12) y propina absurda (agentes-22).
import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool, type AgentToolContext } from "../../src/agent-tools/registry.ts";
import { MAX_PIEZAS_POR_RENGLON } from "../../src/order-quote.ts";
import { quoteOrder } from "../../src/orders.ts";
import { banco } from "./r1-arnes-whatsapp-pm.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("agentes-10: 120 tacos para una fiesta se pueden cotizar", () => {
  it("quoteOrder de 120 tacos de pastor en T7 cotiza $5,040 (antes: 'Productos o cantidades invalidos')", async () => {
    const b = await banco();
    const q = await quoteOrder(b.w.repo, { organizationId: b.w.organizationId, branchSlug: "garcia-lavin", canal: "recoger", items: [{ productId: b.pid("Taco Al Pastor (individual)"), requestedQuantity: 120, tortilla: "maiz" }] });
    expect(q.total).toBe(5040);
  });
  it("mas del tope por renglon se rechaza con un mensaje accionable que dice el maximo", async () => {
    const b = await banco();
    const items = [{ productId: b.pid("Taco Al Pastor (individual)"), requestedQuantity: MAX_PIEZAS_POR_RENGLON + 1, tortilla: "maiz" as const }];
    await expect(quoteOrder(b.w.repo, { organizationId: b.w.organizationId, branchSlug: "garcia-lavin", canal: "recoger", items })).rejects.toThrow(/máximo es de 500 piezas/);
  });
  it("por WhatsApp los 120 tacos se cotizan y el servidor retiene el pedido al crear (>$4,000)", async () => {
    const b = await banco();
    const items = [{ product_id: b.pid("Taco Al Pastor (individual)"), product_name: "Taco Al Pastor (individual)", requested_quantity: 120, tortilla: "maiz" }];
    const ctx: AgentToolContext = { organizationId: b.w.organizationId, channel: "whatsapp", phone: "+5219990000035" };
    const q = await invokeAgentTool(b.w.repo, ctx, "cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", items });
    expect((q.raw as { total: number }).total).toBe(5040);
  });
});

describe("viaje-12: una cantidad no numerica por WhatsApp se rechaza en vez de cotizarse como 1", () => {
  const kilo = (b: Awaited<ReturnType<typeof banco>>, q: unknown) => ({ branch_slug: "garcia-lavin", canal: "recoger", items: [{ product_id: b.pid("Pastor — 1 kg"), product_name: "Pastor — 1 kg", requested_quantity: q }] });
  it.each([["medio", "medio"], ["dos", "dos"], ["cero", 0], ["fraccion", 1.5], ["negativo", -2], ["ausente", undefined], ["texto con numero", "12 tacos"]])("%s: error accionable en usted", async (_n, q) => {
    const b = await banco();
    const ctx: AgentToolContext = { organizationId: b.w.organizationId, channel: "whatsapp", phone: "+5219990000036" };
    await expect(invokeAgentTool(b.w.repo, ctx, "cotizar_pedido", kilo(b, q))).rejects.toThrow(/Indique la cantidad con un número entero/);
  });
  it("un entero escrito como texto ('2') o numero (2) se acepta: 2 kg x $900", async () => {
    const b = await banco();
    const ctx: AgentToolContext = { organizationId: b.w.organizationId, channel: "whatsapp", phone: "+5219990000037" };
    for (const q of [2, "2"]) {
      const r = await invokeAgentTool(b.w.repo, ctx, "cotizar_pedido", kilo(b, q));
      expect((r.raw as { total: number }).total).toBe(1800);
    }
  });
  it("el modelo recibe el error como {error} (no se cotiza ni se marca fallo de crear_pedido)", async () => {
    const b = await banco();
    const { executeAgentToolSafely } = await import("../../src/agent-tools/registry.ts");
    const r = await executeAgentToolSafely(b.w.repo, { organizationId: b.w.organizationId, channel: "whatsapp", phone: "+5219990000038" }, "cotizar_pedido", kilo(b, "medio"));
    expect((r.result as { error: string }).error).toMatch(/medio kilo/);
  });
});

describe("agentes-22: la propina no puede superar el total del pedido", () => {
  async function crearConPropina(propina: number) {
    const b = await banco();
    const ctx = (turn: string) => ({ organizationId: b.w.organizationId, channel: "whatsapp" as const, phone: "+5219990000039", flow: { key: "wa:+5219990000039", turn } });
    const { executeAgentToolSafely } = await import("../../src/agent-tools/registry.ts");
    const items = [{ product_id: b.pid("Taco Al Pastor (individual)"), product_name: "Taco Al Pastor (individual)", requested_quantity: 6, tortilla: "maiz" }];
    await executeAgentToolSafely(b.w.repo, ctx("1"), "cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", payment_method: "tarjeta", items });
    await executeAgentToolSafely(b.w.repo, ctx("2"), "confirmar_resumen", {});
    return executeAgentToolSafely(b.w.repo, ctx("2"), "crear_pedido", { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "X", payment_method: "tarjeta", propina, items });
  }
  it("$5,000 de propina sobre $252 se rechaza con un mensaje accionable y no crea el pedido", async () => {
    const r = await crearConPropina(5000);
    expect(r.orderId).toBeNull();
    expect((r.result as { error: string }).error).toMatch(/propina no puede ser mayor/);
  });
  it("una propina razonable ($50 sobre $252) y una igual al total se aceptan", async () => {
    expect((await crearConPropina(50)).orderId).toBeTruthy();
    expect((await crearConPropina(252)).orderId).toBeTruthy();
  });
});
