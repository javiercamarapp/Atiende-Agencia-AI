// QA-PM-R5-voz-01 (tres cuartos de kilo cotizados como kilo), reglas-05 (kilo y cuarto), reglas-03 (la tortilla elegida para un kilo no llega a cocina).
// Mundo PM real en memoria (catalogo de Los Taquitos de PM, sucursal T7 = garcia-lavin). Reloj fijo: miercoles 12:00.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:30:00-06:00"));
});
afterEach(() => vi.useRealTimers());

async function mundo(channel: "whatsapp" | "voz") {
  const w = await buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
  let turn = 1;
  const ctx = () => ({ organizationId: w.organizationId, channel, phone: "9991234567", flow: { key: `k:${channel}`, turn: String(turn), now: () => Date.now() } });
  const llamar = (tool: string, input: Record<string, unknown>) => invokeAgentTool(w.repo, ctx(), tool, { branch_slug: "garcia-lavin", ...input });
  return { llamar, siguienteTurno: () => void (turn += 1) };
}

describe.each(["whatsapp", "voz"] as const)("%s: buscar_producto por peso", (channel) => {
  it("'arrachera kilo' devuelve el kilo CON las presentaciones reales y la regla de fracciones (antes el modelo cotizaba 1 kg por 3/4)", async () => {
    const m = await mundo(channel);
    const r = (await m.llamar("buscar_producto", { query: "arrachera kilo" })).result as Array<{ name: string; presentaciones_por_peso?: string[]; aviso_peso?: string }>;
    expect(r.map((p) => p.name)).toEqual(["Arrachera — 1 kg"]);
    expect(r[0]!.presentaciones_por_peso).toContain("Arrachera — 750 g ($1050)");
    expect(r[0]!.presentaciones_por_peso).toContain("Arrachera — 250 g ($350)");
    expect(r[0]!.aviso_peso).toMatch(/tres cuartos = 750 g/);
  });
  it("'tres cuartos de kilo de arrachera' ya devuelve la de 750 g", async () => {
    const m = await mundo(channel);
    const r = (await m.llamar("buscar_producto", { query: "tres cuartos de kilo de arrachera" })).result as Array<{ name: string; price: number }>;
    expect(r.map((p) => [p.name, p.price])).toEqual([["Arrachera — 750 g", 1050]]);
  });
  it("'kilo y cuarto de pastor' lista las presentaciones reales (incluye 1 kg) para armar 1 kg + 250 g", async () => {
    const m = await mundo(channel);
    const r = (await m.llamar("buscar_producto", { query: "kilo y cuarto de pastor" })).result as Array<{ name: string; presentaciones_por_peso?: string[] }>;
    expect(r.map((p) => p.name)).toContain("Pastor — 1 kg");
    expect(r.every((p) => (p.presentaciones_por_peso ?? []).length >= 4)).toBe(true);
  });
  it("negativo: un platillo sin peso (tacos, bebida) no lleva presentaciones_por_peso", async () => {
    const m = await mundo(channel);
    const r = (await m.llamar("buscar_producto", { query: "tacos de pastor" })).result as Array<Record<string, unknown>>;
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((p) => "presentaciones_por_peso" in p)).toBe(false);
  });
});

describe.each(["whatsapp", "voz"] as const)("%s: la tortilla elegida para un kilo llega a la comanda (reglas-03)", (channel) => {
  async function pedirKilo(m: Awaited<ReturnType<typeof mundo>>, tortillaAlCotizar: string | undefined, tortillaAlCrear: string | undefined) {
    const buscar = (await m.llamar("buscar_producto", { query: "pastor kilo" })).result as Array<{ id: string; name: string }>;
    const kilo = buscar.find((p) => p.name === "Pastor — 1 kg")!;
    const item = (t?: string) => ({ product_id: kilo.id, product_name: kilo.name, requested_quantity: 1, ...(t ? { tortilla: t } : {}) });
    await m.llamar("cotizar_pedido", { canal: "recoger", items: [item(tortillaAlCotizar)] });
    m.siguienteTurno();
    await m.llamar("confirmar_resumen", {});
    m.siguienteTurno();
    return m.llamar("crear_pedido", { canal: "recoger", items: [item(tortillaAlCrear)], customer_name: "Nora", payment_method: "efectivo" });
  }
  it.each([
    ["la manda al cotizar y al crear", "harina", "harina"],
    ["la manda solo al cotizar", "harina", undefined],
    ["la manda solo al crear", undefined, "maiz"],
  ])("%s -> la nota de cocina lleva la tortilla", async (_n, alCotizar, alCrear) => {
    const m = await mundo(channel);
    const r = await pedirKilo(m, alCotizar, alCrear);
    const notas = (r.raw as { notes?: string }).notes ?? "";
    expect(notas).toMatch(new RegExp(`Tortilla \\(Pastor — 1 kg\\): ${alCrear ?? alCotizar}\\.`));
  });
  it("negativo: sin tortilla en ningun momento no se inventa una", async () => {
    const m = await mundo(channel);
    const r = await pedirKilo(m, undefined, undefined);
    expect((r.raw as { notes?: string }).notes ?? "").not.toMatch(/Tortilla \(/);
  });
});
