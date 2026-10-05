// QA-PM-R2 (WhatsApp y voz): el pedido CIERRA aunque el modelo vuelva a cotizar en el turno del "si" (whatsapp-01, P0); una hora programada vacia
// es "sin programar" (reglas-02); la hora de recogida la valida el SERVIDOR con su reloj (reglas-05, voz-03, whatsapp-15). Reloj: solo `Date`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { OrderFlowViolationError, resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { OrderValidationError } from "../src/errors.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

// Martes 2026-10-06 13:00 en Merida (UTC-6).
const MARTES_13 = new Date("2026-10-06T13:00:00-06:00");

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_13);
});
afterEach(() => vi.useRealTimers());

function setup(channel: "whatsapp" | "voz" = "whatsapp") {
  const f = buildRestaurantFixture();
  // Todos los dias 12:00 a 01:00 (como la cuenta real).
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let turn = 1;
  const ctx = () => ({ organizationId: f.organizationId, channel, phone: "9991234567", flow: { key: `k:${channel}`, turn: String(turn), now: () => Date.now() } });
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
  const base = { branch_slug: "fco-montejo", items, canal: "recoger" };
  const quote = (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, ...extra });
  const confirm = () => invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {});
  const create = (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, customer_name: "Nora", payment_method: "efectivo", ...extra });
  return { f, quote, confirm, create, nextTurn: () => void (turn += 1), items };
}

describe.each(["whatsapp", "voz"] as const)("%s: re-cotizar el MISMO carrito en el turno del si ya no impide cerrar (QA-PM-R2-whatsapp-01)", (channel) => {
  it("cotiza (turno 1) -> 'no, es todo' (turno 2, re-cotiza) -> 'si' (turno 3, re-cotiza) -> confirma y crea UN pedido", async () => {
    const s = setup(channel);
    await s.quote();
    s.nextTurn();
    await s.quote(); // el modelo repite la cotizacion al responder "no, es todo"
    s.nextTurn();
    const requote = await s.quote(); // y otra vez en el turno del si
    expect((requote.result as { quote_hash: string }).quote_hash).toMatch(/^[0-9a-f]{32}$/);
    await s.confirm(); // antes: confirmacion_mismo_turno
    const created = await s.create();
    expect(created.orderId).not.toBeNull();
  });

  it("si cambia el carrito al re-cotizar, es una cotizacion NUEVA y confirmar en ese mismo turno sigue rechazado", async () => {
    const s = setup(channel);
    await s.quote();
    s.nextTurn();
    const mas = [{ product_id: s.f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 3 }];
    await s.quote({ items: mas });
    await expect(s.confirm()).rejects.toMatchObject({ code: "confirmacion_mismo_turno" });
  });

  it("si cambia el precio del catalogo entre cotizaciones, el cliente debe volver a aceptar el total nuevo", async () => {
    const s = setup(channel);
    await s.quote();
    s.nextTurn();
    const fila = (s.f.repo as unknown as { branchProducts: { productId: string; price: number }[] }).branchProducts.find((b) => b.productId === s.f.products.cocaCola)!;
    fila.price = 50;
    await s.quote();
    await expect(s.confirm()).rejects.toBeInstanceOf(OrderFlowViolationError);
  });

  it("re-cotizar despues de confirmar el mismo carrito conserva la confirmacion (idempotente)", async () => {
    const s = setup(channel);
    await s.quote();
    s.nextTurn();
    await s.confirm();
    await s.quote();
    const created = await s.create();
    expect(created.orderId).not.toBeNull();
  });
});

describe("programado_para vacio es 'sin programar' (QA-PM-R2-reglas-02)", () => {
  it("cotizar y crear con programado_para '' y hora_recogida '' crean un pedido normal", async () => {
    const s = setup();
    const quoted = await s.quote({ programado_para: "", hora_recogida: "" });
    expect((quoted.raw as { programadoPara?: string }).programadoPara).toBeUndefined();
    s.nextTurn();
    await s.confirm();
    const created = await s.create({ programado_para: "", hora_recogida: "" });
    expect((created.raw as { status: string }).status).toBe("pending");
  });

  it("un programado a menos de 30 min dice que use hora_recogida (el modelo ya no se queda en bucle)", async () => {
    const s = setup();
    const en20 = new Date(MARTES_13.getTime() + 20 * 60_000).toISOString();
    await expect(s.quote({ programado_para: en20 })).rejects.toThrow(/hora_recogida/);
  });
});

describe("hora_recogida la valida el servidor con su reloj (QA-PM-R2-reglas-05 / voz-03 / whatsapp-15)", () => {
  it("'paso en 40 minutos' calculado con la hora LOCAL se acepta y se guarda", async () => {
    const s = setup();
    const hora = "2026-10-06T13:40:00-06:00";
    await s.quote({ hora_recogida: hora });
    s.nextTurn();
    await s.confirm();
    const created = await s.create({ hora_recogida: hora });
    expect((created.raw as { horaRecogida?: string }).horaRecogida).toBe(hora);
  });

  it("la hora UTC con -06:00 (6 h tarde: 19:40) cae el mismo dia y abierto: se acepta pero una pasada se rechaza con la hora local actual", async () => {
    const s = setup();
    await expect(s.quote({ hora_recogida: "2026-10-04T20:00:00-06:00" })).rejects.toThrow(/ya pasó.*13:00/s);
  });

  it("una hora pasada (dos dias atras, VRG07) se rechaza al crear aunque se salte la cotizacion de la hora", async () => {
    const s = setup();
    await s.quote();
    s.nextTurn();
    await s.confirm();
    await expect(s.create({ hora_recogida: "2026-10-04T20:00:00-06:00" })).rejects.toBeInstanceOf(OrderValidationError);
  });

  it("2030 y otro dia se rechazan", async () => {
    const s = setup();
    await expect(s.quote({ hora_recogida: "2030-01-01T14:00:00-06:00" })).rejects.toThrow(/12 horas/);
    await expect(s.quote({ hora_recogida: "2026-10-07T14:00:00-06:00" })).rejects.toThrow(/programado_para/);
  });

  it("despues del cierre se rechaza y avisa a que hora cierra (00:57, 'paso en 20 min')", async () => {
    vi.setSystemTime(new Date("2026-10-07T00:57:00-06:00"));
    const s = setup();
    await expect(s.quote({ hora_recogida: "2026-10-07T01:17:00-06:00" })).rejects.toThrow(/cierra a las 01:00/);
  });

  it("hora_recogida y programado_para distintos en el mismo pedido se rechazan (la comanda decia 14:00 y 20:00)", async () => {
    const s = setup();
    const prog = "2026-10-06T20:00:00-06:00";
    await s.quote({ programado_para: prog });
    s.nextTurn();
    await s.confirm();
    await expect(s.create({ programado_para: prog, hora_recogida: "2026-10-06T14:00:00-06:00" })).rejects.toThrow(/distintas/);
    // la misma hora en ambos campos si es coherente
    const ok = await s.create({ programado_para: prog, hora_recogida: prog });
    expect((ok.raw as { status: string }).status).toBe("programado");
  });

  it("hora_recogida en un pedido a domicilio se rechaza (solo aplica a recoger)", async () => {
    const s = setup();
    await expect(s.quote({ canal: "domicilio", hora_recogida: "2026-10-06T14:00:00-06:00" })).rejects.toThrow(/solo aplica a pedidos para recoger/);
  });
});
