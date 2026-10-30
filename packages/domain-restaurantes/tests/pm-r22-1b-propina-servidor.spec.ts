// R22 #1 (servidor y herramientas): la politica de propina del seed de PM es «nunca»; la SALIDA de cotizar_pedido con tarjeta ya no manda preguntar_propina=true
// y las descripciones/errores de las herramientas no empujan al modelo a preguntar por la propina.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOOL_DEFINITIONS, invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
afterEach(() => vi.useRealTimers());

describe("R22-1b propina: servidor", () => {
  it("el seed siembra propina_politica «nunca» (valor valido del tipo PropinaPolitica)", () => {
    expect(data.reglas.propina_politica).toBe("nunca");
    expect(buildPmSeedPlan(data, agent).policy.propinaPolitica).toBe("nunca");
  });
  it.each(["tarjeta", "efectivo"] as const)("cotizar_pedido con %s no manda preguntar_propina", async (pago) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T01:30:00Z")); // martes 13-oct 19:30 en Merida
    const world = await buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
    const r = await invokeAgentTool(world.repo, { organizationId: world.organizationId, channel: "whatsapp", phone: "0001000001" }, "cotizar_pedido", {
      branch_slug: "pensiones", canal: "recoger", payment_method: pago,
      items: [{ product_id: world.productIds.get("Taco Al Pastor (individual)")!, product_name: "Taco Al Pastor (individual)", requested_quantity: 2, tortilla: "maiz" }],
    });
    const quote = (r as { result: { quote?: { propina_politica?: string; preguntar_propina?: boolean } } }).result.quote;
    expect(quote?.propina_politica).toBe("nunca");
    expect(quote?.preguntar_propina).toBe(false);
  });
});

describe("R22-1b propina: descripciones de herramientas", () => {
  const texto = JSON.stringify(AGENT_TOOL_DEFINITIONS);
  it("ninguna descripcion manda preguntar o saber si corresponde preguntar propina", () => {
    expect(texto).not.toMatch(/corresponde preguntar propina/);
    expect(texto).not.toMatch(/si aplica, propina/);
    expect(texto).not.toMatch(/cuánto desea dejar/);
    expect(texto).not.toMatch(/Mándela aquí en cuanto la dé/);
    expect(texto).toMatch(/nunca (la )?pregunte/i);
  });
});
