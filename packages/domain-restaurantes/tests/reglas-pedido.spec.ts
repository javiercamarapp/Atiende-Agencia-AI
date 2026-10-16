// Reglas por sucursal del modelo PM (migracion 023) aplicadas al cotizar y al crear un
// pedido: horario, pedido minimo por canal, propina solo con tarjeta, no_domicilio y
// cobertura de entrega ("fuera de zona"). Corre sobre el repositorio en memoria; el
// comportamiento contra la base SIN migrar lo cubre modelo-pm-savepoint.spec.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createOrder, quoteOrder } from "../src/orders.ts";
import { OrderValidationError } from "../src/errors.ts";
import { aplicarReglasDeSucursal, debePreguntarPropina, matchKnownZone, normalizarCanal } from "../src/reglas-pedido.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { CreateOrderInput, KnownZone } from "../src/types.ts";

afterEach(() => {
  vi.useRealTimers();
});

const DOS_COCAS = 90; // 2 x $45 del fixture
const TACOS = 164;

function baseOrder(fixture: ReturnType<typeof buildRestaurantFixture>, extra: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    organizationId: fixture.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Marcela Pech",
    customerPhone: "9991234567",
    customerAddress: "Calle 7 #210, Vista Alegre",
    items: [{ productId: fixture.products.cocaCola, requestedQuantity: 2 }],
    source: "whatsapp",
    paymentMethod: "efectivo",
    ...extra,
  };
}

describe("pedido minimo por sucursal y canal", () => {
  it("a domicilio: un pedido bajo el minimo se rechaza con mensaje claro (monto, faltante y alternativa)", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { pedidoMinimoDomicilio: 200 });
    const error = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrderValidationError);
    expect((error as Error).message).toContain("El pedido mínimo a domicilio en Francisco de Montejo es de $200");
    expect((error as Error).message).toContain(`suma $${DOS_COCAS}`);
    expect((error as Error).message).toContain("faltan $110");
    expect((error as Error).message).toContain("pasar a recoger");
  });

  it("a domicilio: justo en el minimo y por encima se acepta", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { pedidoMinimoDomicilio: TACOS });
    const quote = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: [{ productId: f.products.tacosPastor, requestedQuantity: 3, tortilla: "maiz" }] });
    expect(quote.total).toBe(TACOS);
    expect(quote.pedidoMinimo).toBe(TACOS);
  });

  it("el minimo de recoger es independiente del de domicilio", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { pedidoMinimoDomicilio: 200, pedidoMinimoRecoger: null });
    const quote = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, requestedQuantity: 1 }] });
    expect(quote.total).toBe(45);
    expect(quote.canal).toBe("recoger");
    expect(quote.pedidoMinimo).toBeNull();

    f.repo.seedBranchPolicy(f.propertyId, { pedidoMinimoRecoger: 100 });
    await expect(
      quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", canal: "recoger", items: [{ productId: f.products.cocaCola, requestedQuantity: 1 }] }),
    ).rejects.toThrow(/mínimo para recoger/);
  });

  it("checkout (createOrder): el minimo se aplica al total de renglones y NO se crea ningun pedido ni cliente", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { pedidoMinimoDomicilio: 200 });
    await expect(createOrder(f.repo, baseOrder(f))).rejects.toThrow(/mínimo a domicilio/);
    expect(await f.repo.findCustomerByPhone(f.organizationId, "9991234567")).toBeNull();
  });

  it("el minimo se evalua ANTES de descuentos: una promocion no permite burlarlo", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { pedidoMinimoDomicilio: 200 });
    await f.repo.createPromotion(f.organizationId, { code: "MITAD", name: "Mitad", type: "percentage", value: 50 });
    await expect(createOrder(f.repo, baseOrder(f, { promoCode: "MITAD", items: [{ productId: f.products.tacosPastor, requestedQuantity: 3, tortilla: "maiz" }, { productId: f.products.cocaCola, requestedQuantity: 1 }] }))).resolves.toBeTruthy();
    // 164 + 45 = 209 >= 200 pasa aunque el total con descuento quede bajo 200
  });

  it("sin politica configurada nada cambia (compatibilidad con tenants y bases sin migrar)", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, baseOrder(f));
    expect(order.total).toBe(DOS_COCAS);
    expect(order.notes).not.toContain("Canal:");
  });
});

describe("canal recoger", () => {
  it("no exige direccion de entrega y deja el canal en las notas", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, baseOrder(f, { canal: "recoger", customerAddress: undefined }));
    expect(order.notes).toContain("Canal: recoger en sucursal.");
    expect(order.customerAddress).toBeNull();
  });

  it("a domicilio sigue exigiendo direccion para voz/whatsapp", async () => {
    const f = buildRestaurantFixture();
    await expect(createOrder(f.repo, baseOrder(f, { canal: "domicilio", customerAddress: undefined }))).rejects.toThrow(/dirección completa/);
  });

  it("un canal fuera del catalogo se rechaza en vez de caer en silencio", () => {
    expect(() => normalizarCanal("drive-thru")).toThrow(OrderValidationError);
    expect(normalizarCanal(undefined)).toBe("domicilio");
  });
});

describe("no_domicilio (alcohol, etc.)", () => {
  it("a domicilio se rechaza el producto marcado; al recoger se acepta (con confirmacion de edad)", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedNoDomicilio({ productIds: [f.products.cervezaSol] });
    const args = { organizationId: f.organizationId, branchSlug: "fco-montejo", adultConfirmed: true, items: [{ productId: f.products.cervezaSol, requestedQuantity: 1 }] };
    await expect(quoteOrder(f.repo, args)).rejects.toThrow(/Sol no se vende a domicilio/);
    await expect(quoteOrder(f.repo, { ...args, canal: "domicilio" })).rejects.toThrow(/no se vende a domicilio/);
    const quote = await quoteOrder(f.repo, { ...args, canal: "recoger" });
    expect(quote.total).toBe(66);
  });

  it("la marca por CATEGORIA alcanza a todos sus productos y es por organizacion", async () => {
    const f = buildRestaurantFixture();
    expect((await f.repo.listAvailableProductsForBranch(f.propertyId)).find((p) => p.name === "Sol")?.noDomicilio).toBe(false);
    expect(await f.repo.setCategoryNoDomicilio(randomUUID(), f.categories.cervezas, true)).toBe(false);
    expect(await f.repo.setCategoryNoDomicilio(f.organizationId, f.categories.cervezas, true)).toBe(true);
    expect((await f.repo.listNoDomicilioMarks(f.organizationId)).categoryIds).toEqual([f.categories.cervezas]);
    expect((await f.repo.listAvailableProductsForBranch(f.propertyId)).find((p) => p.name === "Sol")?.noDomicilio).toBe(true);
    await expect(
      quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", adultConfirmed: true, items: [{ productId: f.products.cervezaSol, requestedQuantity: 1 }] }),
    ).rejects.toThrow(/no se vende a domicilio/);
    // desmarcar lo devuelve a la normalidad
    await f.repo.setCategoryNoDomicilio(f.organizationId, f.categories.cervezas, false);
    await expect(quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", adultConfirmed: true, items: [{ productId: f.products.cervezaSol, requestedQuantity: 1 }] })).resolves.toBeTruthy();
  });

  it("checkout (createOrder) tambien lo bloquea y no crea pedido", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedNoDomicilio({ productIds: [f.products.cervezaSol] });
    await expect(createOrder(f.repo, baseOrder(f, { adultConfirmed: true, items: [{ productId: f.products.cervezaSol, requestedQuantity: 1 }] }))).rejects.toThrow(/no se vende a domicilio/);
    const pickup = await createOrder(f.repo, baseOrder(f, { canal: "recoger", adultConfirmed: true, customerAddress: undefined, items: [{ productId: f.products.cervezaSol, requestedQuantity: 1 }] }));
    expect(pickup.total).toBe(66);
  });

  it("un producto sin marca sigue yendo a domicilio", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedNoDomicilio({ productIds: [f.products.cervezaSol] });
    const quote = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: [{ productId: f.products.cocaCola, requestedQuantity: 1 }] });
    expect(quote.total).toBe(45);
  });
});

describe("fuera de zona (cobertura de entrega por sucursal)", () => {
  function conZonas() {
    const f = buildRestaurantFixture();
    const zonaA = randomUUID();
    const zonaB = randomUUID();
    f.repo.seedKnownZone({ id: zonaA, organizationId: f.organizationId, name: "Altabrisa", lat: 21.03, lng: -89.58 });
    f.repo.seedKnownZone({ id: zonaB, organizationId: f.organizationId, name: "Pensiones", lat: 20.96, lng: -89.66 });
    f.repo.seedBranchDeliveryZones(f.propertyId, [zonaA]);
    return { f, zonaA, zonaB };
  }
  const items = (f: ReturnType<typeof buildRestaurantFixture>) => [{ productId: f.products.cocaCola, requestedQuantity: 2 }];

  it("colonia dentro de la cobertura: se acepta (matching tolerante a espacios y acentos)", async () => {
    const { f } = conZonas();
    const quote = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", colonia: "Alta Brisa", items: items(f) });
    expect(quote.total).toBe(90);
  });

  it("colonia de OTRA zona: bloqueada como fuera de zona, con alternativa", async () => {
    const { f } = conZonas();
    const error = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", colonia: "Pensiones", items: items(f) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrderValidationError);
    expect((error as Error).message).toContain("Pensiones está fuera de la zona de reparto de Francisco de Montejo");
    expect((error as Error).message).toContain("recoger");
  });

  it("colonia desconocida: no se adivina, se pide otra referencia", async () => {
    const { f } = conZonas();
    await expect(quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", colonia: "Narnia", items: items(f) })).rejects.toThrow(/No reconozco esa colonia/);
  });

  it("sin colonia y con cobertura configurada: la pide (no deja pasar el pedido sin verificar)", async () => {
    const { f } = conZonas();
    await expect(quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: items(f) })).rejects.toThrow(/pida la colonia o zona/);
  });

  it("checkout (createOrder) aplica la misma regla; recoger la ignora", async () => {
    const { f } = conZonas();
    await expect(createOrder(f.repo, baseOrder(f, { colonia: "Pensiones" }))).rejects.toThrow(/fuera de la zona de reparto/);
    const ok = await createOrder(f.repo, baseOrder(f, { colonia: "Altabrisa" }));
    expect(ok.total).toBe(90);
    const pickup = await createOrder(f.repo, baseOrder(f, { canal: "recoger", customerAddress: undefined, customerName: "Luis Canul", customerPhone: "9997654321" }));
    expect(pickup.total).toBe(90);
  });

  it("sucursal sin cobertura configurada no restringe nada", async () => {
    const f = buildRestaurantFixture();
    const quote = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", colonia: "Cualquiera", items: items(f) });
    expect(quote.total).toBe(90);
  });

  it("matchKnownZone: la zona mas especifica gana y el texto vacio no empareja", () => {
    const zonas: KnownZone[] = [
      { id: "1", organizationId: "o", name: "Norte", lat: 0, lng: 0, createdAt: "" },
      { id: "2", organizationId: "o", name: "Colonia Norte Alto", lat: 0, lng: 0, createdAt: "" },
    ];
    expect(matchKnownZone(zonas, "vivo en colonia norte alto")?.id).toBe("2");
    expect(matchKnownZone(zonas, "   ")).toBeNull();
  });

  it("QA-restaurantes-R1-features-03: una colonia de 1 a 3 letras no empareja con ninguna zona", () => {
    const zonas: KnownZone[] = [{ id: "1", organizationId: "o", name: "Garcia Gineres", lat: 0, lng: 0, createdAt: "" }];
    for (const basura of ["a", "ar", "gin", "x y"]) expect(matchKnownZone(zonas, basura)).toBeNull();
    // Un fragmento real (>= 4 letras) y la colonia completa siguen emparejando, tambien con texto alrededor.
    expect(matchKnownZone(zonas, "gineres")?.id).toBe("1");
    expect(matchKnownZone(zonas, "Garcia Gineres")?.id).toBe("1");
    expect(matchKnownZone(zonas, "por la colonia garcia gineres norte")?.id).toBe("1");
  });
});

describe("propina solo con tarjeta", () => {
  it("debePreguntarPropina", () => {
    expect(debePreguntarPropina("solo_tarjeta", "tarjeta")).toBe(true);
    expect(debePreguntarPropina("solo_tarjeta", "efectivo")).toBe(false);
    expect(debePreguntarPropina("solo_tarjeta", undefined)).toBe(false);
    expect(debePreguntarPropina("siempre", "efectivo")).toBe(true);
    expect(debePreguntarPropina("nunca", "tarjeta")).toBe(false);
    expect(debePreguntarPropina(null, "tarjeta")).toBe(false);
  });

  it("la cotizacion dice si corresponde preguntar propina segun la forma de pago", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { propinaPolitica: "solo_tarjeta" });
    const base = { organizationId: f.organizationId, branchSlug: "fco-montejo", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }] };
    expect((await quoteOrder(f.repo, base)).preguntarPropina).toBe(false);
    expect((await quoteOrder(f.repo, { ...base, paymentMethod: "efectivo" })).preguntarPropina).toBe(false);
    const conTarjeta = await quoteOrder(f.repo, { ...base, paymentMethod: "tarjeta" });
    expect(conTarjeta.preguntarPropina).toBe(true);
    expect(conTarjeta.propinaPolitica).toBe("solo_tarjeta");
  });

  it("propina con tarjeta: se registra en las notas y NO altera el total", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { propinaPolitica: "solo_tarjeta" });
    const order = await createOrder(f.repo, baseOrder(f, { paymentMethod: "tarjeta", propina: 20 }));
    expect(order.total).toBe(DOS_COCAS);
    expect(order.notes).toContain("Propina: $20.00 (no incluida en el total).");
  });

  it("propina en porcentaje (QA-PM-R4-whatsapp-03): el servidor calcula los pesos sobre el total y no lo altera", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { propinaPolitica: "solo_tarjeta" });
    const order = await createOrder(f.repo, baseOrder(f, { paymentMethod: "tarjeta", propinaPorcentaje: 10 }));
    expect(order.total).toBe(DOS_COCAS);
    expect(order.notes).toContain(`Propina: $${(Math.round(DOS_COCAS * 10) / 100).toFixed(2)} (no incluida en el total).`);
  });

  it("propina en porcentaje con efectivo se rechaza igual que en pesos; un porcentaje fuera de rango tambien", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { propinaPolitica: "solo_tarjeta" });
    await expect(createOrder(f.repo, baseOrder(f, { paymentMethod: "efectivo", propinaPorcentaje: 10 }))).rejects.toThrow(/solo se registra cuando el pago es con tarjeta/);
    await expect(createOrder(f.repo, baseOrder(f, { paymentMethod: "tarjeta", propinaPorcentaje: 150 }))).rejects.toThrow(/entre 1 y 100/);
  });

  it("propina con efectivo: se rechaza (solo con tarjeta)", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { propinaPolitica: "solo_tarjeta" });
    await expect(createOrder(f.repo, baseOrder(f, { paymentMethod: "efectivo", propina: 20 }))).rejects.toThrow(/solo se registra cuando el pago es con tarjeta/);
  });

  it("sucursal sin politica de propina: no acepta propina > 0, pero propina 0 es inocua", async () => {
    const f = buildRestaurantFixture();
    await expect(createOrder(f.repo, baseOrder(f, { paymentMethod: "tarjeta", propina: 10 }))).rejects.toThrow(/no registra propina/);
    await expect(createOrder(f.repo, baseOrder(f, { paymentMethod: "tarjeta", propina: 0 }))).resolves.toBeTruthy();
  });

  it("propina negativa o no numerica se rechaza en validacion", async () => {
    const f = buildRestaurantFixture();
    await expect(createOrder(f.repo, baseOrder(f, { propina: -5 }))).rejects.toThrow(/propina/i);
  });
});

describe("horario: sucursal cerrada", () => {
  const PM = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }];

  it("cerrada: se rechaza el pedido con la hora de apertura; abierta pasada la medianoche: se acepta", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario: PM });
    await f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
    vi.useFakeTimers({ toFake: ["Date"] });

    // lunes 2026-09-28 10:00 hora de Merida = 16:00 UTC
    vi.setSystemTime(new Date("2026-09-28T16:00:00Z"));
    const error = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }] }).catch((e: unknown) => e);
    expect((error as Error).message).toBe("La sucursal Francisco de Montejo está cerrada en este momento; abre hoy a las 12:00.");

    // martes 00:30 hora de Merida = 06:30 UTC: el turno del lunes sigue abierto
    vi.setSystemTime(new Date("2026-09-29T06:30:00Z"));
    const quote = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }] });
    expect(quote.abiertoAhora).toBe(true);
    expect(quote.cierraA).toBe("01:00");
  });

  it("checkout (createOrder) tambien respeta el horario, salvo captura manual de staff (source admin)", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario: PM });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T08:00:00Z")); // martes 02:00 en Merida: cerrado
    await expect(createOrder(f.repo, baseOrder(f))).rejects.toThrow(/cerrada en este momento/);
    await expect(createOrder(f.repo, baseOrder(f, { source: "admin", paymentMethod: undefined }))).resolves.toBeTruthy();
  });

  it("el horario se evalua en la zona horaria de la SUCURSAL (no la del proceso)", async () => {
    const f = buildRestaurantFixture();
    const propertyId = f.propertyId;
    const branch = (await f.repo.findBranch(f.organizationId, { slug: "fco-montejo" }))!;
    const horario = [{ dias: [1], abre: "18:00", cierra: "23:00" }];
    // lunes 28-sep 19:00 en Merida = 29-sep 01:00 UTC
    const instante = new Date("2026-09-29T01:00:00Z");
    f.repo.seedBranchPolicy(propertyId, { horario });
    await f.repo.upsertBranchZonaHoraria(propertyId, "Asia/Tokyo");
    await expect(aplicarReglasDeSucursal(f.repo, { branch, canal: "domicilio", subtotal: 100, now: instante })).rejects.toThrow(/cerrada/);
    await f.repo.upsertBranchZonaHoraria(propertyId, "America/Merida");
    await expect(aplicarReglasDeSucursal(f.repo, { branch, canal: "domicilio", subtotal: 100, now: instante })).resolves.toMatchObject({ apertura: { abierto: true } });
  });

  it("sin horario configurado nunca bloquea y reporta abiertoAhora null", async () => {
    const f = buildRestaurantFixture();
    const quote = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }] });
    expect(quote.abiertoAhora).toBeNull();
  });
});
