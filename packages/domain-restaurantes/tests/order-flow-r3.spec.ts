// QA-PM-R3 (WhatsApp y voz): el cierre del pedido no depende de que el modelo repita igual los campos que no cambian el carrito.
//   whatsapp-01 (P1): la tortilla de una bebida cambia entre turnos ("mixta" -> "maiz") -> la re-cotizacion del turno del "si" era "nueva" y confirmar rechazaba
//                     "el cliente todavia no contesto al resumen" (26/40 cierres).
//   whatsapp-07 (P2): crear_pedido con product_id vacio ("pedido no coincide") -> reintento completo y subida al rol caro.
//   whatsapp-02/03 (P1/P0): un "si" de mas despues de crear reabria la confirmacion; con otra hora de recogida nacia un SEGUNDO pedido.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { OrderFlowViolationError, reconciliarConCotizacion, resetOrderFlowWarningForTests, resolverRenglonesCotizados } from "../src/agent-tools/order-flow.ts";
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
  return { f, quote, confirm, create, nextTurn: () => void (turn += 1), tacos, coca };
}

describe.each(["whatsapp", "voz"] as const)("%s: campos que no cambian el carrito no vuelven 'nueva' la cotizacion (QA-PM-R3-whatsapp-01)", (channel) => {
  it("la tortilla de la bebida cambia entre turnos: la re-cotizacion del turno del si conserva la cotizacion y se confirma y crea", async () => {
    const s = setup(channel);
    await s.quote([s.tacos(), s.coca({ tortilla: "mixta" })]);
    s.nextTurn();
    await s.quote([s.tacos(), s.coca({ tortilla: "maiz" })]); // "no es todo"
    s.nextTurn();
    const requote = await s.quote([s.tacos(), s.coca()]); // turno del "si": sin tortilla en la bebida
    expect(requote.result).toMatchObject({ ya_mostrada_al_cliente: true });
    await s.confirm(); // antes: "El cliente todavia no contesto al resumen"
    const creado = await s.create([s.tacos(), s.coca({ tortilla: "harina" })]);
    expect(creado.orderId).not.toBeNull();
  });

  it("product_id vacio al crear (solo el nombre): se resuelve contra la cotizacion vigente en vez de 'el pedido no coincide'", async () => {
    const s = setup(channel);
    await s.quote([s.tacos(), s.coca()]);
    s.nextTurn();
    await s.confirm();
    const creado = await s.create([s.tacos({ product_id: "", product_name: "tacos de bistec" }), s.coca({ product_id: "", product_name: "coca cola" })]);
    expect(creado.orderId).not.toBeNull();
  });

  it("un carrito DISTINTO sigue rechazado: otra cantidad, o otra tortilla en un producto que la lleva", async () => {
    const s = setup(channel);
    await s.quote([s.tacos(), s.coca()]);
    s.nextTurn();
    await s.confirm();
    await expect(s.create([s.tacos({ requested_quantity: 6 }), s.coca()])).rejects.toMatchObject({ code: "pedido_distinto_al_cotizado" });
    await expect(s.create([s.tacos({ tortilla: "harina" }), s.coca()])).rejects.toMatchObject({ code: "pedido_distinto_al_cotizado" });
    const ok = await s.create([s.tacos(), s.coca()]);
    expect(ok.orderId).not.toBeNull();
  });

  it("cambiar de verdad el carrito en el turno del si sigue siendo una cotizacion nueva (confirmar en ese turno se rechaza)", async () => {
    const s = setup(channel);
    await s.quote([s.tacos(), s.coca()]);
    s.nextTurn();
    await s.quote([s.tacos(), s.coca({ requested_quantity: 3 })]);
    await expect(s.confirm()).rejects.toMatchObject({ code: "confirmacion_mismo_turno" });
  });
});

describe.each(["whatsapp", "voz"] as const)("%s: un si de mas despues de crear no abre otro pedido (QA-PM-R3-whatsapp-02 / 03)", (channel) => {
  async function conPedido() {
    const s = setup(channel);
    await s.quote([s.tacos(), s.coca()]);
    s.nextTurn();
    await s.confirm();
    const primero = await s.create([s.tacos(), s.coca()]);
    return { s, primero };
  }

  // WhatsApp: el reintento de crear se rechaza con "ya quedo registrado" (regla del servidor). Voz: devuelve el mismo pedido marcado ya_registrado (un timeout del worker no debe parecer falla).
  async function reintentarCrear(s: ReturnType<typeof setup>, orderId: string | null, extra: Record<string, unknown> = {}) {
    const intento = s.create([s.tacos(), s.coca()], extra);
    if (channel === "voz") await expect(intento).resolves.toMatchObject({ orderId, yaRegistrado: true });
    else await expect(intento).rejects.toMatchObject({ code: "pedido_ya_creado" });
  }

  it("cotizar el mismo carrito despues de crear devuelve ya_registrado con el id y NO pisa el estado creado", async () => {
    const { s, primero } = await conPedido();
    s.nextTurn();
    const otra = await s.quote([s.tacos(), s.coca()]);
    expect(otra.result).toMatchObject({ ya_registrado: true, pedido_id: primero.orderId });
    expect(otra.result).not.toHaveProperty("quote_hash");
    // el modelo insiste con confirmar/crear: reglas del servidor ("ya quedo registrado"), no una falla del sistema
    await expect(s.confirm()).rejects.toBeInstanceOf(OrderFlowViolationError);
    await reintentarCrear(s, primero.orderId);
  });

  it("aunque el modelo cambie la hora de recogida al re-cotizar, no nace un segundo pedido", async () => {
    const { s, primero } = await conPedido();
    s.nextTurn();
    const otra = await s.quote([s.tacos(), s.coca()], { hora_recogida: "2026-10-06T14:00:00-06:00" });
    expect(otra.result).toMatchObject({ ya_registrado: true, pedido_id: primero.orderId });
    await reintentarCrear(s, primero.orderId, { hora_recogida: "2026-10-06T14:00:00-06:00" });
  });

  it("un carrito distinto despues de crear es un pedido nuevo, y con otro_pedido: true el mismo carrito tambien", async () => {
    const { s, primero } = await conPedido();
    s.nextTurn();
    const distinto = await s.quote([s.tacos({ requested_quantity: 6 }), s.coca()]);
    expect(distinto.result).not.toHaveProperty("ya_registrado");
    expect(distinto.result).toHaveProperty("quote_hash");
    s.nextTurn();
    await s.quote([s.tacos(), s.coca()]); // vuelve al carrito original (ya no es el creado: el estado es "cotizado")
    const { s: s2, primero: p2 } = await conPedido();
    s2.nextTurn();
    const otro = await s2.quote([s2.tacos(), s2.coca()], { otro_pedido: true });
    expect(otro.result).not.toHaveProperty("ya_registrado");
    expect(otro.result).toHaveProperty("quote_hash");
    expect(p2.orderId).not.toBeNull();
    expect(primero.orderId).not.toBeNull();
  });

  it("pasada la ventana de 30 minutos el mismo carrito es un pedido nuevo", async () => {
    const { s } = await conPedido();
    vi.setSystemTime(new Date(MARTES_13.getTime() + 31 * 60_000));
    s.nextTurn();
    const otra = await s.quote([s.tacos(), s.coca()]);
    expect(otra.result).not.toHaveProperty("ya_registrado");
  });
});

describe("emparejar renglones (unidad)", () => {
  const lines = [
    { productId: "a", name: "Taco Al Pastor (individual)", tortilla: "maiz" },
    { productId: "b", name: "Horchata", tortilla: null },
  ];
  it("empareja por id, por nombre parecido y por el unico renglon que sobra", () => {
    const q = resolverRenglonesCotizados([{ productId: "a", requestedQuantity: 4 }, { productName: "horchata", requestedQuantity: 2 }], lines)!;
    expect(q.map((x) => [x.id, x.qty, x.tortilla])).toEqual([["a", 4, "maiz"], ["b", 2, null]]);
    const r = reconciliarConCotizacion([{ productId: "", productName: "tacos de pastor", requestedQuantity: 4 }, { productName: "xyz", requestedQuantity: 2 }], q);
    expect(r!.map((x) => [x.productId, x.tortilla])).toEqual([["a", "maiz"], ["b", undefined]]);
  });
  it("sin emparejar sin ambiguedad devuelve null / los renglones tal cual", () => {
    expect(resolverRenglonesCotizados([{ productName: "pizza", requestedQuantity: 1 }, { productName: "sushi", requestedQuantity: 1 }], lines)).toBeNull();
    const items = [{ productName: "pizza", requestedQuantity: 1 }, { productName: "sushi", requestedQuantity: 1 }];
    expect(reconciliarConCotizacion(items, [{ id: "a", name: "Taco Al Pastor", qty: 1, tortilla: "maiz" }, { id: "b", name: "Horchata", qty: 1, tortilla: null }])).toBeNull();
  });
});
