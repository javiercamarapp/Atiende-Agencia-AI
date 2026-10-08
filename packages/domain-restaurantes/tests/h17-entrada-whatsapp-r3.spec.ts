// QA-PM-R3-reglas-05 (P2): H17 en el SERVIDOR. Un chat que entra por el numero de una sucursal no toma pedidos PARA RECOGER en otra (R76 creaba 3 tacos en Pensiones
// desde el chat de Garcia Lavin); se rechaza con el telefono de la sucursal que le toca. Domicilio, voz y la vista previa del dueno no cambian.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

function mundo() {
  const f = buildRestaurantFixture();
  const pensionesId = randomUUID();
  f.repo.seedBranch({ propertyId: pensionesId, organizationId: f.organizationId, name: "Victory Pensiones", slug: "pensiones", status: "active", phone: "999 555 0101", address: null, lat: 21.02, lng: -89.62 });
  f.repo.seedBranchProduct({ propertyId: pensionesId, productId: f.products.cocaCola, price: 45, isAvailable: true });
  const base = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567" };
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
  return { f, pensionesId, base, items };
}

describe("H17: recoger en una sucursal distinta a la del chat", () => {
  it("cotizar y crear para recoger en OTRA sucursal se rechazan con el telefono de la que le toca", async () => {
    const m = mundo();
    const ctx = { ...m.base, entryPropertyId: m.f.propertyId };
    const q = invokeAgentTool(m.f.repo, ctx, "cotizar_pedido", { branch_slug: "pensiones", items: m.items, canal: "recoger" });
    await expect(q).rejects.toThrow(/Victory Pensiones.*999 555 0101/);
    const c = invokeAgentTool(m.f.repo, ctx, "crear_pedido", { branch_slug: "pensiones", items: m.items, canal: "recoger", customer_name: "Nora", payment_method: "efectivo" });
    await expect(c).rejects.toThrow(/H17/);
  });

  it("recoger en la sucursal del chat sigue funcionando", async () => {
    const m = mundo();
    const q = await invokeAgentTool(m.f.repo, { ...m.base, entryPropertyId: m.f.propertyId }, "cotizar_pedido", { branch_slug: "fco-montejo", items: m.items, canal: "recoger" });
    expect(q.result).toHaveProperty("quote");
  });

  it("domicilio, voz, vista previa y chat sin sucursal de entrada no se limitan", async () => {
    const m = mundo();
    const otra = { branch_slug: "pensiones", items: m.items, canal: "recoger" };
    expect(await invokeAgentTool(m.f.repo, { ...m.base, entryPropertyId: m.f.propertyId, modo: "preview" }, "cotizar_pedido", otra)).toHaveProperty("result");
    expect(await invokeAgentTool(m.f.repo, m.base, "cotizar_pedido", otra)).toHaveProperty("result");
    expect(await invokeAgentTool(m.f.repo, { ...m.base, channel: "voz", entryPropertyId: m.f.propertyId }, "cotizar_pedido", otra)).toHaveProperty("result");
  });
});
