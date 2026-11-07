// Conflicto base vs v2 (default del dueño, 7-nov): la propina NUNCA se sugiere ni se agrega (política PM «nunca»). El prompt base decía «se da en la terminal (con tarjeta)» y
// el servidor completaba `propina_porcentaje` desde el mensaje del cliente; v2 dice que es voluntaria, va directo al repartidor y no se suma al total. Con cerebro v2 gana v2.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { CIERRE_MAQUINA_ENV } from "../src/agent-tools/cierre-maquina.ts";
import { PM_POLICY_RULES_V2, adaptarPromptPmV2 } from "../src/whatsapp/cerebro-v2/prompt-v2.ts";
import { quitarAlgoMasRepetido } from "../src/whatsapp/cerebro-v2/texto-final.ts";
import { PM_PROMOS_POR_OMISION } from "../src/whatsapp/perfil-pm.ts";
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

// Conflictos base vs v2 (defaults del dueño, 7-nov): «¿algo más?» UNA vez por pedido, justo antes del resumen (en el mismo mensaje); promociones con UNA sola fuente (las políticas v2).
describe("«¿algo más?» una sola vez por pedido y promociones de una sola fuente (cerebro v2)", () => {
  const base = () => buildSystemPrompt(PM_CONFIG_POR_OMISION, [], { isNew: true }, new Date());
  it("la regla v2 de cierre ya no prohíbe el «¿algo más?» del resumen: lo limita a una vez por pedido", () => {
    expect(PM_POLICY_RULES_V2).not.toContain("no pregunte «¿desea agregar algo más?»");
    expect(PM_POLICY_RULES_V2).toMatch(/«¿algo más\?» UNA sola vez por pedido/);
  });
  it("el prompt v2 no vuelve a pedir «¿algo más?» al cerrar un cambio de un pedido ya creado", () => {
    expect(base()).toContain('al terminar pregunte "¿algo más?" antes de cerrar');
    expect(adaptarPromptPmV2(base())).not.toContain('al terminar pregunte "¿algo más?" antes de cerrar');
  });
  it("promociones: sin la orden de ofrecerlas (v2 manda no ofrecerlas por iniciativa propia) y sin la lista repetida", () => {
    const v2 = adaptarPromptPmV2(base());
    expect(v2).not.toContain("ofrézcalas UNA sola vez");
    expect(v2.split(PM_PROMOS_POR_OMISION).length - 1).toBe(1);
  });
  it("quitarAlgoMasRepetido: si ya se preguntó en este pedido, el servidor quita la segunda pregunta", () => {
    const hist = [
      { role: "user" as const, content: "dos cocas" },
      { role: "assistant" as const, content: "Resumen... Total $90. ¿Es correcto o desea agregar algo más?" },
      { role: "user" as const, content: "con tarjeta" },
    ];
    expect(quitarAlgoMasRepetido("Perfecto, con tarjeta. ¿Desea agregar algo más?", hist)).toBe("Perfecto, con tarjeta.");
    expect(quitarAlgoMasRepetido("Perfecto. ¿Desea agregar algo más?", hist.slice(0, 1))).toBe("Perfecto. ¿Desea agregar algo más?");
    // Un resumen repetido conserva su pregunta de confirmación (sin la coletilla de «algo más»).
    expect(quitarAlgoMasRepetido("Resumen... Total $95.\n\n¿Es correcto o desea agregar algo más?", hist)).toBe("Resumen... Total $95.\n\n¿Es correcto?");
    const trasCrear = [...hist, { role: "assistant" as const, content: "Su pedido ya quedó registrado." }, { role: "user" as const, content: "quiero otro pedido" }];
    expect(quitarAlgoMasRepetido("Claro. ¿Algo más?", trasCrear)).toBe("Claro. ¿Algo más?");
  });
});
