// QA-PM-R5-reglas-02 (P1): en RECOGER `programado_para` y `hora_recogida` son la misma hora. El modelo cotiza con una y crea con la otra (o con las dos y despues con una,
// o con ninguna + minutos) y crear_pedido fallaba con "no coincide con el que se cotizo" -> "problema tecnico". Reloj fijo: martes 13:00 Merida.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
});
afterEach(() => vi.useRealTimers());

const X = "2026-10-06T15:00:00-06:00";
const OTRA = "2026-10-06T16:00:00-06:00";

function setup(channel: "whatsapp" | "voz") {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let turn = 1;
  const ctx = () => ({ organizationId: f.organizationId, channel, phone: "9991234567", flow: { key: `k:${channel}`, turn: String(turn), now: () => Date.now() } });
  const base = { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] };
  const quote = (extra: Record<string, unknown>) => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, ...extra });
  const confirm = async () => {
    turn += 1;
    return invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {});
  };
  const create = (extra: Record<string, unknown>) => invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, customer_name: "Nora", payment_method: "efectivo", ...extra });
  return { quote, confirm, create };
}

describe.each(["whatsapp", "voz"] as const)("%s: programado_para y hora_recogida en recoger son la misma hora", (channel) => {
  it.each([
    ["K-V10: cotiza con programado_para, crea con hora_recogida", { programado_para: X }, { hora_recogida: X }],
    ["K-V9: cotiza con programado + hora, crea solo con hora", { programado_para: X, hora_recogida: X }, { hora_recogida: X }],
    ["cotiza con programado + hora, crea solo con programado", { programado_para: X, hora_recogida: X }, { programado_para: X }],
    ["cotiza con hora, crea con programado", { hora_recogida: X }, { programado_para: X }],
    ["cotiza con programado, crea sin hora", { programado_para: X }, {}],
    ["K-V7: cotiza con las dos, crea sin hora y con minutos", { programado_para: X, hora_recogida: X }, { minutos_para_recoger: 120 }],
  ])("%s -> crea el pedido", async (_n, cotizar, crear) => {
    const s = setup(channel);
    await s.quote(cotizar);
    await s.confirm();
    const r = await s.create(crear);
    expect(r.orderId).not.toBeNull();
  });

  it("cotizar con programado y crear con hora_recogida deja el pedido programado a la hora cotizada", async () => {
    const s = setup(channel);
    await s.quote({ programado_para: X });
    await s.confirm();
    const r = await s.create({ hora_recogida: X });
    expect((r.raw as { status: string; programadoPara?: string | null }).programadoPara).toBe("2026-10-06T21:00:00.000Z");
  });

  // Negativos: una hora DISTINTA a la cotizada sigue obligando a re-cotizar, y el mensaje menciona la hora.
  it.each([
    ["crea con otra hora_recogida", { hora_recogida: OTRA }],
    ["crea con otro programado_para", { programado_para: OTRA }],
  ])("negativo: %s -> pedido_distinto_al_cotizado", async (_n, crear) => {
    const s = setup(channel);
    await s.quote({ programado_para: X });
    await s.confirm();
    await expect(s.create(crear)).rejects.toMatchObject({ code: "pedido_distinto_al_cotizado", message: expect.stringMatching(/hora de recogida/) });
  });
});

describe.each(["whatsapp", "voz"] as const)("%s: programado_para y hora_recogida contradictorias en recoger se rechazan (no guardan dos horas)", (channel) => {
  it.each([
    ["cotizar con dos horas distintas", "cotizar_pedido"],
    ["crear con dos horas distintas", "crear_pedido"],
  ])("%s", async (_n, herramienta) => {
    const s = setup(channel);
    const llamar = herramienta === "cotizar_pedido" ? s.quote : s.create;
    await expect(llamar({ programado_para: X, hora_recogida: OTRA })).rejects.toThrow(/DISTINTAS/);
  });
  it("crear con dos horas distintas tras una cotizacion valida tampoco crea el pedido", async () => {
    const s = setup(channel);
    await s.quote({ programado_para: X });
    await s.confirm();
    await expect(s.create({ programado_para: X, hora_recogida: OTRA })).rejects.toThrow(/DISTINTAS/);
  });
  it("negativo: la misma hora en las dos (aunque con otro offset) o un solo campo siguen creando", async () => {
    const s = setup(channel);
    await s.quote({ programado_para: X, hora_recogida: "2026-10-06T21:00:00Z" });
    await s.confirm();
    expect((await s.create({ programado_para: X, hora_recogida: X })).orderId).not.toBeNull();
  });
});
