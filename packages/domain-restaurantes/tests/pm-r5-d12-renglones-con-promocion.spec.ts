// QA-PM-R5-voz-06 / reglas-12 (D12): el pedido persistia los renglones a precio de lista y el `total` con el descuento ya restado, asi que la suma de renglones
// NO cuadraba con el total (VZ06: $448 contra $328 con las 2 aguas de cortesia; VR01: $168 contra $84 con el 2x1). Ahora las unidades que regala la promocion se
// guardan en un renglon aparte a $0 (mismo producto) y la suma de renglones es exactamente el total que cotizo el agente y que cobra la sucursal.
// Reloj fijo (solo Date, instantes absolutos) y zona America/Merida pasada como dato: no depende de la zona del proceso.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookupCustomer } from "../src/customers.ts";
import { repetirPedido } from "../src/cliente-360/repetir.ts";
import { createOrder, quoteOrder } from "../src/orders.ts";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { construirPayloadComanda } from "../src/softrestaurant/outbox-service.ts";
import { fusionarRenglonesPorProducto, renglonesConPromocionAplicada } from "../src/promotions.ts";
import type { Order, PersistedOrderItem, Promotion } from "../src/types.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const ZONA = "America/Merida";
// 2026-09-28 es lunes y 2026-09-29 martes; 14:00 en Merida (UTC-6) = 20:00Z.
const LUNES_14H = new Date("2026-09-28T20:00:00Z");
const MARTES_14H = new Date("2026-09-29T20:00:00Z");

const sumaRenglones = (o: Pick<Order, "items">) => Math.round(o.items.reduce((acc, i) => acc + i.price * i.quantity, 0) * 100) / 100;
const unidades = (o: Pick<Order, "items">, id: string) => o.items.filter((i) => i.id === id).reduce((acc, i) => acc + i.quantity, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

async function seed() {
  const f = buildRestaurantFixture();
  await f.repo.upsertBranchZonaHoraria(f.propertyId, ZONA);
  const mk = async (name: string, price: number, category = f.categories.tacos) => {
    const id = randomUUID();
    f.repo.seedProduct({ id, organizationId: f.organizationId, categoryId: category, name, description: null, searchKeywords: [] });
    f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: id, price, isAvailable: true });
    return id;
  };
  const pastor = await mk("Tacos al Pastor", 28);
  const nachos = await mk("Nachos de Pastor", 90);
  const jamaica = await mk("Agua de Jamaica", 30, f.categories.bebidas);
  const horchata = await mk("Agua de Horchata", 32, f.categories.bebidas);
  await f.repo.createPromotion(f.organizationId, { code: "LUNES2X1", name: "Lunes 2x1 en tacos al pastor", type: "bogo", value: 1, daysOfWeek: [1], channels: ["recoger"], productIds: [pastor], autoApply: true });
  await f.repo.createPromotion(f.organizationId, {
    code: "MARTESNACHOS",
    name: "Martes nachos de pastor con 2 aguas",
    type: "cortesia",
    value: 1,
    daysOfWeek: [2],
    channels: ["recoger"],
    productIds: [nachos],
    courtesyProductIds: [jamaica, horchata],
    courtesyQuantity: 2,
    autoApply: true,
  });
  return { ...f, ids: { pastor, nachos, jamaica, horchata } };
}
type Mundo = Awaited<ReturnType<typeof seed>>;
const crear = (f: Mundo, items: { productId: string; requestedQuantity: number; tortilla?: "maiz" | "harina" | "mixta" }[], extra: Record<string, unknown> = {}) =>
  createOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", customerName: "Ana", customerPhone: "9991234567", source: "voice", paymentMethod: "efectivo", canal: "recoger", items, ...extra });

describe("D12 (VZ06): martes, nachos + 2 aguas de cortesia -> la suma de renglones ES el total", () => {
  it("VZ06: total 90 = renglones 90 (nachos 90 + jamaica y horchata a $0); cotizar, crear y el correo dicen lo mismo", async () => {
    vi.setSystemTime(MARTES_14H);
    const f = await seed();
    const items = [
      { productId: f.ids.nachos, requestedQuantity: 1 },
      { productId: f.ids.jamaica, requestedQuantity: 1 },
      { productId: f.ids.horchata, requestedQuantity: 1 },
    ];
    const q = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", canal: "recoger", items });
    expect(q.total).toBe(90);
    const order = await crear(f, items);
    expect(order.total).toBe(q.total);
    expect(sumaRenglones(order)).toBe(order.total);
    expect(order.items.map((i) => [i.name, i.price, i.quantity])).toEqual([
      ["Nachos de Pastor", 90, 1],
      ["Agua de Jamaica", 0, 1],
      ["Agua de Horchata", 0, 1],
    ]);
  });

  it("3 aguas con una orden de nachos: 2 de cortesia y 1 cobrada; el renglon se parte en pagado y regalado (mismo producto)", async () => {
    vi.setSystemTime(MARTES_14H);
    const f = await seed();
    const order = await crear(f, [
      { productId: f.ids.nachos, requestedQuantity: 1 },
      { productId: f.ids.jamaica, requestedQuantity: 3 },
    ]);
    expect(order.total).toBe(120); // 90 + 1 agua cobrada
    expect(sumaRenglones(order)).toBe(120);
    expect(unidades(order, f.ids.jamaica)).toBe(3);
    expect(order.items.filter((i) => i.id === f.ids.jamaica).map((i) => [i.price, i.quantity]).sort()).toEqual([[0, 2], [30, 1]]);
  });

  it("2 ordenes de nachos + 4 aguas distintas: todas las aguas a $0 y la suma cuadra", async () => {
    vi.setSystemTime(MARTES_14H);
    const f = await seed();
    const order = await crear(f, [
      { productId: f.ids.nachos, requestedQuantity: 2 },
      { productId: f.ids.jamaica, requestedQuantity: 2 },
      { productId: f.ids.horchata, requestedQuantity: 2 },
    ]);
    expect(order.total).toBe(180);
    expect(sumaRenglones(order)).toBe(180);
  });

  it("negativo: a DOMICILIO no hay promocion y los renglones quedan a precio de lista (suma = total)", async () => {
    vi.setSystemTime(MARTES_14H);
    const f = await seed();
    const order = await crear(f, [{ productId: f.ids.nachos, requestedQuantity: 1 }, { productId: f.ids.jamaica, requestedQuantity: 2 }], { canal: "domicilio", customerAddress: "Calle 5 #1" });
    expect(order.total).toBe(150);
    expect(sumaRenglones(order)).toBe(150);
    expect(order.items.every((i) => i.price > 0)).toBe(true);
  });

  it("negativo: media orden/solo aguas (sin disparador) no regala nada", async () => {
    vi.setSystemTime(MARTES_14H);
    const f = await seed();
    const order = await crear(f, [{ productId: f.ids.jamaica, requestedQuantity: 2 }, { productId: f.ids.horchata, requestedQuantity: 1 }]);
    expect(order.total).toBe(92);
    expect(sumaRenglones(order)).toBe(92);
    expect(order.items.every((i) => i.price > 0)).toBe(true);
  });
});

describe("D12 (VR01): lunes 2x1 en pastor -> la suma de renglones ES el total", () => {
  it.each([
    [1, 28, [[28, 1]]],
    [2, 28, [[28, 1], [0, 1]]],
    [3, 56, [[28, 2], [0, 1]]],
    [4, 56, [[28, 2], [0, 2]]],
    [5, 84, [[28, 3], [0, 2]]],
  ] as const)("%i tacos de pastor: total %i y renglones %j", async (piezas, esperado, renglones) => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    const order = await crear(f, [{ productId: f.ids.pastor, requestedQuantity: piezas, tortilla: "mixta" }]);
    expect(order.total).toBe(esperado);
    expect(sumaRenglones(order)).toBe(esperado);
    expect(unidades(order, f.ids.pastor)).toBe(piezas);
    expect(order.items.map((i) => [i.price, i.quantity]).sort()).toEqual([...renglones].map(([p, q]) => [p, q]).sort());
  });

  it("carrito mixto del lunes: solo el pastor se reparte; la bebida se cobra y la suma cuadra", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    const order = await crear(f, [{ productId: f.ids.pastor, requestedQuantity: 2, tortilla: "harina" }, { productId: f.ids.jamaica, requestedQuantity: 1 }]);
    expect(order.total).toBe(58);
    expect(sumaRenglones(order)).toBe(58);
  });

  it("negativo: un codigo de porcentaje NO reparte por renglon (se queda como antes, el total lleva el descuento)", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    await f.repo.createPromotion(f.organizationId, { code: "DIEZ", name: "10%", type: "percentage", value: 10 });
    const order = await crear(f, [{ productId: f.ids.pastor, requestedQuantity: 4, tortilla: "maiz" }], { promoCode: "diez" });
    expect(order.total).toBe(100.8);
    expect(order.items.map((i) => [i.price, i.quantity])).toEqual([[28, 4]]);
  });
});

describe("renglonesConPromocionAplicada (puro)", () => {
  const item = (id: string, price: number, quantity: number): PersistedOrderItem => ({ id, name: id, price, quantity });
  const bogo = { type: "bogo", productIds: ["pastor"], courtesyProductIds: null, courtesyQuantity: null } as unknown as Promotion;
  const cortesia = { type: "cortesia", productIds: ["nachos"], courtesyProductIds: ["a", "b"], courtesyQuantity: 2 } as unknown as Promotion;

  it("sin promocion devuelve los mismos renglones", () => {
    const items = [item("pastor", 28, 4)];
    expect(renglonesConPromocionAplicada(items, null, 112)).toBe(items);
  });

  it("si la suma no cuadra con el total (descuento recortado, total ajeno) no toca nada", () => {
    const items = [item("pastor", 28, 4)];
    expect(renglonesConPromocionAplicada(items, bogo, 99)).toBe(items);
  });

  it("un porcentaje o monto fijo no reparte unidades", () => {
    const items = [item("pastor", 28, 4)];
    expect(renglonesConPromocionAplicada(items, { ...bogo, type: "percentage" } as Promotion, 100.8)).toBe(items);
    expect(renglonesConPromocionAplicada(items, { ...bogo, type: "fixed" } as Promotion, 100)).toBe(items);
  });

  it("cortesia: regala las MAS BARATAS y conserva el orden y los demas campos (tortilla)", () => {
    const items: PersistedOrderItem[] = [{ ...item("nachos", 90, 1), tortilla: "maiz" }, item("a", 40, 1), item("b", 30, 2)];
    const r = renglonesConPromocionAplicada(items, cortesia, 130);
    expect(r.map((i) => [i.id, i.price, i.quantity])).toEqual([["nachos", 90, 1], ["a", 40, 1], ["b", 0, 2]]);
    expect(r[0]?.tortilla).toBe("maiz");
  });
});

describe("fusionarRenglonesPorProducto: el renglon regalado y el pagado son UN producto para el historial", () => {
  it("suma cantidades por id, conserva el precio de lista (el mayor) y el orden", () => {
    const r = fusionarRenglonesPorProducto([
      { id: "pastor", name: "Tacos al Pastor", price: 28, quantity: 2 },
      { id: "jamaica", name: "Agua", price: 30, quantity: 1 },
      { id: "pastor", name: "Tacos al Pastor", price: 0, quantity: 2 },
    ]);
    expect(r).toEqual([
      { id: "pastor", name: "Tacos al Pastor", price: 28, quantity: 4 },
      { id: "jamaica", name: "Agua", price: 30, quantity: 1 },
    ]);
  });

  it("sin id agrupa por nombre; una lista sin repetidos queda igual", () => {
    expect(fusionarRenglonesPorProducto([{ name: "A", quantity: 1 }, { name: "A", quantity: 2 }, { name: "B", quantity: 1 }])).toEqual([{ name: "A", quantity: 3 }, { name: "B", quantity: 1 }]);
    const sola = [{ id: "x", name: "X", price: 5, quantity: 1 }];
    expect(fusionarRenglonesPorProducto(sola)).toEqual(sola);
  });

  it("memoria del cliente tras un 2x1: 'lo de siempre' dice 4 tacos (una linea), no 2 + 2", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    await crear(f, [{ productId: f.ids.pastor, requestedQuantity: 4, tortilla: "maiz" }]);
    const cliente = await lookupCustomer(f.repo, f.organizationId, "9991234567");
    if (cliente.isNew) throw new Error("el cliente debia existir");
    expect(cliente.lastOrderItems).toEqual([{ name: "Tacos al Pastor", quantity: 4 }]);
  });

  it("repetir el pedido: un solo renglon de 4 tacos y SIN falso aviso de cambio de precio por el renglon a $0", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    const order = await crear(f, [{ productId: f.ids.pastor, requestedQuantity: 4, tortilla: "maiz" }]);
    const r = await repetirPedido(f.repo, {
      organizationId: f.organizationId,
      branchSlug: "fco-montejo",
      order: { id: order.id, orderNumber: order.orderNumber ?? null, createdAt: order.createdAt, status: order.status, total: order.total, items: order.items, branch: order.branch, propertyId: order.propertyId, paymentMethod: "efectivo", canal: "recoger", propina: null, source: "voice" },
    });
    expect(r.renglones.map((x) => [x.productId, x.requestedQuantity])).toEqual([[f.ids.pastor, 4]]);
    expect(r.cambios).toEqual([]);
  });
});

describe("D12: la comanda sigue siendo UNA linea por producto y tortilla", () => {
  it("2x1 de 4 tacos (2 pagados + 2 a $0) viaja a la comanda como 4 tacos, no como 2 + 2; tortillas distintas no se mezclan", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    const order = await crear(f, [{ productId: f.ids.pastor, requestedQuantity: 4, tortilla: "maiz" }]);
    expect(order.items).toHaveLength(2);
    const base = { order, tipo: "recoger" as const };
    const deps = { resolverCodigos: { codigoDeProducto: () => "P1" }, resolverSucursal: () => "T7" as const };
    const comanda = construirPayloadComanda(base, deps as never);
    expect(comanda.items.map((i) => [i.nombre, i.cantidad])).toEqual([["Tacos al Pastor", 4]]);
    // Misma comanda con dos tortillas distintas del mismo producto: dos lineas.
    const mixtas = construirPayloadComanda({ ...base, order: { ...order, items: [{ id: "p", name: "Tacos", price: 28, quantity: 1, tortilla: "maiz" }, { id: "p", name: "Tacos", price: 28, quantity: 1, tortilla: "harina" }] } }, deps as never);
    expect(mixtas.items.map((i) => i.cantidad)).toEqual([1, 1]);
  });
});

// El CFO deriva bruta = suma(renglones a precio de lista) y descuento = bruta - total (supabase 081; migracion 086 lee `listPrice`). Estas pruebas del dominio fijan que los numeros
// que ve el CFO son los de ANTES de D12 aunque la suma de renglones pagados sea ahora el total (el verify SQL scripts/verify-restaurantes-cfo-renglones-promo lo prueba en Postgres).
describe("D12 + CFO: bruta y descuento por precio de lista iguales a los de antes", () => {
  const bruta = (o: Pick<Order, "items">) => Math.round(o.items.reduce((acc, i) => acc + (i.listPrice ?? i.price) * i.quantity, 0) * 100) / 100;

  it.each([
    ["lunes 2x1 de 4 tacos", LUNES_14H, (f: Mundo) => [{ productId: f.ids.pastor, requestedQuantity: 4, tortilla: "mixta" as const }], 112, 56],
    ["martes nachos + 2 aguas de cortesia", MARTES_14H, (f: Mundo) => [{ productId: f.ids.nachos, requestedQuantity: 1 }, { productId: f.ids.jamaica, requestedQuantity: 1 }, { productId: f.ids.horchata, requestedQuantity: 1 }], 152, 62],
    ["martes cortesia de cantidad 1", MARTES_14H, (f: Mundo) => [{ productId: f.ids.nachos, requestedQuantity: 1 }, { productId: f.ids.jamaica, requestedQuantity: 1 }], 120, 30],
    ["lunes mixto (3 tacos + bebida)", LUNES_14H, (f: Mundo) => [{ productId: f.ids.pastor, requestedQuantity: 3, tortilla: "maiz" as const }, { productId: f.ids.jamaica, requestedQuantity: 1 }], 114, 28],
  ])("%s: bruta %i, descuento %i, y total = suma de renglones", async (_n, cuando, items, esperadaBruta, esperadoDescuento) => {
    vi.setSystemTime(cuando);
    const f = await seed();
    const q = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", canal: "recoger", items: items(f) });
    const order = await crear(f, items(f));
    expect(bruta(order)).toBe(esperadaBruta);
    expect(bruta(order)).toBe(q.subtotal);
    expect(Math.round((bruta(order) - order.total) * 100) / 100).toBe(esperadoDescuento);
    expect(sumaRenglones(order)).toBe(order.total);
    // Los renglones regalados llevan la marca y su precio de lista; los pagados no.
    for (const i of order.items) expect(i.price === 0 ? i.listPrice !== undefined && i.courtesy === true : i.listPrice === undefined).toBe(true);
  });

  it("negativo: un pedido sin promocion no lleva listPrice (igual que antes)", async () => {
    vi.setSystemTime(MARTES_14H);
    const f = await seed();
    const order = await crear(f, [{ productId: f.ids.jamaica, requestedQuantity: 2 }]);
    expect(order.items.every((i) => i.listPrice === undefined && i.courtesy === undefined)).toBe(true);
  });
});

describe("D12: repetir el pedido y el historial con renglones regalados", () => {
  const cuando = () => vi.setSystemTime(MARTES_14H);
  const pedidoPasado = (order: Order) => ({ id: order.id, orderNumber: order.orderNumber ?? null, createdAt: order.createdAt, status: order.status, total: order.total, items: order.items, branch: order.branch, propertyId: order.propertyId, paymentMethod: "efectivo" as const, canal: "recoger" as const, propina: null, source: "voice" });

  it("un producto regalado al 100 % (Agua de Jamaica a $0) se repite SIN falso aviso de cambio de precio ($0 -> $30)", async () => {
    cuando();
    const f = await seed();
    const order = await crear(f, [{ productId: f.ids.nachos, requestedQuantity: 1 }, { productId: f.ids.jamaica, requestedQuantity: 1 }, { productId: f.ids.horchata, requestedQuantity: 1 }]);
    const r = await repetirPedido(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", order: pedidoPasado(order) });
    expect(r.cambios).toEqual([]);
    expect(r.renglones.map((x) => x.productId).sort()).toEqual([f.ids.nachos, f.ids.jamaica, f.ids.horchata].sort());
  });

  it("2 tacos de maiz + 2 de harina NO se funden en 4 de maiz: cada tortilla se repite como estaba", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    const order = await crear(f, [{ productId: f.ids.pastor, requestedQuantity: 2, tortilla: "maiz" }, { productId: f.ids.pastor, requestedQuantity: 2, tortilla: "harina" }]);
    const r = await repetirPedido(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", order: pedidoPasado(order) });
    const porTortilla = Object.fromEntries(r.renglones.map((x) => [x.tortilla ?? "", x.requestedQuantity]));
    expect(porTortilla).toEqual({ maiz: 2, harina: 2 });
  });

  it("fusionarRenglonesPorProducto: misma tortilla se une con precio de lista; tortillas distintas no", () => {
    expect(
      fusionarRenglonesPorProducto([
        { id: "p", name: "Taco", price: 28, quantity: 2, tortilla: "maiz" as const },
        { id: "p", name: "Taco", price: 0, quantity: 2, tortilla: "maiz" as const, listPrice: 28, courtesy: true as const },
        { id: "p", name: "Taco", price: 28, quantity: 1, tortilla: "harina" as const },
        { id: "a", name: "Agua", price: 0, quantity: 1, listPrice: 30, courtesy: true as const },
      ]),
    ).toEqual([
      { id: "p", name: "Taco", price: 28, quantity: 4, tortilla: "maiz" },
      { id: "p", name: "Taco", price: 28, quantity: 1, tortilla: "harina" },
      { id: "a", name: "Agua", price: 30, quantity: 1 },
    ]);
  });

  it("consultar_historial (herramienta del agente) lista UNA linea por producto y tortilla, sin renglones a $0 separados", async () => {
    vi.setSystemTime(LUNES_14H);
    const f = await seed();
    await crear(f, [{ productId: f.ids.pastor, requestedQuantity: 4, tortilla: "maiz" }]);
    const out = await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: "9991234567" }, "historial_pedidos", {});
    const pedidos = (out.result as { pedidos: { productos: { name: string; quantity: number }[] }[] }).pedidos;
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]!.productos).toEqual([{ name: "Tacos al Pastor", quantity: 4 }]);
  });
});
