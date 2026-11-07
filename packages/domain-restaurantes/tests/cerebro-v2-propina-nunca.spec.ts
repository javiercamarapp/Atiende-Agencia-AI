// Conflicto base vs v2 (default del dueño, 7-nov): la propina NUNCA se sugiere ni se agrega (política PM «nunca»). El prompt base decía «se da en la terminal (con tarjeta)» y
// el servidor completaba `propina_porcentaje` desde el mensaje del cliente; v2 dice que es voluntaria, va directo al repartidor y no se suma al total. Con cerebro v2 gana v2.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { CIERRE_MAQUINA_ENV } from "../src/agent-tools/cierre-maquina.ts";
import { adaptarPromptPmV2 } from "../src/whatsapp/cerebro-v2/prompt-v2.ts";
import { PM_CONFIG_POR_OMISION, buildSystemPrompt } from "../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
  vi.stubEnv(CIERRE_MAQUINA_ENV, "1");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function cotizar(cerebroV2: boolean, extra: Record<string, unknown>) {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }], propinaPolitica: "solo_tarjeta" });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  const ctx = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567", flow: { key: "k:wa", turn: "1", now: () => Date.now() }, conversacionReciente: [{ role: "user" as const, content: "dos cocas para recoger, con tarjeta, de propina 20 pesos" }], ...(cerebroV2 ? { cerebroV2: true } : {}) };
  const r = (await invokeAgentTool(f.repo, ctx, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", minutos_para_recoger: 30, payment_method: "tarjeta", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }], ...extra })) as { result: { resumen_canonico?: string } };
  const snap = await f.repo.readOrderFlow(f.organizationId, "k:wa");
  return { resumen: r.result.resumen_canonico ?? "", propina: snap?.context?.quotedPropinaMxn, pct: snap?.context?.quotedPropinaPct };
}

describe("propina con cerebro v2: nunca se agrega", () => {
  it("cotizar_pedido con propina o propina_porcentaje: el servidor las descarta (ni en la cotización ni en el resumen)", async () => {
    for (const extra of [{ propina: 20 }, { propina_porcentaje: 10 }]) {
      const c = await cotizar(true, extra);
      expect(c.propina).toBeUndefined();
      expect(c.pct).toBeUndefined();
      expect(c.resumen).not.toMatch(/propina/i);
    }
  });
  it("sin la bandera no cambia (control: la propina sí se cotiza)", async () => {
    const c = await cotizar(false, { propina: 20 });
    expect(c.propina).toBe(20);
  });
  it("el prompt v2 no dice que la propina se da en la terminal (una sola regla: voluntaria, al repartidor, fuera del total)", () => {
    const base = buildSystemPrompt(PM_CONFIG_POR_OMISION, [], { isNew: true }, new Date());
    expect(base).toMatch(/terminal \(con tarjeta\)|en la terminal \(tarjeta\)/);
    const v2 = adaptarPromptPmV2(base);
    expect(v2).not.toMatch(/se da en la terminal|en la terminal \(tarjeta\)/);
  });
});
