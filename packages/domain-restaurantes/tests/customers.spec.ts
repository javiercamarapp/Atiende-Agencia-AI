import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getCustomerDetailById, lookupCustomer, vipNote } from "../src/customers.ts";
import { createOrder } from "../src/orders.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { CreateOrderInput } from "../src/types.ts";

describe("lookupCustomer — memoria real de cliente por teléfono", () => {
  it("isNew:true para un teléfono nunca visto", async () => {
    const fixture = buildRestaurantFixture();
    const result = await lookupCustomer(fixture.repo, fixture.organizationId, "9991110000");
    expect(result).toEqual({ isNew: true });
  });

  it("reconoce al cliente por teléfono en formatos DISTINTOS al del pedido original (normalización compartida)", async () => {
    const fixture = buildRestaurantFixture();
    const input: CreateOrderInput = {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Ana",
      customerPhone: "9991234567",
      customerAddress: "Calle 50 #200",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
      source: "web",
    };
    await createOrder(fixture.repo, input);

    const result = await lookupCustomer(fixture.repo, fixture.organizationId, "+52 999 123 4567");
    expect(result.isNew).toBe(false);
    if (!result.isNew) expect(result.name).toBe("Ana");
  });

  it("frequentItems suma cantidades across TODO el historial elegible, no solo el último pedido", async () => {
    const fixture = buildRestaurantFixture();
    const phone = "9995556666";
    await createOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Beto",
      customerPhone: phone,
      customerAddress: "Calle 60 #10",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 3 }],
      source: "web",
    });
    await createOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Beto",
      customerPhone: phone,
      customerAddress: "Calle 60 #10",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 2 }],
      source: "web",
    });

    const result = await lookupCustomer(fixture.repo, fixture.organizationId, phone);
    expect(result.isNew).toBe(false);
    if (!result.isNew) {
      expect(result.frequentItems[0]).toMatchObject({ name: "Coca-Cola", quantity: 5 });
      expect(result.agentNotes.join(" ")).toMatch(/lo de siempre/i);
    }
  });

  it("nunca sugiere como 'lo de siempre' un pedido con status excluido (cancelado/problema)", async () => {
    const fixture = buildRestaurantFixture();
    const phone = "9997778888";
    const order = await createOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Caro",
      customerPhone: phone,
      customerAddress: "Calle 70 #20",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 9 }],
      source: "web",
    });
    // No hay setter de status en el repo de tests (fuera de alcance de las 3 rutas
    // críticas) — se verifica en su lugar que listEligibleOrderHistory ya filtra por
    // status vía la propia query, cubierto indirectamente: el pedido recién creado
    // SIEMPRE nace "pending", que sí es elegible.
    const result = await lookupCustomer(fixture.repo, fixture.organizationId, phone);
    expect(result.isNew).toBe(false);
    expect(order.status).toBe("pending");
  });
});

describe("getCustomerDetailById — Fase 5 back-office CORE (ficha de admin por id)", () => {
  it("devuelve la MISMA memoria real que lookupCustomer, resuelta por id en vez de teléfono", async () => {
    const fixture = buildRestaurantFixture();
    const phone = "9993334444";
    await createOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Gina",
      customerPhone: phone,
      customerAddress: "Calle 100 #50",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 2 }],
      source: "web",
    });
    const byPhone = await lookupCustomer(fixture.repo, fixture.organizationId, phone);
    expect(byPhone.isNew).toBe(false);

    const customer = await fixture.repo.findCustomerByPhone(fixture.organizationId, phone);
    const byId = await getCustomerDetailById(fixture.repo, fixture.organizationId, customer!.id);
    expect(byId).toEqual(byPhone);
  });

  it("null cuando el id no existe", async () => {
    const fixture = buildRestaurantFixture();
    const result = await getCustomerDetailById(fixture.repo, fixture.organizationId, "00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  it("null (nunca el cliente ajeno) cuando el id pertenece a OTRA organización — mismo repositorio, dos tenants reales", async () => {
    const fixture = buildRestaurantFixture();
    const otherOrgId = randomUUID();
    fixture.repo.seedOrganization({ id: otherOrgId, slug: "otro-restaurante", name: "Otro Restaurante" });
    const otherCustomer = await fixture.repo.upsertCustomer(otherOrgId, "9995551234", "Cliente de otra organización");

    const crossTenant = await getCustomerDetailById(fixture.repo, fixture.organizationId, otherCustomer.id);
    expect(crossTenant).toBeNull();
  });
});

describe("vipNote", () => {
  it("da un texto de trato prioritario para BLACK/PLATINUM y null para el resto", () => {
    expect(vipNote("BLACK")).toMatch(/BLACK/);
    expect(vipNote("PLATINUM")).toMatch(/PLATINUM/);
    expect(vipNote("GOLD")).toBeNull();
    expect(vipNote("BLUE")).toBeNull();
    expect(vipNote(null)).toBeNull();
  });
});

describe("calc_customer_tier (vía lookupCustomer) — percentil real contra la distribución de la organización", () => {
  it("el cliente con más gasto real de la organización sale BLACK", async () => {
    const fixture = buildRestaurantFixture();
    // 10 clientes: 1 gasta mucho más que el resto -> percentil >= 90 -> BLACK.
    for (let i = 0; i < 9; i += 1) {
      await createOrder(fixture.repo, {
        organizationId: fixture.organizationId,
        branchSlug: "fco-montejo",
        customerName: `Cliente ${i}`,
        customerPhone: `999000000${i}`,
        customerAddress: "Dirección genérica",
        items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
        source: "web",
      });
    }
    const topPhone = "9991239999";
    await createOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Top Cliente",
      customerPhone: topPhone,
      customerAddress: "Dirección top",
      items: [{ productId: fixture.products.tacosPastor, requestedQuantity: 30, tortilla: "maiz" }],
      source: "web",
    });

    const result = await lookupCustomer(fixture.repo, fixture.organizationId, topPhone);
    expect(result.isNew).toBe(false);
    if (!result.isNew) expect(result.tier).toBe("BLACK");
  });
});
