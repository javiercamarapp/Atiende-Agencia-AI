// PM R13 Q5 (T7-012 Luna r2): el bot dijo «piña picada sin costo» y luego cotizó y creó «Extra Piña» ($19): total $407 en vez de $388. El prompt abría DOS caminos para la doble
// piña (doble_salsas y el producto «Extra Piña» de buscar_producto) y mezclaba «piña picada (gratis si la piden; la doble es el extra piña)». Decisión de Javier (R13, «hazlo
// según tu recomendación»): todas las salsas, incluida la piña, pedidas como complemento son SIEMPRE sin costo; lo ÚNICO cobrado es la doble porción de CUALQUIER salsa
// (incluida la piña) y siempre por doble_salsas (producto «Extra Salsa», $19 por salsa doble), solo si el cliente dice explícitamente doble o extra. Un solo camino.
// El servidor ya cobra así (order-quote.ts buildDoubleSalsaLine); estas pruebas atan que el PROMPT lo diga y que el servidor no contradiga. Determinista, sin LLM.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import type { BranchSummary } from "../src/types.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const SUCURSALES: BranchSummary[] = [{ propertyId: "p0", slug: "garcia-lavin", name: "García Lavín", address: null }];
const prompt = buildPmSystemPrompt({
  businessName: PM_CONFIG_POR_OMISION.businessName,
  agentName: "el asistente virtual",
  deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  saludo: "Buenas tardes",
  branches: SUCURSALES,
  entryBranch: null,
  customer: { isNew: true },
  fechaHoraLocal: "lunes 14:00",
  diaSemana: "lunes",
});

describe("PM R13 Q5: la piña es siempre sin costo; solo la DOBLE porción de una salsa se cobra, por doble_salsas", () => {
  it("dice que las salsas pedidas como complemento, incluida la piña, son SIEMPRE sin costo (requested_complements)", () => {
    expect(prompt).toContain("Todas las salsas, incluida la piña, pedidas como complemento son SIEMPRE sin costo");
    expect(prompt).toMatch(/también cuando el cliente diga «sin costo»/);
  });

  it("dice que lo ÚNICO cobrado es la doble porción de CUALQUIER salsa, incluida la piña, siempre por doble_salsas", () => {
    expect(prompt).toMatch(/Lo ÚNICO cobrado es la DOBLE porción de cualquier salsa, incluida la piña, y siempre por doble_salsas/);
    expect(prompt).toMatch(/solo cuando el cliente dice explícitamente doble o extra/);
  });

  it("no manda buscar «Extra Piña» con buscar_producto ni abre un segundo camino", () => {
    expect(prompt).toMatch(/NUNCA busque «Extra Piña» con buscar_producto/);
    expect(prompt).not.toMatch(/"extra piña" y los demás extras se buscan con buscar_producto/);
    expect(prompt).not.toMatch(/la doble es el extra piña/);
    expect(prompt).not.toMatch(/y extra piña cuestan/);
    // frases que sostienen el camino único (revisión: sobrevivían a la mutación)
    expect(prompt).toContain("la doble piña también");
    expect(prompt).toContain("ni cobre la piña simple");
    expect(prompt).toContain("(por ejemplo Extra Guacamole)");
  });

  it("no fija el precio en duro: el importe de la doble sale de cotizar_pedido (H6)", () => {
    expect(prompt).toContain("siempre por doble_salsas (al precio que devuelva cotizar_pedido)");
    expect(prompt).not.toMatch(/\$19 por cada salsa doble/);
  });
});

describe("PM R13 Q5: el servidor cobra la doble piña (y la de roja/verde) por doble_salsas con «Extra Salsa» $19", () => {
  function setup() {
    const f = buildRestaurantFixture();
    for (const nombre of ["Extra Salsa", "Extra Piña"]) {
      const id = randomUUID();
      f.repo.seedProduct({ id, organizationId: f.organizationId, categoryId: f.categories.bebidas, name: nombre, description: null, searchKeywords: [] });
      f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: id, price: 19, isAvailable: true });
    }
    const ctx = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567" };
    const items = [{ product_id: f.products.tacosPastor, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: "maiz" }];
    const base = { branch_slug: "fco-montejo", items, canal: "recoger", customer_name: "Nora", payment_method: "efectivo" };
    return { f, ctx, base };
  }
  const cotiza = async (s: ReturnType<typeof setup>, extra: Record<string, unknown>) => {
    const r = await invokeAgentTool(s.f.repo, s.ctx, "cotizar_pedido", { ...s.base, ...extra });
    return (r.result as { quote: { total: number; lines: { name: string }[] } }).quote;
  };

  it("la piña pedida como complemento no suma nada", async () => {
    const s = setup();
    const base = await cotiza(s, {});
    const conPina = await cotiza(s, { requested_complements: ["pina", "salsa_pina"] });
    expect(conPina.total).toBe(base.total);
    expect(conPina.lines).toHaveLength(base.lines.length);
  });

  it("la doble piña por doble_salsas suma $19 como «Extra Salsa» (no como el producto Extra Piña)", async () => {
    const s = setup();
    const base = await cotiza(s, {});
    const q = await cotiza(s, { doble_salsas: ["salsa_pina"] });
    expect(q.total).toBe(base.total + 19);
    expect(q.lines.map((l) => l.name).join("|")).toMatch(/Extra Salsa \(doble porción: .*piña/i);
    expect(q.lines.map((l) => l.name)).not.toContain("Extra Piña");
  });

  it("la doble de roja y de verde sigue por doble_salsas, $19 por cada una", async () => {
    const s = setup();
    const base = await cotiza(s, {});
    expect((await cotiza(s, { doble_salsas: ["salsa_roja"] })).total).toBe(base.total + 19);
    expect((await cotiza(s, { doble_salsas: ["salsa_roja", "salsa_verde"] })).total).toBe(base.total + 38);
  });
});
