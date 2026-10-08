// Revision independiente de #508: los 3 bloqueantes (minutos_para_recoger re-cotizado, ya_registrado falso, cambio de producto ignorado) como pruebas permanentes.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool, executeAgentToolSafely } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import type { Order } from "../src/types.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const MARTES_13 = new Date("2026-10-06T13:00:00-06:00");
beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_13);
});
afterEach(() => vi.useRealTimers());

function setup(channel: "whatsapp" | "voz" = "whatsapp") {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let turn = 1;
  const ctx = () => ({ organizationId: f.organizationId, channel, phone: "9991234567", flow: { key: `k:${channel}`, turn: String(turn), now: () => Date.now() } });
  const tacos = (extra: Record<string, unknown> = {}) => ({ product_id: f.products.tacosPastor, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: "maiz", ...extra });
  const coca = (extra: Record<string, unknown> = {}) => ({ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2, ...extra });
  const base = { branch_slug: "fco-montejo", canal: "recoger" };
  const quote = (items: unknown[], extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, items, ...extra });
  const confirm = () => invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {});
  const create = (items: unknown[], extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, items, customer_name: "Nora", payment_method: "efectivo", ...extra });
  const safe = (name: string, input: Record<string, unknown>) => executeAgentToolSafely(f.repo, ctx(), name, { ...base, ...input });
  const orders = () => (f.repo as unknown as { orders: Order[] }).orders;
  return { f, quote, confirm, create, safe, orders, nextTurn: () => void (turn += 1), tacos, coca };
}

describe("B1: minutos_para_recoger no revive el bucle de cierre", () => {
  it("re-cotizar el MISMO carrito con el mismo plazo 90 s despues conserva la cotizacion y confirmar_resumen pasa en ese turno", async () => {
    const s = setup();
    const q1 = await s.quote([s.tacos(), s.coca()], { minutos_para_recoger: 40 });
    vi.setSystemTime(new Date(MARTES_13.getTime() + 90_000));
    s.nextTurn();
    const q2 = await s.quote([s.tacos(), s.coca()], { minutos_para_recoger: 40 });
    expect(q2.result).toMatchObject({ ya_mostrada_al_cliente: true });
    expect((q2.result as { quote_hash: string }).quote_hash).toBe((q1.result as { quote_hash: string }).quote_hash);
    await s.confirm();
    const c = await s.create([s.tacos(), s.coca()], { minutos_para_recoger: 40 });
    expect(c.orderId).toBeTruthy();
    const o = await s.f.repo.findOrderById(s.f.organizationId, c.orderId!);
    // la hora del pedido es la COTIZADA (13:40), no la de 90 s despues
    expect(Date.parse(o!.horaRecogida!)).toBe(MARTES_13.getTime() + 40 * 60_000);
  });

  it("si el carrito cambia, la re-cotizacion es nueva y toma la hora del momento (no arrastra una hora vieja)", async () => {
    const s = setup();
    await s.quote([s.tacos(), s.coca()], { minutos_para_recoger: 40 });
    vi.setSystemTime(new Date(MARTES_13.getTime() + 5 * 60_000));
    s.nextTurn();
    const q2 = await s.quote([s.tacos(), s.coca({ requested_quantity: 3 })], { minutos_para_recoger: 40 });
    expect(q2.result).not.toMatchObject({ ya_mostrada_al_cliente: true });
    s.nextTurn();
    await s.confirm();
    const c = await s.create([s.tacos(), s.coca({ requested_quantity: 3 })], { minutos_para_recoger: 40 });
    const o = await s.f.repo.findOrderById(s.f.organizationId, c.orderId!);
    expect(Date.parse(o!.horaRecogida!)).toBe(MARTES_13.getTime() + 45 * 60_000);
  });

  it("otro plazo en la re-cotizacion (40 -> 60) es una cotizacion nueva", async () => {
    const s = setup();
    await s.quote([s.tacos(), s.coca()], { minutos_para_recoger: 40 });
    s.nextTurn();
    const q2 = await s.quote([s.tacos(), s.coca()], { minutos_para_recoger: 60 });
    expect(q2.result).not.toMatchObject({ ya_mostrada_al_cliente: true });
  });

  it("el cliente cambia el plazo («mejor en 60») y el modelo crea SIN re-cotizar: se exige re-cotizar, no sale con la hora vieja", async () => {
    const s = setup();
    await s.quote([s.tacos(), s.coca()], { minutos_para_recoger: 40 });
    s.nextTurn();
    await s.confirm();
    const out = await s.safe("crear_pedido", { items: [s.tacos(), s.coca()], customer_name: "Nora", payment_method: "efectivo", minutos_para_recoger: 60 });
    expect(out.orderId).toBeNull();
    expect(s.orders()).toHaveLength(0);
    expect(JSON.stringify(out.result)).toMatch(/cotiz/i);
  });

  it("control: hora_recogida explicita sigue conservando la cotizacion", async () => {
    const s = setup();
    await s.quote([s.tacos(), s.coca()], { hora_recogida: "2026-10-06T13:40:00-06:00" });
    vi.setSystemTime(new Date(MARTES_13.getTime() + 90_000));
    s.nextTurn();
    expect((await s.quote([s.tacos(), s.coca()], { hora_recogida: "2026-10-06T13:40:00-06:00" })).result).toMatchObject({ ya_mostrada_al_cliente: true });
  });
});

describe("B2: ya_registrado solo de un pedido que existe y esta activo", () => {
  async function conPedido() {
    const s = setup();
    await s.quote([s.tacos(), s.coca()]);
    s.nextTurn();
    await s.confirm();
    const p1 = await s.create([s.tacos(), s.coca()]);
    s.nextTurn();
    return { s, p1 };
  }
  it("pedido activo: re-cotizar el mismo carrito devuelve ya_registrado con el id (comportamiento de R3 intacto)", async () => {
    const { s, p1 } = await conPedido();
    const r = (await s.quote([s.tacos(), s.coca()])).result as Record<string, unknown>;
    expect(r.ya_registrado).toBe(true);
    expect(r.pedido_id).toBe(p1.orderId);
  });
  it("otro_pedido:true abre una cotizacion nueva", async () => {
    const { s } = await conPedido();
    expect((await s.quote([s.tacos(), s.coca()], { otro_pedido: true })).result).not.toMatchObject({ ya_registrado: true });
  });
  it.each(["cancelado", "no_recogido"] as const)("pedido %s en la base: NO es ya_registrado (cotizacion normal)", async (status) => {
    const { s, p1 } = await conPedido();
    const os = s.orders();
    const i = os.findIndex((o) => o.id === p1.orderId);
    os[i] = { ...os[i]!, status } as Order;
    const r = (await s.quote([s.tacos(), s.coca()])).result as Record<string, unknown>;
    expect(r.ya_registrado).toBeUndefined();
    expect(r.quote_hash).toBeTruthy();
  });
  it("pedido grande RETENIDO (estado creado SIN orderId): no dice ya_registrado, dice pendiente de la sucursal", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
    void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
    let turn = 1;
    const ctx = () => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567", flow: { key: "k:big", turn: String(turn), now: () => Date.now() } });
    const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
    await invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items });
    const snap = (await f.repo.readOrderFlow(f.organizationId, "k:big"))!;
    // lo que deja la retencion de un pedido grande: estado creado sin orderId
    await f.repo.writeOrderFlow(f.organizationId, "k:big", snap.version, { state: "creado", context: { ...snap.context!, claimedAtMs: Date.now() } }, 3600);
    turn += 1;
    const r = (await invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items })).result as Record<string, unknown>;
    expect(r.ya_registrado).toBeUndefined();
    expect(r.pedido_retenido).toBe(true);
    expect(String(r.aviso)).toMatch(/pendiente de que la sucursal lo confirme/);
    expect(String(r.aviso)).not.toMatch(/YA QUEDÓ REGISTRADO/);
  });
});

describe("B3: cambiar de producto entre cotizar y crear obliga a re-cotizar", () => {
  async function cotizadoConfirmado(items: (s: ReturnType<typeof setup>) => unknown[]) {
    const s = setup();
    await s.quote(items(s));
    s.nextTurn();
    await s.confirm();
    return s;
  }
  it("cotizados Tacos, crear con Quesobich (id real de otro producto): rechazado, no se crea Tacos", async () => {
    const s = await cotizadoConfirmado((x) => [x.tacos()]);
    const out = await s.safe("crear_pedido", { items: [{ product_id: s.f.products.quesobich, product_name: "Quesobich", requested_quantity: 3, tortilla: "maiz" }], customer_name: "Nora", payment_method: "efectivo" });
    expect(out.orderId).toBeNull();
    expect(s.orders()).toHaveLength(0);
    expect(JSON.stringify(out.result)).toMatch(/pedido_distinto_al_cotizado|cotiz/i);
  });
  it("cotizada Coca, crear con Sol (id real de una cerveza): rechazado", async () => {
    const s = await cotizadoConfirmado((x) => [x.tacos(), x.coca()]);
    const out = await s.safe("crear_pedido", { items: [s.tacos(), { product_id: s.f.products.cervezaSol, product_name: "Sol", requested_quantity: 2 }], customer_name: "Nora", payment_method: "efectivo" });
    expect(out.orderId).toBeNull();
    expect(s.orders()).toHaveLength(0);
  });
  it("product_id vacio o inexistente con el nombre de lo cotizado SIGUE funcionando (se concilia con lo cotizado)", async () => {
    for (const productId of ["", randomUUID()]) {
      const s = await cotizadoConfirmado((x) => [x.tacos(), x.coca()]);
      const c = await s.create([s.tacos({ product_id: productId }), s.coca({ product_id: productId })]);
      expect(c.orderId).toBeTruthy();
      const o = await s.f.repo.findOrderById(s.f.organizationId, c.orderId!);
      expect(o!.items.map((i) => `${i.name}`).join("|")).toMatch(/Tacos/);
      expect(o!.items.map((i) => `${i.name}`).join("|")).toMatch(/Coca/);
      expect(o!.items).toHaveLength(2);
    }
  });
  it("renglon extra o renglon omitido: rechazado", async () => {
    const s = await cotizadoConfirmado((x) => [x.tacos(), x.coca()]);
    for (const items of [[s.tacos(), s.coca(), { product_id: s.f.products.quesobich, product_name: "Quesobich", requested_quantity: 1 }], [s.tacos()]]) {
      const out = await s.safe("crear_pedido", { items, customer_name: "Nora", payment_method: "efectivo" });
      expect(out.orderId).toBeNull();
    }
  });
});
