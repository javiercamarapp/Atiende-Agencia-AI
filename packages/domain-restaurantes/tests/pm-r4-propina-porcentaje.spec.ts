// QA-PM-R4-whatsapp-03: la propina dicha en porcentaje la completa el servidor SOLO si el ultimo mensaje del cliente la acepta en afirmativo.
import { describe, expect, it } from "vitest";
import { porcentajePropinaDichoPorElCliente } from "../src/whatsapp/guards.ts";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

describe("porcentajePropinaDichoPorElCliente", () => {
  it.each([
    ["si, con tarjeta; de propina 10%", 10],
    ["Propina del 15 por ciento por favor", 15],
    ["dejo 12.5% de propina", 12.5],
  ])("%s -> %s", (m, esperado) => expect(porcentajePropinaDichoPorElCliente(m)).toBe(esperado));
  it.each([
    "¿se acostumbra dejar 10% de propina?",
    "sin propina",
    "no voy a dejar propina del 10%",
    "la otra vez dejé 15% de propina",
    "50% de descuento y la propina la doy en efectivo",
    "quiero 10% de descuento",
    "propina de 500%",
    "propina -5%",
    "propina del 40%",
  ])("%s -> null", (m) => expect(porcentajePropinaDichoPorElCliente(m)).toBeNull());
  it("undefined -> null", () => expect(porcentajePropinaDichoPorElCliente(undefined)).toBeNull());
});

describe("propina_porcentaje hostil en crear_pedido", () => {
  it.each([-5, 1000, "abc", 1e9, 31, 0])("%s se rechaza con mensaje claro", async (v) => {
    const f = buildRestaurantFixture();
    const ctx = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567" };
    await expect(
      invokeAgentTool(f.repo, ctx, "crear_pedido", { branch_slug: "fco-montejo", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }], canal: "recoger", customer_name: "Nora", payment_method: "tarjeta", propina_porcentaje: v }),
    ).rejects.toThrow(/propina_porcentaje debe ser/);
  });
});
