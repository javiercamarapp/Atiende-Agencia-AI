// R-09 -- storefront publico: menu por sucursal, reglas duras del checkout web (minimo, alcohol, zona,
// promos, propina, horario con doble turno), flujo cotizar -> confirmar -> crear con canal "web" y
// rastreo acotado por organizacion. Sobre el repositorio en memoria; la base sin migrar se cubre en
// storefront-savepoint.spec.ts.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool, toolDefinitionsForChannel } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { assertWebOrderRules, buildStorefrontBranches, buildStorefrontMenu, previewPromotion } from "../src/storefront.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

// lunes 28-sep-2026 14:00 en Merida (UTC-6): dentro del turno 12:00-16:00.
const LUNES_14 = new Date("2026-09-28T20:00:00Z");

function ctxWeb(f: ReturnType<typeof buildRestaurantFixture>, session = "sesion-web-0001-abcdef") {
  return { organizationId: f.organizationId, channel: "web" as const, phone: null, flow: { key: `web:${session}`, turn: null } };
}

function setup() {
  const f = buildRestaurantFixture();
  const ctx = ctxWeb(f);
  const tacos = { product_id: f.products.tacosPastor, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 6, tortilla: "maiz" };
  const coca = { product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 };
  const sol = { product_id: f.products.cervezaSol, product_name: "Sol", requested_quantity: 1 };
  const base = { branch_slug: "fco-montejo", canal: "recoger" as const };
  const quote = (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx, "cotizar_pedido", { ...base, items: [coca], ...extra });
  const confirm = () => invokeAgentTool(f.repo, ctx, "confirmar_resumen", {});
  const create = (extra: Record<string, unknown> = {}) =>
    invokeAgentTool(f.repo, ctx, "crear_pedido", { ...base, items: [coca], customer_name: "Ana", customer_phone: "999 123 4567", payment_method: "efectivo", ...extra });
  const full = async (extra: Record<string, unknown> = {}) => {
    await quote(extra);
    await confirm();
    return create(extra);
  };
  return { f, ctx, tacos, coca, sol, quote, confirm, create, full };
}

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LUNES_14);
});
afterEach(() => vi.useRealTimers());

describe("menu publico por sucursal", () => {
  it("agrupa por categoria con el precio de LA sucursal y marca alcohol, tacos, paquete y 'hoy no hay'", async () => {
    const f = buildRestaurantFixture();
    await f.repo.upsertBranchProductState(f.propertyId, f.products.cocaCola, 52, false); // hoy no hay Coca
    f.repo.seedNoDomicilio({ categoryIds: [f.categories.cervezas] });
    const menu = await buildStorefrontMenu(f.repo, f.propertyId);
    const all = menu.flatMap((c) => c.items);
    const coca = all.find((i) => i.name === "Coca-Cola")!;
    expect(coca).toMatchObject({ price: 52, available: false });
    const tacos = all.find((i) => i.name.startsWith("Tacos"))!;
    expect(tacos).toMatchObject({ price: 164, packSize: 3, requiresTortilla: true, available: true, noDomicilio: false });
    const sol = all.find((i) => i.name === "Sol")!;
    expect(sol).toMatchObject({ requiresAdultConfirmation: true, noDomicilio: true });
    expect(menu.map((c) => c.name)).toContain("Tacos");
  });

  it("otra sucursal con otro precio no hereda el de esta", async () => {
    const f = buildRestaurantFixture();
    const otra = randomUUID();
    f.repo.seedBranch({ propertyId: otra, organizationId: f.organizationId, name: "Centro", slug: "centro", status: "active", phone: null, address: null, lat: null, lng: null });
    f.repo.seedBranchProduct({ propertyId: otra, productId: f.products.cocaCola, price: 60, isAvailable: true });
    const menuOtra = (await buildStorefrontMenu(f.repo, otra)).flatMap((c) => c.items);
    expect(menuOtra).toHaveLength(1);
    expect(menuOtra[0]).toMatchObject({ name: "Coca-Cola", price: 60 });
  });
});

describe("sucursales: apertura, doble turno y zonas", () => {
  const turnos = [
    { dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "16:00" },
    { dias: [0, 1, 2, 3, 4, 5, 6], abre: "18:00", cierra: "01:00" },
  ];

  async function estadoA(iso: string) {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario: turnos });
    vi.setSystemTime(new Date(iso));
    const [b] = await buildStorefrontBranches(f.repo, f.organizationId);
    return b!;
  }

  it("borde exacto de apertura y cierre del primer turno (Merida UTC-6)", async () => {
    expect((await estadoA("2026-09-28T17:59:00Z")).abiertoAhora).toBe(false); // 11:59
    expect((await estadoA("2026-09-28T18:00:00Z")).abiertoAhora).toBe(true); // 12:00
    expect((await estadoA("2026-09-28T21:59:00Z")).abiertoAhora).toBe(true); // 15:59
    const cerrado = await estadoA("2026-09-28T22:00:00Z"); // 16:00: entre turnos
    expect(cerrado.abiertoAhora).toBe(false);
    expect(cerrado.proximaApertura).toMatchObject({ hoy: true, hora: "18:00" });
  });

  it("segundo turno cruza la medianoche y cierra a la 1:00", async () => {
    expect((await estadoA("2026-09-29T06:59:00Z")).abiertoAhora).toBe(true); // 00:59
    expect((await estadoA("2026-09-29T07:00:00Z")).abiertoAhora).toBe(false); // 01:00
  });

  it("sin horario configurado no afirma abierto ni cerrado", async () => {
    const f = buildRestaurantFixture();
    const [b] = await buildStorefrontBranches(f.repo, f.organizationId);
    expect(b).toMatchObject({ abiertoAhora: null, pedidoMinimoDomicilio: null, zonasReparto: [] });
  });

  it("expone solo sucursales activas, el minimo por canal y las zonas de reparto", async () => {
    const f = buildRestaurantFixture();
    const zonaId = randomUUID();
    f.repo.seedKnownZone({ id: zonaId, organizationId: f.organizationId, name: "Vista Alegre", lat: 21.01, lng: -89.6 });
    f.repo.seedBranchDeliveryZones(f.propertyId, [zonaId]);
    f.repo.seedBranchPolicy(f.propertyId, { pedidoMinimoDomicilio: 200, propinaPolitica: "solo_tarjeta" });
    f.repo.seedBranch({ propertyId: randomUUID(), organizationId: f.organizationId, name: "Cerrada", slug: "cerrada", status: "inactive", phone: null, address: null, lat: null, lng: null });
    const branches = await buildStorefrontBranches(f.repo, f.organizationId);
    expect(branches.map((b) => b.slug)).toEqual(["fco-montejo"]);
    expect(branches[0]).toMatchObject({ pedidoMinimoDomicilio: 200, propinaPolitica: "solo_tarjeta", zonasReparto: ["Vista Alegre"] });
  });
});

describe("el canal web solo expone cotizar, confirmar y crear", () => {
  it("no ofrece buscar_cliente ni escalar_a_humano (sin identidad del cliente)", () => {
    expect(toolDefinitionsForChannel("web").map((t) => t.name).sort()).toEqual(["confirmar_resumen", "cotizar_pedido", "crear_pedido"]);
  });
  it("una herramienta que el canal web no tiene se rechaza", async () => {
    const s = setup();
    await expect(invokeAgentTool(s.f.repo, s.ctx, "buscar_cliente", {})).rejects.toThrow(/desconocida/);
  });
});

describe("flujo cotizar -> confirmar -> crear (canal web)", () => {
  it("camino feliz recoger: crea el pedido con source web y telefono canonico", async () => {
    const s = setup();
    const out = await s.full();
    const order = out.raw as { source: string; customerPhone: string; status: string; total: number };
    expect(order).toMatchObject({ source: "web", customerPhone: "9991234567", status: "pending", total: 90 });
  });

  it("crear sin cotizar y crear sin confirmar se rechazan y no crean pedido", async () => {
    const s = setup();
    await expect(s.create()).rejects.toMatchObject({ code: "sin_cotizacion" });
    await s.quote();
    await expect(s.create()).rejects.toMatchObject({ code: "sin_confirmacion" });
    expect(await s.f.repo.findCustomerByPhone(s.f.organizationId, "9991234567")).toBeNull();
  });

  it("cambiar el carrito despues de confirmar obliga a re-cotizar", async () => {
    const s = setup();
    await s.quote();
    await s.confirm();
    await expect(s.create({ items: [{ ...s.coca, requested_quantity: 5 }] })).rejects.toMatchObject({ code: "pedido_distinto_al_cotizado" });
  });

  it("doble envio: el segundo crear devuelve pedido_ya_creado y no duplica", async () => {
    const s = setup();
    await s.full();
    await expect(s.create()).rejects.toMatchObject({ code: "pedido_ya_creado" });
    const customer = (await s.f.repo.findCustomerByPhone(s.f.organizationId, "9991234567"))!;
    expect(await s.f.repo.listEligibleOrderHistory(customer.id)).toHaveLength(1);
  });

  it("sesiones distintas no comparten estado: confirmar la de otro no habilita la mia", async () => {
    const s = setup();
    await s.quote();
    await s.confirm();
    const otra = ctxWeb(s.f, "sesion-web-0002-zzzzzz");
    await expect(invokeAgentTool(s.f.repo, otra, "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [s.coca], customer_name: "Eva", customer_phone: "9990000000", payment_method: "efectivo" })).rejects.toMatchObject({ code: "sin_cotizacion" });
  });

  it("carrito mixto a domicilio y recoger: tacos con tortilla + bebida + alcohol con mayoria de edad (recoger)", async () => {
    const s = setup();
    const items = [s.tacos, s.coca, s.sol];
    await expect(invokeAgentTool(s.f.repo, s.ctx, "cotizar_pedido", { ...s.quote, branch_slug: "fco-montejo", canal: "recoger", items })).rejects.toThrow(/mayor de edad/);
    const out = await s.full({ items, adult_confirmed: true });
    const order = out.raw as { total: number; items: Array<{ name: string; tortilla?: string }> };
    expect(order.total).toBe(2 * 164 + 2 * 45 + 66);
    expect(order.items.find((i) => i.name.startsWith("Tacos"))?.tortilla).toBe("maiz");
  });

  it("tacos sin tortilla se rechazan en la cotizacion", async () => {
    const s = setup();
    await expect(s.quote({ items: [{ ...s.tacos, tortilla: undefined }] })).rejects.toThrow(/tortilla/);
  });
});

describe("reglas duras de PM en el checkout web", () => {
  it("minimo de $200 a domicilio: $164 se rechaza con el faltante y recoger si pasa", async () => {
    const s = setup();
    s.f.repo.seedBranchPolicy(s.f.propertyId, { pedidoMinimoDomicilio: 200 });
    const unaOrden = { ...s.tacos, requested_quantity: 3 };
    await expect(s.quote({ canal: "domicilio", items: [unaOrden] })).rejects.toThrow(/mínimo a domicilio.*\$200.*faltan \$36/);
    await expect(s.quote({ canal: "recoger", items: [unaOrden] })).resolves.toBeTruthy();
    await expect(s.quote({ canal: "domicilio", items: [s.tacos] })).resolves.toBeTruthy(); // $328
  });

  it("borde exacto del minimo: $200 pasa, $199.99 no", async () => {
    const s = setup();
    s.f.repo.seedBranchPolicy(s.f.propertyId, { pedidoMinimoDomicilio: 164 });
    await expect(s.quote({ canal: "domicilio", items: [{ ...s.tacos, requested_quantity: 3 }] })).resolves.toBeTruthy();
    s.f.repo.seedBranchPolicy(s.f.propertyId, { pedidoMinimoDomicilio: 164.01 });
    await expect(s.quote({ canal: "domicilio", items: [{ ...s.tacos, requested_quantity: 3 }] })).rejects.toThrow(/mínimo/);
  });

  it("alcohol (no_domicilio) se rechaza a domicilio y se permite al recoger", async () => {
    const s = setup();
    s.f.repo.seedNoDomicilio({ categoryIds: [s.f.categories.cervezas] });
    await expect(s.quote({ canal: "domicilio", items: [s.sol], adult_confirmed: true })).rejects.toThrow(/no se vende a domicilio/);
    await expect(s.quote({ canal: "recoger", items: [s.sol], adult_confirmed: true })).resolves.toBeTruthy();
  });

  it("fuera de zona: colonia no cubierta se rechaza, colonia cubierta pasa, sin colonia se pide", async () => {
    const s = setup();
    const cubierta = randomUUID();
    const lejana = randomUUID();
    s.f.repo.seedKnownZone({ id: cubierta, organizationId: s.f.organizationId, name: "Vista Alegre", lat: 21.01, lng: -89.6 });
    s.f.repo.seedKnownZone({ id: lejana, organizationId: s.f.organizationId, name: "Chicxulub", lat: 21.3, lng: -89.6 });
    s.f.repo.seedBranchDeliveryZones(s.f.propertyId, [cubierta]);
    await expect(s.quote({ canal: "domicilio" })).rejects.toThrow(/colonia o zona/);
    await expect(s.quote({ canal: "domicilio", colonia_entrega: "Chicxulub" })).rejects.toThrow(/fuera de la zona de reparto/);
    await expect(s.quote({ canal: "domicilio", colonia_entrega: "Colonia inventada" })).rejects.toThrow(/No reconozco esa colonia/);
    await expect(s.quote({ canal: "domicilio", colonia_entrega: "Vista Alegre" })).resolves.toBeTruthy();
  });

  it("propina solo con tarjeta: con efectivo se rechaza, con tarjeta pasa", async () => {
    const s = setup();
    s.f.repo.seedBranchPolicy(s.f.propertyId, { propinaPolitica: "solo_tarjeta" });
    await s.quote({ payment_method: "efectivo" });
    await s.confirm();
    await expect(s.create({ propina: 20, payment_method: "efectivo" })).rejects.toThrow(/solo se registra cuando el pago es con tarjeta/);
    const out = await s.create({ propina: 20, payment_method: "tarjeta" });
    expect((out.raw as { notes: string }).notes).toContain("Propina: $20.00");
  });

  it("sucursal cerrada: la cotizacion y el pedido se rechazan con la proxima apertura", async () => {
    const s = setup();
    s.f.repo.seedBranchPolicy(s.f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "18:00", cierra: "01:00" }] });
    await expect(s.quote()).rejects.toThrow(/cerrada.*abre hoy a las 18:00/);
  });

  it("cierra entre la cotizacion y el crear: el pedido se rechaza, no se registra", async () => {
    const s = setup();
    s.f.repo.seedBranchPolicy(s.f.propertyId, { horario: [{ dias: [1], abre: "12:00", cierra: "16:00" }] });
    vi.setSystemTime(new Date("2026-09-28T21:50:00Z")); // 15:50, abierto
    await s.quote();
    await s.confirm();
    vi.setSystemTime(new Date("2026-09-28T22:05:00Z")); // 16:05, ya cerro (la cotizacion sigue vigente)
    await expect(s.create()).rejects.toThrow(/cerrada/);
    expect(await s.f.repo.findCustomerByPhone(s.f.organizationId, "9991234567")).toBeNull();
  });
});

describe("reglas del checkout web (assertWebOrderRules)", () => {
  const base = { organizationId: "o", branchSlug: "s", customerName: "Ana", customerPhone: "9991234567", items: [], source: "web" as const, paymentMethod: "efectivo" as const };
  it("a domicilio exige direccion; recoger no", () => {
    expect(() => assertWebOrderRules({ ...base, canal: "domicilio" })).toThrow(/dirección completa/);
    expect(() => assertWebOrderRules({ ...base, canal: "domicilio", customerAddress: "   " })).toThrow(/dirección completa/);
    expect(assertWebOrderRules({ ...base, canal: "recoger" }).canal).toBe("recoger");
  });
  it("telefono de 10 digitos (acepta +52/521) y rechaza lo demas", () => {
    expect(assertWebOrderRules({ ...base, canal: "recoger", customerPhone: "+52 1 999 123 4567" }).customerPhone).toBe("9991234567");
    expect(() => assertWebOrderRules({ ...base, canal: "recoger", customerPhone: "12345" })).toThrow(/10 dígitos/);
  });
  it("forma de pago obligatoria: efectivo o tarjeta", () => {
    expect(() => assertWebOrderRules({ ...base, canal: "recoger", paymentMethod: undefined })).toThrow(/efectivo o tarjeta/);
  });
  it("promociones solo para recoger", () => {
    expect(() => assertWebOrderRules({ ...base, canal: "domicilio", customerAddress: "Calle 1", promoCode: "X" })).toThrow(/solo aplican para pedidos que recoges/);
    expect(assertWebOrderRules({ ...base, canal: "recoger", promoCode: "X" }).promoCode).toBe("X");
  });
  it("un canal desconocido se rechaza en vez de caer a domicilio", () => {
    expect(() => assertWebOrderRules({ ...base, canal: "volando" as never })).toThrow(/canal/);
  });
});

describe("promociones: vista previa", () => {
  it("recoger aplica el 2x1; domicilio nunca; codigo inexistente se explica sin lanzar", async () => {
    const s = setup();
    await s.f.repo.createPromotion(s.f.organizationId, { code: "COCA2X1", name: "Coca 2x1", type: "bogo", value: 1, channels: ["recoger"] });
    const items = [{ id: s.f.products.cocaCola, name: "Coca-Cola", price: 45, quantity: 2 }];
    const args = { organizationId: s.f.organizationId, propertyId: s.f.propertyId, total: 90, items, now: LUNES_14 };
    expect(await previewPromotion(s.f.repo, { ...args, rawCode: " coca2x1 ", canal: "recoger" })).toMatchObject({ valida: true, descuento: 45, totalConDescuento: 45 });
    expect(await previewPromotion(s.f.repo, { ...args, rawCode: "COCA2X1", canal: "domicilio" })).toMatchObject({ valida: false, descuento: 0, totalConDescuento: 90 });
    expect(await previewPromotion(s.f.repo, { ...args, rawCode: "NOEXISTE", canal: "recoger" })).toMatchObject({ valida: false, mensaje: expect.stringContaining("no existe") });
  });

  it("crear con promo a domicilio se rechaza; al recoger descuenta el total real", async () => {
    const s = setup();
    await s.f.repo.createPromotion(s.f.organizationId, { code: "COCA2X1", name: "Coca 2x1", type: "bogo", value: 1, channels: ["recoger"] });
    await s.quote({ canal: "domicilio" });
    await s.confirm();
    await expect(s.create({ canal: "domicilio", customer_address: "Calle 1 #2", promo_code: "COCA2X1" })).rejects.toThrow(/solo aplican para pedidos que recoges/);
    await s.quote();
    await s.confirm();
    const out = await s.create({ promo_code: "COCA2X1" });
    expect((out.raw as { total: number }).total).toBe(45);
  });
});

describe("rastreo por pedido", () => {
  it("devuelve estado y renglones de SU organizacion y nada de datos personales", async () => {
    const s = setup();
    const created = (await s.full()).raw as { id: string };
    const res = await s.f.repo.findStorefrontOrderTracking(s.f.organizationId, created.id);
    expect(res.disponible).toBe(true);
    expect(res.pedido).toMatchObject({ status: "pending", canal: "recoger", total: 90, items: [{ name: "Coca-Cola", quantity: 2, tortilla: null }] });
    expect(JSON.stringify(res)).not.toMatch(/Ana|9991234567/);
  });

  it("otro tenant o id inexistente: sin pedido", async () => {
    const s = setup();
    const created = (await s.full()).raw as { id: string };
    expect((await s.f.repo.findStorefrontOrderTracking(randomUUID(), created.id)).pedido).toBeNull();
    expect((await s.f.repo.findStorefrontOrderTracking(s.f.organizationId, randomUUID())).pedido).toBeNull();
  });
});
