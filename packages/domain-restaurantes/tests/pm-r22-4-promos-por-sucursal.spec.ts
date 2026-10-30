// R22 decision 4: las promociones (lunes 2x1, martes combo de nachos) valen SOLO para recoger y SOLO en Francisco de Montejo (T2), Pensiones (T3) y
// Galerias (T4); nunca a domicilio ni en Prolongacion Montejo, Garcia Lavin, Altabrisa o Playa. El agente (WhatsApp y voz) dice que ahi no aplica.
import { describe, expect, it } from "vitest";
import { prepareCreateOrder } from "../src/orders.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { PM_PROMOS_POR_OMISION, buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { comportamientoVozPm } from "../src/voz/perfil-voz-pm.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const plan = buildPmSeedPlan(data, agent);
const LUNES_19_30 = new Date("2026-10-13T01:30:00Z"); // lunes 12-oct 19:30 en Merida

describe("R22-4 seed: alcance por sucursal de las promos", () => {
  it("ambas promos solo en T2, T3 y T4 y nunca a domicilio", () => {
    for (const code of ["LUNES2X1PM", "MARTESNACHOSPM"]) {
      const p = plan.promotions.find((x) => x.code === code)!;
      expect(p.branchIds, code).toEqual(["T2", "T3", "T4"]);
      expect(p.channels, code).toEqual(["recoger"]);
    }
  });
  it("el texto de promociones del agente nombra las 3 sucursales y ya no dice 'todas las sucursales'", () => {
    expect(plan.whatsappAgent.promosText).toBe(PM_PROMOS_POR_OMISION);
    expect(plan.whatsappAgent.promosText).toMatch(/solo en Francisco de Montejo, Pensiones y Galerías/);
    expect(plan.whatsappAgent.promosText).not.toMatch(/todas las sucursales/);
    // la cuenta real ya sembrada con el texto anterior lo recibe (reemplazo de texto sembrado)
    expect(plan.whatsappAgent.legacyPromosTexts).toContain("lunes 2x1 en tacos al pastor y martes nachos de pastor con 2 aguas de cortesía; solo para recoger, en todas las sucursales");
  });
});

describe("R22-4 motor: el lunes 2x1 aplica en Pensiones y no en Garcia Lavin ni Prolongacion Montejo", () => {
  async function descuento(slug: string) {
    const world = await buildInMemoryPmWorld(plan);
    const orden = await prepareCreateOrder(
      world.repo,
      { organizationId: world.organizationId, branchSlug: slug, customerName: "Cliente Prueba", customerPhone: "0001000001", canal: "recoger", source: "web", items: [{ productId: world.productIds.get("Taco Al Pastor (individual)")!, requestedQuantity: 2, tortilla: "maiz" }] },
      { asOf: LUNES_19_30 },
    );
    return { descuento: orden.discount, codigo: orden.appliedPromotion?.code ?? null };
  }
  it("Pensiones (T3): 2x1 aplicado", async () => {
    const r = await descuento("pensiones");
    expect(r.codigo).toBe("LUNES2X1PM");
    expect(r.descuento).toBeGreaterThan(0);
  });
  it.each(["garcia-lavin", "prol-montejo"])("%s: sin promocion", async (slug) => {
    const r = await descuento(slug);
    expect(r.codigo).toBeNull();
    expect(r.descuento).toBe(0);
  });
});

describe("R22-4 agente: la regla H3/H13 dice donde aplica y que ahi no aplica donde no", () => {
  const branches = [{ propertyId: "p0", slug: "garcia-lavin", name: "García Lavín", address: null }];
  const base = { businessName: PM_CONFIG_POR_OMISION.businessName, agentName: "el asistente virtual", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText, branches };
  const wa = buildPmSystemPrompt({ ...base, saludo: "Buenas tardes", entryBranch: null, customer: { isNew: true }, fechaHoraLocal: "lunes 14:00", diaSemana: "lunes" });
  const voz = comportamientoVozPm(base);
  it.each([["whatsapp", wa], ["voz", voz]])("%s: H3 lista las 3 sucursales y manda decir que ahi no aplica (a domicilio u otra sucursal)", (_c, p) => {
    expect(p).toMatch(/H3\. Promociones solo para recoger: [^\n]*solo en Francisco de Montejo, Pensiones y Galerías/);
    expect(p).toMatch(/no aplica/);
    expect(p).not.toMatch(/en todas las sucursales/);
  });
  it("whatsapp: H3 y H13 no prometen la promo a domicilio ni en una sucursal fuera de la lista", () => {
    expect(wa).toMatch(/Nunca las prometa a domicilio ni en una sucursal que no esté en esa lista/);
    expect(wa).toMatch(/H13\. Combo del martes \([^)]*solo para recoger y solo en las sucursales de H3/);
    expect(wa).toMatch(/una sucursal sin la promo/);
  });
});
