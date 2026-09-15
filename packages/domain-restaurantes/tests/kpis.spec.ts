// Tests reales (contra InMemoryRestaurantesRepository, no mocks) de la Fase 3 —
// dashboards de KPIs. Cubre: construcción de tramos/periodos de comparación (puerto de
// construirTramosTendencia/construirPeriodosComparacion), las 3 orquestaciones
// (ventas/canales/clientes) contra datos reales sembrados, el alcance por
// `propertyIds` (membership restringida vs. org-wide), y honestidad de "null" cuando
// no hay base para calcular un `%`/promedio (nunca un cero fingido).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildRestaurantFixture } from "./fixtures.ts";
import {
  buildComparisonPeriods,
  buildTrendBuckets,
  getChannelKpis,
  getCustomerKpis,
  getSalesKpis,
  getSalesTrendKpis,
  periodLabel,
} from "../src/kpis.ts";
import type { Order, PersistedOrderItem } from "../src/types.ts";
import type { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";

function makeOrder(overrides: Partial<Order> & { organizationId: string; propertyId: string }): Order {
  const items: readonly PersistedOrderItem[] = overrides.items ?? [{ id: randomUUID(), name: "Tacos de Bistec de Res (orden de 3)", price: 164, quantity: 1 }];
  return {
    id: randomUUID(),
    customerId: null,
    customerName: "Cliente de prueba",
    customerPhone: "9990000000",
    customerAddress: null,
    customerEmail: null,
    branch: null,
    total: 164,
    status: "completado",
    items,
    source: "web",
    notes: null,
    paymentMethod: null,
    callTranscript: null,
    callRecordingUrl: null,
    dedupeFingerprint: null,
    idempotencyKey: null,
    createdAt: new Date().toISOString(),
    assignedRepartidorId: null,
    estimatedDeliveryAt: null,
    incidentNote: null,
    ...overrides,
  };
}

// Fechas de referencia construidas SIEMPRE con el constructor local (`new Date(Y, M,
// D, H)`), nunca con strings ISO con sufijo "Z" — buildTrendBuckets/
// buildComparisonPeriods operan en la hora LOCAL del proceso que los ejecuta (puerto
// literal de construirTramosTendencia/construirPeriodosComparacion, que en el origen
// corrían en el navegador del staff con `new Date()`; ver comentario de archivo en
// kpis.ts). Mezclar timestamps UTC-Z con aserciones de calendario local haría estos
// tests frágiles según el TZ de quien los corra — con el constructor local, la
// comparación es consistente sin importar el TZ del proceso.
describe("buildTrendBuckets — puerto de construirTramosTendencia", () => {
  it("'today' da 13 tramos de 1 hora, de 11:00 a 23:00", () => {
    const now = new Date(2026, 8, 10, 18, 0, 0);
    const tramos = buildTrendBuckets("today", now, null);
    expect(tramos).toHaveLength(13);
    expect(tramos[0]!.label).toBe("11:00");
    expect(tramos.at(-1)!.label).toBe("23:00");
    expect(tramos[1]!.start.getTime() - tramos[0]!.start.getTime()).toBe(60 * 60 * 1000);
  });

  it("'7' da 7 tramos de 1 día, el último terminando hoy", () => {
    const now = new Date(2026, 8, 10, 18, 0, 0);
    const tramos = buildTrendBuckets("7", now, null);
    expect(tramos).toHaveLength(7);
    const ultimo = tramos.at(-1)!;
    expect(ultimo.end.getTime() - ultimo.start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("'historico' con <=12 meses de antigüedad da un punto por mes", () => {
    const now = new Date(2026, 8, 10); // 10-sep-2026
    const firstOrderAt = new Date(2026, 2, 1); // 1-mar-2026, ~6 meses atrás
    const tramos = buildTrendBuckets("historico", now, firstOrderAt);
    expect(tramos.length).toBe(7); // marzo..septiembre inclusive
  });

  it("'historico' sin ningún pedido todavía (firstOrderAt null) no explota: 1 solo tramo (el mes actual)", () => {
    const now = new Date(2026, 8, 10);
    const tramos = buildTrendBuckets("historico", now, null);
    expect(tramos).toHaveLength(1);
  });
});

describe("buildComparisonPeriods / periodLabel", () => {
  it("'today': actual=[hoy,MUY_FUTURO), previo=[ayer,hoy)", () => {
    const now = new Date(2026, 8, 10, 18, 0, 0);
    const { current, previous } = buildComparisonPeriods("today", now);
    expect(current.start.getTime()).toBe(new Date(2026, 8, 10, 0, 0, 0, 0).getTime());
    expect(previous!.start.getTime()).toBe(new Date(2026, 8, 9, 0, 0, 0, 0).getTime());
    expect(previous!.end.getTime()).toBe(new Date(2026, 8, 10, 0, 0, 0, 0).getTime());
  });

  it("'historico' no tiene periodo previo (es un total, no una ventana con antes/después)", () => {
    const { previous } = buildComparisonPeriods("historico", new Date());
    expect(previous).toBeNull();
  });

  it("periodLabel da el texto exacto del origen para cada periodo", () => {
    expect(periodLabel("today")).toBe("vs ayer");
    expect(periodLabel("30")).toBe("vs 30 días anteriores");
    expect(periodLabel("historico")).toBe("todo el tiempo registrado");
  });
});

describe("getSalesKpis — 'Tus ventas' agregado real, con % de cambio", () => {
  it("suma ventas del periodo actual y calcula %s contra el periodo previo real", async () => {
    const fixture = buildRestaurantFixture();
    const now = new Date(2026, 8, 10, 12, 0, 0);

    // Periodo actual ('7'): últimos 7 días — 2 pedidos, $300 total.
    fixture.repo.seedOrder(makeOrder({ organizationId: fixture.organizationId, propertyId: fixture.propertyId, total: 100, customerName: "Ana", createdAt: new Date(2026, 8, 8, 10, 0, 0).toISOString() }));
    fixture.repo.seedOrder(makeOrder({ organizationId: fixture.organizationId, propertyId: fixture.propertyId, total: 200, customerName: "Beto", createdAt: new Date(2026, 8, 9, 10, 0, 0).toISOString() }));
    // Periodo previo (7-14 días atrás): 1 pedido, $100.
    fixture.repo.seedOrder(makeOrder({ organizationId: fixture.organizationId, propertyId: fixture.propertyId, total: 100, customerName: "Carla", createdAt: new Date(2026, 7, 30, 10, 0, 0).toISOString() }));
    // Fuera de ambas ventanas — nunca debe contar.
    fixture.repo.seedOrder(makeOrder({ organizationId: fixture.organizationId, propertyId: fixture.propertyId, total: 9999, customerName: "Fuera de rango", createdAt: new Date(2026, 0, 1, 0, 0, 0).toISOString() }));

    const summary = await getSalesKpis(fixture.repo, fixture.organizationId, null, "7", now);
    expect(summary.revenue).toBe(300);
    expect(summary.orders).toBe(2);
    expect(summary.customers).toBe(2);
    expect(summary.averageOrder).toBe(150);
    expect(summary.revenueChangePct).toBe(200); // (300-100)/100*100
    expect(summary.ordersChangePct).toBe(100); // (2-1)/1*100
    expect(summary.periodLabel).toBe("vs 7 días anteriores");
  });

  it("periodo previo en $0 -> % es 100 si el actual tiene ventas, 0 si tampoco (nunca división por cero real)", async () => {
    const fixture = buildRestaurantFixture();
    const now = new Date(2026, 8, 10, 12, 0, 0);
    fixture.repo.seedOrder(makeOrder({ organizationId: fixture.organizationId, propertyId: fixture.propertyId, total: 50, createdAt: new Date(2026, 8, 9, 10, 0, 0).toISOString() }));

    const summary = await getSalesKpis(fixture.repo, fixture.organizationId, null, "7", now);
    expect(summary.revenueChangePct).toBe(100);

    const sinNada = await getSalesKpis(fixture.repo, randomUUID(), null, "7", now);
    expect(sinNada.revenue).toBe(0);
    expect(sinNada.revenueChangePct).toBe(0);
  });

  it("'historico' no trae periodo previo -> los %s de cambio son null (nunca 0 fingido)", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedOrder(makeOrder({ organizationId: fixture.organizationId, propertyId: fixture.propertyId, total: 100 }));
    const summary = await getSalesKpis(fixture.repo, fixture.organizationId, null, "historico", new Date());
    expect(summary.revenueChangePct).toBeNull();
    expect(summary.ordersChangePct).toBeNull();
    expect(summary.avgOrderChangePct).toBeNull();
  });
});

describe("getSalesTrendKpis — un punto por tramo, alineado con buildTrendBuckets", () => {
  it("reparte los pedidos en el tramo de día correcto", async () => {
    const fixture = buildRestaurantFixture();
    const now = new Date(2026, 8, 10, 12, 0, 0);
    fixture.repo.seedOrder(makeOrder({ organizationId: fixture.organizationId, propertyId: fixture.propertyId, total: 100, createdAt: new Date(2026, 8, 10, 9, 0, 0).toISOString() }));
    fixture.repo.seedOrder(makeOrder({ organizationId: fixture.organizationId, propertyId: fixture.propertyId, total: 50, createdAt: new Date(2026, 8, 8, 9, 0, 0).toISOString() }));

    const puntos = await getSalesTrendKpis(fixture.repo, fixture.organizationId, null, "7", now, null);
    expect(puntos).toHaveLength(7);
    const total = puntos.reduce((s, p) => s + p.revenue, 0);
    expect(total).toBe(150);
    expect(puntos.at(-1)!.revenue).toBe(100); // hoy (último tramo)
  });
});

describe("Alcance por property (membership restringida vs. org-wide)", () => {
  function seedSecondBranch(repo: InMemoryRestaurantesRepository, organizationId: string) {
    const propertyIdB = randomUUID();
    repo.seedBranch({ propertyId: propertyIdB, organizationId, name: "Sucursal Centro", slug: "centro", status: "active", phone: null, address: null, lat: null, lng: null });
    return propertyIdB;
  }

  it("propertyIds=null agrega TODA la organización; un arreglo acota a esas properties exactas", async () => {
    const fixture = buildRestaurantFixture();
    const propertyIdB = seedSecondBranch(fixture.repo, fixture.organizationId);
    fixture.repo.seedOrder(makeOrder({ organizationId: fixture.organizationId, propertyId: fixture.propertyId, total: 100 }));
    fixture.repo.seedOrder(makeOrder({ organizationId: fixture.organizationId, propertyId: propertyIdB, total: 300 }));

    const todaLaOrg = await getSalesKpis(fixture.repo, fixture.organizationId, null, "historico", new Date());
    expect(todaLaOrg.revenue).toBe(400);

    const soloSucursalA = await getSalesKpis(fixture.repo, fixture.organizationId, [fixture.propertyId], "historico", new Date());
    expect(soloSucursalA.revenue).toBe(100);

    const soloSucursalB = await getSalesKpis(fixture.repo, fixture.organizationId, [propertyIdB], "historico", new Date());
    expect(soloSucursalB.revenue).toBe(300);
  });
});

describe("getChannelKpis — 'Impacto de tus agentes'", () => {
  it("cuenta pedidos/ingreso por canal y calcula %s de adopción/ingreso IA", async () => {
    const fixture = buildRestaurantFixture();
    const base = { organizationId: fixture.organizationId, propertyId: fixture.propertyId };
    fixture.repo.seedOrder(makeOrder({ ...base, source: "web", total: 100, status: "completado" }));
    fixture.repo.seedOrder(makeOrder({ ...base, source: "voice", total: 200, status: "completado" }));
    fixture.repo.seedOrder(makeOrder({ ...base, source: "voice", total: 50, status: "cancelado" }));
    fixture.repo.seedOrder(makeOrder({ ...base, source: "whatsapp", total: 150, status: "entregado" }));

    const kpis = await getChannelKpis(fixture.repo, fixture.organizationId, null);
    expect(kpis.totalOrders).toBe(4);
    expect(kpis.totalRevenue).toBe(500);
    expect(kpis.voice).toEqual({ orders: 2, completed: 1, cancelled: 1, revenue: 250 });
    expect(kpis.whatsapp).toEqual({ orders: 1, completed: 1, cancelled: 0, revenue: 150 });
    // (voz.total + whatsapp.total) / totalOrdenes * 100 = (2+1)/4*100
    expect(kpis.aiAdoptionPct).toBe(75);
    // (voz.ingreso + whatsapp.ingreso) / ingresoTotal * 100 = (250+150)/500*100
    expect(kpis.aiRevenuePct).toBe(80);
    // (voz.completados + whatsapp.completados) * 5 / 60 = (1+1)*5/60
    expect(kpis.estimatedHoursSaved).toBeCloseTo((2 * 5) / 60, 10);
  });

  it("sin pedidos todavía: los %s son null, nunca un 0/NaN fingido; horas ahorradas es 0 real", async () => {
    const fixture = buildRestaurantFixture();
    const kpis = await getChannelKpis(fixture.repo, fixture.organizationId, null);
    expect(kpis.aiAdoptionPct).toBeNull();
    expect(kpis.aiRevenuePct).toBeNull();
    expect(kpis.estimatedHoursSaved).toBe(0);
  });
});

describe("getCustomerKpis — 'Panorama de clientes'", () => {
  it("ticket promedio, % recurrentes, cliente top y distribución por tier (cortes 95/90/70)", async () => {
    const fixture = buildRestaurantFixture();
    const orgId = fixture.organizationId;

    // 10 clientes: 9 con 1 pedido de $50, 1 con muchísimo más gasto y varios pedidos
    // (mismo diseño que el test de tier en customers.spec.ts) -> ese sale BLACK.
    // seedOrder incrementa orderCount automáticamente (mismo comportamiento que
    // createOrderIdempotent real) — se siembra el cliente en 0 y se deja que los
    // pedidos reales suban el conteo, para no contarlo dos veces.
    const customerIds: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      const id = randomUUID();
      fixture.repo.seedCustomer({ id, organizationId: orgId, phone: `999000000${i}`, name: `Cliente ${i}`, orderCount: 0 });
      fixture.repo.seedOrder(makeOrder({ organizationId: orgId, propertyId: fixture.propertyId, customerId: id, customerName: `Cliente ${i}`, total: 50, createdAt: new Date(2026, 0, 1 + i).toISOString() }));
      customerIds.push(id);
    }
    const topId = randomUUID();
    fixture.repo.seedCustomer({ id: topId, organizationId: orgId, phone: "9991239999", name: "Top Cliente", orderCount: 0 });
    for (let i = 0; i < 5; i += 1) {
      fixture.repo.seedOrder(makeOrder({ organizationId: orgId, propertyId: fixture.propertyId, customerId: topId, customerName: "Top Cliente", total: 1000, createdAt: new Date(2026, 1, 1 + i).toISOString() }));
    }

    const kpis = await getCustomerKpis(fixture.repo, orgId);
    expect(kpis.totalCustomers).toBe(10);
    // ticket promedio: (9*50 + 5*1000) / 14 pedidos
    expect(kpis.averageOrderValue).toBeCloseTo((9 * 50 + 5 * 1000) / 14, 6);
    // recurrentes: solo "Top Cliente" tiene order_count>1, sobre base de 10 con >=1 pedido.
    expect(kpis.recurringCustomerPct).toBe(10);
    expect(kpis.topCustomer).toEqual({ name: "Top Cliente", phone: "9991239999", orderCount: 5 });
    expect(kpis.tierDistribution.metric).toBe("gasto");
    expect(kpis.tierDistribution.BLACK).toBe(1);
    expect(kpis.tierDistribution.BLACK + kpis.tierDistribution.PLATINUM + kpis.tierDistribution.GOLD + kpis.tierDistribution.BLUE).toBe(10);
    expect(kpis.tierDistribution.withoutTier).toBe(0);
  });

  it("organización sin ningún cliente: todo 'sin datos'/null, nunca un cero fingido", async () => {
    const fixture = buildRestaurantFixture();
    const kpis = await getCustomerKpis(fixture.repo, fixture.organizationId);
    expect(kpis.totalCustomers).toBe(0);
    expect(kpis.averageOrderValue).toBeNull();
    expect(kpis.recurringCustomerPct).toBeNull();
    expect(kpis.topCustomer).toBeNull();
    expect(kpis.avgDaysSinceLastOrder).toBeNull();
    expect(kpis.tierDistribution.metric).toBe("sin_datos");
    expect(kpis.tierDistribution.withoutTier).toBe(0);
  });

  it("clientes sin ningún pedido vinculado a gasto real (order_count=0 todos) -> tier 'sin_datos', withoutTier = total", async () => {
    const fixture = buildRestaurantFixture();
    const orgId = fixture.organizationId;
    for (let i = 0; i < 3; i += 1) {
      fixture.repo.seedCustomer({ id: randomUUID(), organizationId: orgId, phone: `888000000${i}`, name: `Sin pedidos ${i}`, orderCount: 0 });
    }
    const kpis = await getCustomerKpis(fixture.repo, orgId);
    expect(kpis.tierDistribution.metric).toBe("sin_datos");
    expect(kpis.tierDistribution.withoutTier).toBe(3);
  });
});
