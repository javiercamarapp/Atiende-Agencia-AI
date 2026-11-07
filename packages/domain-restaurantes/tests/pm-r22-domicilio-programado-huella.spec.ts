// R22 / T7-031: a DOMICILIO con hora programada («¿lo pueden traer a las 8:30 pm?») el modelo cotiza con una hora (programado_para u hora_recogida) y crea con la otra o con ninguna,
// y crear_pedido fallaba con pedido_distinto_al_cotizado («problema tecnico» tras el «sí, confirmo»). Reloj fijo: martes 13:00 Merida.
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

function setup() {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let turn = 1;
  const ctx = () => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567", flow: { key: "k:dom", turn: String(turn), now: () => Date.now() } });
  const base = { branch_slug: "fco-montejo", canal: "domicilio", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] };
  const quote = (extra: Record<string, unknown>) => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, ...extra });
  const confirm = async () => {
    turn += 1;
    return invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {});
  };
  const create = (extra: Record<string, unknown>) =>
    invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, customer_name: "Nora", payment_method: "efectivo", customer_address: "Calle 32 #345 x 20 y 22, Xaman Tan", ...extra });
  return { quote, confirm, create };
}

describe("domicilio programado: la hora cotizada es la misma al crear aunque cambie el campo", () => {
  it.each([
    ["cotiza con programado_para, crea con programado_para", { programado_para: X }, { programado_para: X }],
    ["cotiza con programado_para, crea sin hora", { programado_para: X }, {}],
  ])("%s -> crea el pedido", async (_n, cotizar, crear) => {
    const s = setup();
    await s.quote(cotizar);
    await s.confirm();
    const r = await s.create(crear);
    expect(r.orderId).not.toBeNull();
  });

  it.each([
    ["crea con otro programado_para", { programado_para: OTRA }],
  ])("negativo: %s -> pedido_distinto_al_cotizado", async (_n, crear) => {
    const s = setup();
    await s.quote({ programado_para: X });
    await s.confirm();
    await expect(s.create(crear)).rejects.toMatchObject({ code: "pedido_distinto_al_cotizado" });
  });
});
