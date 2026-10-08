// QA-PM-R3-voz-02 (P1) / reglas-01 (P1): "paso en media hora" / "en cuarenta minutos". El modelo calculaba mal la hora absoluta (otro dia, ya pasada): ahora manda el plazo en
// `minutos_para_recoger` y el SERVIDOR calcula `hora_recogida` con su reloj.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool, AGENT_TOOL_DEFINITIONS } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const MARTES_13 = new Date("2026-10-06T13:00:00-06:00");
beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_13);
});
afterEach(() => vi.useRealTimers());

function setup(channel: "whatsapp" | "voz") {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let turn = 1;
  const ctx = () => ({ organizationId: f.organizationId, channel, phone: "9991234567", flow: { key: `k:${channel}`, turn: String(turn), now: () => Date.now() } });
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
  const base = { branch_slug: "fco-montejo", items, canal: "recoger" };
  return {
    f,
    quote: (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, ...extra }),
    confirm: () => invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {}),
    create: (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, customer_name: "Nora", payment_method: "efectivo", ...extra }),
    nextTurn: () => void (turn += 1),
  };
}

describe.each(["whatsapp", "voz"] as const)("%s: minutos_para_recoger", (channel) => {
  it("cotiza y crea con el plazo: la hora de recogida queda a esos minutos del reloj del SERVIDOR", async () => {
    const s = setup(channel);
    await s.quote({ minutos_para_recoger: 40 });
    s.nextTurn();
    await s.confirm();
    vi.setSystemTime(new Date(MARTES_13.getTime() + 3 * 60_000)); // pasan 3 min entre cotizar y crear: se reutiliza la hora cotizada
    const creado = await s.create({ minutos_para_recoger: 40 });
    expect(creado.orderId).not.toBeNull();
    const pedido = await s.f.repo.findOrderById(s.f.organizationId, creado.orderId!);
    const minutos = (Date.parse(pedido!.horaRecogida!) - MARTES_13.getTime()) / 60_000;
    expect(minutos).toBeGreaterThanOrEqual(39);
    expect(minutos).toBeLessThanOrEqual(41);
  });

  it("'media hora' a las 13:02 ya no produce una hora pasada ni un bucle de errores", async () => {
    const s = setup(channel);
    vi.setSystemTime(new Date("2026-10-06T13:02:00-06:00"));
    const q = await s.quote({ minutos_para_recoger: 30 });
    expect(q.result).toHaveProperty("quote_hash");
  });

  it("una hora_recogida explicita manda sobre el plazo, y un plazo fuera de rango se ignora", async () => {
    const s = setup(channel);
    const q = await s.quote({ minutos_para_recoger: 40, hora_recogida: "2026-10-06T19:00:00-06:00" });
    expect(q.result).toHaveProperty("quote_hash");
    const lejos = await s.quote({ minutos_para_recoger: 99999 });
    expect(lejos.result).toHaveProperty("quote_hash"); // se ignora: es recogida inmediata
  });

  it("un plazo que cae despues del cierre se rechaza con el motivo (horario de la sucursal), no con otra hora adivinada", async () => {
    const s = setup(channel);
    vi.setSystemTime(new Date("2026-10-07T00:50:00-06:00")); // cierra a la 01:00
    await expect(s.quote({ minutos_para_recoger: 40 })).rejects.toThrow(/cierra|horario|abre/i);
  });

  it("un plazo corto (10 min) cotiza: la tolerancia de 'antes de 15 minutos' sigue siendo del prompt, no del servidor", async () => {
    const s = setup(channel);
    const q = await s.quote({ minutos_para_recoger: 10 });
    expect(q.result).toHaveProperty("quote_hash");
  });
});

describe("definicion de herramientas", () => {
  it("cotizar_pedido y crear_pedido anuncian minutos_para_recoger", () => {
    for (const nombre of ["cotizar_pedido", "crear_pedido"]) {
      const def = AGENT_TOOL_DEFINITIONS.find((t) => t.name === nombre)!;
      expect(Object.keys((def.parameters as { properties: object }).properties)).toContain("minutos_para_recoger");
    }
  });
});
