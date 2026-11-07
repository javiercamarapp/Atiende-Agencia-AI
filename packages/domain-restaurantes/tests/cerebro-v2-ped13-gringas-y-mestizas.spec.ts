// C3 PED-13 (cerebro v2): «dos gringas de costilla y una mestiza de pastor» son 2 órdenes de gringa ($217 c/u) + 1 orden de mestiza ($168) = $602. El menú real trae cada gringa y
// cada mestiza como «Orden de 2 tacos» (pack_size 2 y requested_quantity en PIEZAS), y tres reglas leían «una mestiza» como UNA pieza: el bloque de cantidad no múltiplo («se venden
// en órdenes de 2»), el rechazo de cotizar «¿2 órdenes (4 piezas) o 2 piezas?» y el paso 5 del prompt. Con cerebro v2 cada gringa/mestiza que nombra el cliente es una orden (platillo).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { bloqueCantidadNoMultiplo, bloqueGringasYMestizasComoOrdenes } from "../src/unidades-pm.ts";
import { adaptarPromptPmV2 } from "../src/whatsapp/cerebro-v2/prompt-v2.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PIDE = "Hola, dos gringas de costilla y una mestiza de pastor";

describe("PED-13 bloques del turno", () => {
  it("sin la bandera: «una mestiza» dispara la regla de cantidad no múltiplo (el defecto)", () => {
    expect(bloqueCantidadNoMultiplo([PIDE])).toMatch(/mestiza/);
  });
  it("con cerebro v2: las gringas y mestizas no pasan por la regla de piezas", () => {
    expect(bloqueCantidadNoMultiplo([PIDE], { gringasYMestizasPorOrden: true })).toBe("");
    // Los tacos sueltos siguen igual.
    expect(bloqueCantidadNoMultiplo(["4 tacos de bistec"], { gringasYMestizasPorOrden: true })).toMatch(/bistec/);
  });
  it("con cerebro v2: el bloque dice cuántas órdenes y cuánto va en requested_quantity, sin preguntar", () => {
    const b = bloqueGringasYMestizasComoOrdenes([PIDE]);
    expect(b).toMatch(/2 gringas de costilla = 2 órdenes.*requested_quantity 4/);
    expect(b).toMatch(/1 mestiza de pastor = 1 orden.*requested_quantity 2/);
    expect(b).toMatch(/no pregunte/i);
  });
  it("si el cliente habla de piezas o tacos, no se supone nada", () => {
    expect(bloqueGringasYMestizasComoOrdenes(["3 piezas de gringa de pastor"])).toBe("");
    expect(bloqueGringasYMestizasComoOrdenes(["2 órdenes de gringas"])).toBe("");
    expect(bloqueGringasYMestizasComoOrdenes(["una coca"])).toBe("");
  });
});

describe("PED-13 cotizar_pedido con el menú real (Orden de 2 tacos en la descripción)", () => {
  function mundo() {
    const f = buildRestaurantFixture();
    const gringa = randomUUID();
    const mestiza = randomUUID();
    f.repo.seedProduct({ id: gringa, organizationId: f.organizationId, categoryId: f.categories.tacos, name: "Gringa de Costilla", description: "Orden de 2 tacos", searchKeywords: [] });
    f.repo.seedProduct({ id: mestiza, organizationId: f.organizationId, categoryId: f.categories.tacos, name: "Mestiza de Pastor", description: "Orden de 2 tacos", searchKeywords: [] });
    f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: gringa, price: 217, isAvailable: true });
    f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: mestiza, price: 168, isAvailable: true });
    const ctx = (cerebroV2: boolean) => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567", conversacionReciente: [{ role: "user" as const, content: PIDE }], ...(cerebroV2 ? { cerebroV2: true } : {}) });
    const items = (g: number, m: number) => [
      { product_id: gringa, product_name: "Gringa de Costilla", requested_quantity: g, tortilla: "maiz" },
      { product_id: mestiza, product_name: "Mestiza de Pastor", requested_quantity: m, tortilla: "maiz" },
    ];
    return { f, ctx, items };
  }

  it("con cerebro v2: 2 órdenes de gringa (4 piezas) + 1 de mestiza (2 piezas) cotizan $602 sin preguntar", async () => {
    const m = mundo();
    const r = await invokeAgentTool(m.f.repo, m.ctx(true), "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: m.items(4, 2) });
    expect((r.result as { quote: { total: number } }).quote.total).toBe(602);
  });
  it("con cerebro v2: si el modelo cotiza las piezas tal cual (2 y 1), se le corrige a órdenes", async () => {
    const m = mundo();
    await expect(invokeAgentTool(m.f.repo, m.ctx(true), "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: m.items(2, 1) })).rejects.toThrow(/requested_quantity 4.*NO pregunte/s);
  });
  it("sin la bandera: el rechazo de siempre obliga a preguntar órdenes o piezas", async () => {
    const m = mundo();
    await expect(invokeAgentTool(m.f.repo, m.ctx(false), "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: m.items(4, 2) })).rejects.toThrow(/¿2 órdenes \(4 piezas\) o 2 piezas\?/);
  });
});

describe("PED-13 prompt v2", () => {
  it("el paso 5 del prompt v2 ya no manda preguntar piezas de gringas y mestizas", () => {
    const base = buildPmSystemPrompt({ businessName: "Los Taquitos de PM", agentName: "Lupita", deliveryTimeText: "de 40 a 50 minutos", saludo: "buenas tardes", branches: [], entryBranch: null, customer: { isNew: true } });
    expect(base).toMatch(/gringas y mestizas de 2; alambres/);
    const v2 = adaptarPromptPmV2(base);
    expect(v2).not.toMatch(/gringas y mestizas de 2; alambres/);
    expect(v2).not.toMatch(/gringas y mestizas en órdenes de 2/);
    expect(v2).toMatch(/cada gringa o mestiza que pide el cliente .* es UNA orden/);
  });
});
