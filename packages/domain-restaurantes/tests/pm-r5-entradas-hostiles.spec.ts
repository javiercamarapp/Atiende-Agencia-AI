// QA-PM-R5-reglas-08 (minutos_para_recoger invalido), -09 (tortilla con acento/mayuscula/espacio), -11 (complemento inexistente al cotizar).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:00:00-06:00")); // miercoles 12:00
});
afterEach(() => vi.useRealTimers());

function setup(channel: "whatsapp" | "voz") {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "08:00", cierra: "23:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  const ctx = { organizationId: f.organizationId, channel, phone: "9991234567" };
  const coca = { product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 };
  const base = { branch_slug: "fco-montejo", canal: "recoger", items: [coca] };
  const cotizar = (extra: Record<string, unknown>, items: unknown[] = [coca]) => invokeAgentTool(f.repo, ctx, "cotizar_pedido", { ...base, items, ...extra });
  const crear = (extra: Record<string, unknown>) => invokeAgentTool(f.repo, ctx, "crear_pedido", { ...base, customer_name: "Nora", payment_method: "efectivo", ...extra });
  return { f, cotizar, crear };
}

describe.each(["whatsapp", "voz"] as const)("%s", (channel) => {
  describe("minutos_para_recoger invalido se rechaza (reglas-08)", () => {
    it.each([-5, 1.5, "abc", 100000, 800, 721, Number.NaN, {}])("%s -> error accionable en cotizar y crear", async (v) => {
      const s = setup(channel);
      await expect(s.cotizar({ minutos_para_recoger: v })).rejects.toThrow(/minutos_para_recoger debe ser/);
      await expect(s.crear({ minutos_para_recoger: v })).rejects.toThrow(/minutos_para_recoger debe ser/);
    });
    it.each([0, "", null, undefined, "0"])("negativo: %s = sin dato, el pedido se crea", async (v) => {
      const s = setup(channel);
      expect((await s.crear({ minutos_para_recoger: v })).orderId).not.toBeNull();
    });
    it.each([1, 40, "45", 240])("plazo valido %s sigue funcionando", async (v) => {
      const s = setup(channel);
      expect((await s.cotizar({ minutos_para_recoger: v })).result).toBeDefined();
    });
  });

  describe("complemento inexistente se rechaza al cotizar (reglas-11)", () => {
    it("chimichurri falla en cotizar_pedido", async () => {
      const s = setup(channel);
      await expect(s.cotizar({ requested_complements: ["chimichurri"] })).rejects.toThrow(/chimichurri/);
    });
    it.each([[["salsa_pina"]], [["pico de gallo", ""]], [[]]])("negativo: %j pasa", async (v) => {
      const s = setup(channel);
      expect((await s.cotizar({ requested_complements: v })).result).toBeDefined();
    });
  });

  describe("tortilla con acento, mayuscula o espacio (reglas-09)", () => {
    it.each(["maíz", "Maiz", "maiz ", " MAÍZ", "Harina", "MIXTA "])("%j se acepta en cotizar", async (t) => {
      const s = setup(channel);
      const tacos = { product_id: s.f.products.tacosPastor, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: t };
      const r = await s.cotizar({}, [tacos]);
      expect(JSON.stringify(r.result)).toMatch(/"tortilla":"(maiz|harina|mixta)"/);
    });
    it.each(["azul", "", 5, null])("negativo: %j sigue pidiendo la tortilla", async (t) => {
      const s = setup(channel);
      const tacos = { product_id: s.f.products.tacosPastor, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: t };
      await expect(s.cotizar({}, [tacos])).rejects.toThrow(/tortilla/);
    });
  });
});
