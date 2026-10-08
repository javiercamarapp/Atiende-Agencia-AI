// QA-PM-R3-reglas-09 (P3): entradas invalidas que se descartaban en silencio y creaban el pedido igual (R149 salsa inexistente, R161 propina en texto).
// QA-PM-R3-voz-03 (P2): "guacamole extra" cobrado como la doble salsa guacamolera.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

function setup(channel: "whatsapp" | "voz" | "web" = "whatsapp") {
  const f = buildRestaurantFixture();
  const ctx = { organizationId: f.organizationId, channel, phone: "9991234567" };
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
  const crear = (extra: Record<string, unknown>) => invokeAgentTool(f.repo, ctx, "crear_pedido", { branch_slug: "fco-montejo", items, canal: "recoger", customer_name: "Nora", payment_method: "efectivo", ...extra });
  return { f, ctx, items, crear };
}

describe.each(["whatsapp", "voz"] as const)("%s: crear_pedido rechaza lo que antes descartaba en silencio", (channel) => {
  it("un complemento fuera de la lista cerrada ('chimichurri') se rechaza nombrando los validos", async () => {
    const s = setup(channel);
    await expect(s.crear({ requested_complements: ["chimichurri"] })).rejects.toThrow(/chimichurri.*salsa_guacamolera/);
  });
  it("los complementos validos y sus alias siguen pasando", async () => {
    const s = setup(channel);
    expect((await s.crear({ requested_complements: ["salsa_pina", "pico de gallo", ""] })).orderId).not.toBeNull();
  });
  it("una propina en texto ('veinte') se rechaza; 0, vacia o numerica siguen igual", async () => {
    const s = setup(channel);
    await expect(s.crear({ payment_method: "tarjeta", propina: "veinte" })).rejects.toThrow(/monto numérico/);
    expect((await s.crear({ propina: 0 })).orderId).not.toBeNull();
  });
});

describe("guacamole extra", () => {
  it("cotizar con doble salsa guacamolera avisa que 'guacamole extra' es el producto Extra Guacamole; con otra salsa no avisa", async () => {
    const s = setup("voz");
    const extra = randomUUID();
    s.f.repo.seedProduct({ id: extra, organizationId: s.f.organizationId, categoryId: s.f.categories.bebidas, name: "Extra Salsa", description: null, searchKeywords: [] });
    s.f.repo.seedBranchProduct({ propertyId: s.f.propertyId, productId: extra, price: 19, isAvailable: true });
    const cotizar = (doble: string[]) => invokeAgentTool(s.f.repo, s.ctx, "cotizar_pedido", { branch_slug: "fco-montejo", items: [{ product_id: s.f.products.tacosPastor, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: "maiz" }], canal: "recoger", doble_salsas: doble });
    const conGuacamole = await cotizar(["salsa_guacamolera"]);
    expect((conGuacamole.result as { aviso_guacamole?: string }).aviso_guacamole).toMatch(/Extra Guacamole/);
    const conRoja = await cotizar(["salsa_roja"]);
    expect(conRoja.result).not.toHaveProperty("aviso_guacamole");
  });
});

describe("cotizacion sin promocion (QA-PM-R3-reglas-03)", () => {
  it("sin promocion aplicada ni sugerida la herramienta avisa que no hay cortesias", async () => {
    const s = setup("voz");
    const q = await invokeAgentTool(s.f.repo, s.ctx, "cotizar_pedido", { branch_slug: "fco-montejo", items: s.items, canal: "recoger" });
    expect((q.result as { sin_cortesias?: string }).sin_cortesias).toMatch(/NO incluye ninguna cortesía/);
  });
});
