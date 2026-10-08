// QA-PM-R3-reglas-11 (P3): la tortilla de harina de un kilo no llegaba a la comanda (R02, RW10, VRG06): el renglon "Pastor — 1 kg" no exige tortilla y la descartaba.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

function mundo() {
  const f = buildRestaurantFixture();
  const kilo = randomUUID();
  f.repo.seedProduct({ id: kilo, organizationId: f.organizationId, categoryId: f.categories.tacos, name: "Pastor — 1 kg", description: "Un kilo de carne con tortillas", searchKeywords: [] });
  f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: kilo, price: 900, isAvailable: true });
  return { f, kilo };
}

const pedido = (m: ReturnType<typeof mundo>, items: unknown[]) =>
  createOrder(m.f.repo, { organizationId: m.f.organizationId, branchSlug: "fco-montejo", customerName: "Nora", customerPhone: "9991234567", items, source: "whatsapp", canal: "recoger", paymentMethod: "efectivo" } as never);

describe("tortilla de un kilo de carne", () => {
  it("la que eligio el cliente viaja en las notas de la comanda", async () => {
    const m = mundo();
    const o = await pedido(m, [{ productId: m.kilo, productName: "Pastor — 1 kg", requestedQuantity: 1, tortilla: "harina" }]);
    expect(o.notes).toContain("Tortilla (Pastor — 1 kg): harina.");
  });
  it("sin tortilla elegida no se inventa una, y una bebida con tortilla copiada por el modelo no ensucia la comanda", async () => {
    const m = mundo();
    const sin = await pedido(m, [{ productId: m.kilo, productName: "Pastor — 1 kg", requestedQuantity: 1 }]);
    expect(sin.notes ?? "").not.toContain("Tortilla (");
    const bebida = await pedido(m, [{ productId: m.f.products.cocaCola, productName: "Coca-Cola", requestedQuantity: 1, tortilla: "maiz" }]);
    expect(bebida.notes ?? "").not.toContain("Tortilla (");
  });
});
