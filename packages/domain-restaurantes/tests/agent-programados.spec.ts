// R-11 en los agentes: crear_pedido de WhatsApp/voz acepta `programado_para` con las MISMAS reglas que el
// checkout publico (ventana, horario de la sucursal en la hora elegida, zona horaria) y el agente NO puede
// saltarse cotizar -> confirmar: la hora programada forma parte de la huella de lo confirmado.
// Reloj: solo `Date` congelado (nunca setInterval).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { OrderValidationError } from "../src/errors.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

// Viernes 2026-10-02 12:00 en Merida (UTC-6).
const AHORA = new Date("2026-10-02T12:00:00-06:00");
const SABADO_14 = "2026-10-03T14:00:00-06:00";

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AHORA);
});
afterEach(() => vi.useRealTimers());

function setup(channel: "whatsapp" | "voz" = "whatsapp") {
  const f = buildRestaurantFixture();
  // Viernes y sabado de 12:00 a 01:00 en la zona de la sucursal.
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let turn = 1;
  const ctx = () => ({ organizationId: f.organizationId, channel, phone: "9991234567", flow: { key: `k:${channel}`, turn: String(turn), now: () => Date.now() } });
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
  const base = { branch_slug: "fco-montejo", items, canal: "recoger" };
  const quote = (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, ...extra });
  const confirm = () => invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {});
  const create = (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, customer_name: "Ana", payment_method: "efectivo", ...extra });
  const nextTurn = () => void (turn += 1);
  return { f, quote, confirm, create, nextTurn };
}

describe.each(["whatsapp", "voz"] as const)("agente %s: pedido programado", (channel) => {
  it("cotizar -> confirmar -> crear con programado_para deja el pedido en `programado` con su hora", async () => {
    const s = setup(channel);
    const quoted = await s.quote({ programado_para: SABADO_14 });
    expect((quoted.result as { quote: { programado_para?: string } }).quote.programado_para).toBe("2026-10-03T20:00:00.000Z");
    s.nextTurn();
    await s.confirm();
    const created = await s.create({ programado_para: SABADO_14 });
    const order = created.raw as { status: string; programadoPara?: string | null };
    expect(order.status).toBe("programado");
    expect(order.programadoPara).toBe("2026-10-03T20:00:00.000Z");
  });

  it("el mismo instante con otro offset (UTC) pasa la huella: no obliga a re-cotizar", async () => {
    const s = setup(channel);
    await s.quote({ programado_para: SABADO_14 });
    s.nextTurn();
    await s.confirm();
    const created = await s.create({ programado_para: "2026-10-03T20:00:00Z" });
    expect((created.raw as { status: string }).status).toBe("programado");
  });

  it("el agente NO puede agregar una hora programada tras confirmar un pedido inmediato", async () => {
    const s = setup(channel);
    await s.quote();
    s.nextTurn();
    await s.confirm();
    await expect(s.create({ programado_para: SABADO_14 })).rejects.toMatchObject({ code: "pedido_distinto_al_cotizado" });
  });

  it("el agente NO puede cambiar la hora tras confirmar", async () => {
    const s = setup(channel);
    await s.quote({ programado_para: SABADO_14 });
    s.nextTurn();
    await s.confirm();
    await expect(s.create({ programado_para: "2026-10-03T15:00:00-06:00" })).rejects.toMatchObject({ code: "pedido_distinto_al_cotizado" });
  });

  it("sin confirmacion no hay pedido programado (crear tras cotizar, mismo turno o no)", async () => {
    const s = setup(channel);
    await s.quote({ programado_para: SABADO_14 });
    await expect(s.create({ programado_para: SABADO_14 })).rejects.toMatchObject({ code: "sin_confirmacion" });
  });

  it("cotizar rechaza una hora fuera del horario de la sucursal (domingo no abre)", async () => {
    const s = setup(channel);
    await expect(s.quote({ programado_para: "2026-10-04T14:00:00-06:00" })).rejects.toBeInstanceOf(OrderValidationError);
  });

  it("cotizar rechaza menos de 30 minutos, mas de 7 dias, y una hora sin zona", async () => {
    const s = setup(channel);
    await expect(s.quote({ programado_para: "2026-10-02T12:10:00-06:00" })).rejects.toThrow(/al menos 30 minutos/);
    await expect(s.quote({ programado_para: "2026-10-12T14:00:00-06:00" })).rejects.toThrow(/7 días/);
    await expect(s.quote({ programado_para: "2026-10-03T14:00:00" })).rejects.toThrow(/zona horaria/);
  });

  it("el horario se evalua en la zona de la sucursal: 00:30 del sabado es del turno del viernes", async () => {
    const s = setup(channel);
    const quoted = await s.quote({ programado_para: "2026-10-03T00:30:00-06:00" });
    expect((quoted.result as { quote: { programado_para?: string } }).quote.programado_para).toBe("2026-10-03T06:30:00.000Z");
  });

  it("contra una base sin la migracion 034 el agente recibe un mensaje de negocio, no un error interno ni un pedido inmediato", async () => {
    const s = setup(channel);
    s.f.repo.setScheduledOrdersSupported(false);
    await expect(s.quote({ programado_para: SABADO_14 })).rejects.toThrow(/programados todavía no están disponibles/);
    await expect(s.quote({ programado_para: SABADO_14 })).rejects.toBeInstanceOf(OrderValidationError);
    // Un pedido inmediato sigue funcionando exactamente igual.
    const normal = await s.quote();
    expect((normal.result as { quote: { programado_para?: string } }).quote.programado_para).toBeUndefined();
  });
});
