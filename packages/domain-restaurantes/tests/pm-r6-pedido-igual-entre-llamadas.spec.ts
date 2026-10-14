// QA-PM-R6-voz-01: el cliente vuelve a llamar con el mismo numero y los mismos renglones: no nace un segundo pedido identico sin preguntar.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { mismosRenglones } from "../src/pedido-igual-reciente.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const MARTES_13 = new Date("2026-10-06T13:00:00-06:00");
beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_13);
});
afterEach(() => vi.useRealTimers());

function setup(phone = "9991234567") {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  const llamada = (id: string) => {
    const ctx = () => ({ organizationId: f.organizationId, channel: "voz" as const, phone, flow: { key: `call:${id}`, turn: "1", now: () => Date.now() } });
    const tacos = (q = 3) => ({ product_id: f.products.tacosPastor, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: q, tortilla: "maiz" });
    const base = { branch_slug: "fco-montejo", canal: "recoger" };
    return {
      quote: (items: unknown[], extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, items, ...extra }),
      confirm: () => invokeAgentTool(f.repo, { ...ctx(), flow: { ...ctx().flow, turn: "2" } }, "confirmar_resumen", {}),
      create: (items: unknown[]) => invokeAgentTool(f.repo, { ...ctx(), flow: { ...ctx().flow, turn: "2" } }, "crear_pedido", { ...base, items, customer_name: "Ana", payment_method: "efectivo" }),
      tacos,
    };
  };
  return { f, llamada };
}

describe("pedido igual en otra llamada", () => {
  it("la segunda llamada con los mismos renglones no cotiza: avisa que ya existe y pide preguntar", async () => {
    const { f, llamada } = setup();
    const l1 = llamada("a");
    await l1.quote([l1.tacos()]);
    await l1.confirm();
    expect((await l1.create([l1.tacos()])).orderId).not.toBeNull();
    vi.setSystemTime(new Date(MARTES_13.getTime() + 60_000));
    const l2 = llamada("b");
    await expect(l2.quote([l2.tacos()])).rejects.toThrow(/ya tiene un pedido IGUAL/);
    expect(f.repo).toBeTruthy();
  });
  it("otro_pedido: true (el cliente lo pidio) si cotiza", async () => {
    const { llamada } = setup();
    const l1 = llamada("a");
    await l1.quote([l1.tacos()]);
    await l1.confirm();
    await l1.create([l1.tacos()]);
    vi.setSystemTime(new Date(MARTES_13.getTime() + 60_000));
    const l2 = llamada("b");
    await expect(l2.quote([l2.tacos()], { otro_pedido: true })).resolves.toBeTruthy();
  });
  it("renglones distintos, otro telefono o pasada la ventana no se toman por el mismo pedido", async () => {
    const { llamada } = setup();
    const l1 = llamada("a");
    await l1.quote([l1.tacos()]);
    await l1.confirm();
    await l1.create([l1.tacos()]);
    vi.setSystemTime(new Date(MARTES_13.getTime() + 60_000));
    const l2 = llamada("b");
    await expect(l2.quote([l2.tacos(6)])).resolves.toBeTruthy();
    vi.setSystemTime(new Date(MARTES_13.getTime() + 11 * 60_000));
    const l3 = llamada("c");
    await expect(l3.quote([l3.tacos()])).resolves.toBeTruthy();
    const otro = setup("9998887766");
    const lx = otro.llamada("x");
    await expect(lx.quote([lx.tacos()])).resolves.toBeTruthy();
  });
});

describe("mismosRenglones (contrato)", () => {
  it.each([[0], [""], [null], [false], [[]], [{}], [undefined]])("entrada %j -> false sin lanzar", (v) => {
    expect(mismosRenglones(v, v)).toBe(false);
    expect(mismosRenglones([{ id: "a", quantity: 1 }], v)).toBe(false);
  });
  it("suma cantidades del mismo producto (renglon pagado + cortesia) y distingue cantidades", () => {
    expect(mismosRenglones([{ id: "a", quantity: 2 }, { id: "a", quantity: 2 }], [{ productId: "a", quantity: 4 }])).toBe(true);
    expect(mismosRenglones([{ id: "a", quantity: 2 }], [{ productId: "a", quantity: 3 }])).toBe(false);
    expect(mismosRenglones([{ id: "a", quantity: 1 }], [{ productId: "b", quantity: 1 }])).toBe(false);
  });
});
