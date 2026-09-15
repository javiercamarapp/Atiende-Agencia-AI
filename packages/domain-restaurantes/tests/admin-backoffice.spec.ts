// Fase 5 back-office CORE — pruebas de dominio (InMemoryRestaurantesRepository) del
// CRUD real agregado en esta fase: categorías/productos/disponibilidad por
// sucursal, edición de sucursal, listado/paginación de pedidos y clientes. Las
// pruebas HTTP end-to-end (roles/aislamiento cross-tenant) viven en
// apps/api/tests/restaurantes-admin-*.spec.ts — este archivo cubre la lógica de
// negocio en sí, sin pasar por Hono/auth.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

describe("Categorías — CRUD real", () => {
  it("crea y edita una categoría real, acotada a su organización", async () => {
    const fixture = buildRestaurantFixture();
    const created = await fixture.repo.createCategory(fixture.organizationId, { name: "Postres", slug: "postres" });
    expect(created.name).toBe("Postres");
    expect(created.displayOrder).toBe(0);

    const updated = await fixture.repo.updateCategory(fixture.organizationId, created.id, { name: "Postres y helados" });
    expect(updated?.name).toBe("Postres y helados");
    expect(updated?.slug).toBe("postres"); // no tocado por el patch

    const listed = await fixture.repo.listCategories(fixture.organizationId);
    expect(listed.some((c) => c.id === created.id && c.name === "Postres y helados")).toBe(true);
  });

  it("editar una categoría de OTRA organización devuelve null (nunca la edita a ciegas)", async () => {
    const fixture = buildRestaurantFixture();
    const otherOrgId = randomUUID();
    const created = await fixture.repo.createCategory(otherOrgId, { name: "De otro tenant", slug: "de-otro-tenant" });

    const result = await fixture.repo.updateCategory(fixture.organizationId, created.id, { name: "hackeado" });
    expect(result).toBeNull();
  });
});

describe("Productos — CRUD real + disponibilidad por sucursal", () => {
  it("crea un producto nuevo: NO aparece en búsqueda hasta que se activa en la sucursal (branch_products)", async () => {
    const fixture = buildRestaurantFixture();
    const created = await fixture.repo.createProduct(fixture.organizationId, { name: "Agua de Horchata", price: 35 });
    expect(created.isAvailable).toBe(true); // default del producto en sí
    expect(created.categoryId).toBeNull();

    // Todavía sin fila en branch_products -> nunca aparece en el catálogo real que
    // consulta el flujo de pedido/agente (ver product-search.ts).
    const beforeActivation = await fixture.repo.listAvailableProductsForBranch(fixture.propertyId);
    expect(beforeActivation.some((p) => p.id === created.id)).toBe(false);

    const state = await fixture.repo.upsertBranchProductState(fixture.propertyId, created.id, 40, true);
    expect(state).toEqual({ propertyId: fixture.propertyId, productId: created.id, price: 40, isAvailable: true });

    const afterActivation = await fixture.repo.listAvailableProductsForBranch(fixture.propertyId);
    const found = afterActivation.find((p) => p.id === created.id);
    expect(found?.price).toBe(40); // precio de LA SUCURSAL, no el base del producto (35)
  });

  it("desactivar un producto en la sucursal lo saca de inmediato del catálogo real (sin borrar el producto)", async () => {
    const fixture = buildRestaurantFixture();
    await fixture.repo.upsertBranchProductState(fixture.propertyId, fixture.products.cocaCola, 45, false);
    const catalog = await fixture.repo.listAvailableProductsForBranch(fixture.propertyId);
    expect(catalog.some((p) => p.id === fixture.products.cocaCola)).toBe(false);

    const product = await fixture.repo.findProduct(fixture.organizationId, fixture.products.cocaCola);
    expect(product).not.toBeNull(); // el producto en sí sigue existiendo en el catálogo de administración
  });

  it("actualiza nombre/precio/categoría de un producto existente", async () => {
    const fixture = buildRestaurantFixture();
    const updated = await fixture.repo.updateProduct(fixture.organizationId, fixture.products.cocaCola, { name: "Coca-Cola 600ml", price: 48 });
    expect(updated?.name).toBe("Coca-Cola 600ml");
    expect(updated?.price).toBe(48);
  });

  it("editar/leer un producto de OTRA organización -> null (aislamiento real)", async () => {
    const fixture = buildRestaurantFixture();
    const otherOrgId = randomUUID();
    const otherProduct = await fixture.repo.createProduct(otherOrgId, { name: "De otro tenant", price: 10 });

    expect(await fixture.repo.findProduct(fixture.organizationId, otherProduct.id)).toBeNull();
    expect(await fixture.repo.updateProduct(fixture.organizationId, otherProduct.id, { name: "hackeado" })).toBeNull();
  });
});

describe("Sucursales — ficha de administración", () => {
  it("listBranchesForOrganizationAdmin incluye sucursales inactivas (a diferencia de listBranchesForOrganization)", async () => {
    const fixture = buildRestaurantFixture();
    const inactivePropertyId = randomUUID();
    fixture.repo.seedBranch({ propertyId: inactivePropertyId, organizationId: fixture.organizationId, name: "Sucursal cerrada", slug: "cerrada", status: "inactive", phone: null, address: null, lat: null, lng: null });

    const publicList = await fixture.repo.listBranchesForOrganization(fixture.organizationId);
    expect(publicList.some((b) => b.propertyId === inactivePropertyId)).toBe(false);

    const adminList = await fixture.repo.listBranchesForOrganizationAdmin(fixture.organizationId);
    expect(adminList.some((b) => b.propertyId === inactivePropertyId)).toBe(true);
  });

  it("updateBranchDetail edita teléfono/dirección/coordenadas/slug real", async () => {
    const fixture = buildRestaurantFixture();
    const updated = await fixture.repo.updateBranchDetail(fixture.organizationId, fixture.propertyId, { phone: "+529990000000", address: "Nueva dirección 123" });
    expect(updated?.phone).toBe("+529990000000");
    expect(updated?.address).toBe("Nueva dirección 123");
    expect(updated?.slug).toBe("fco-montejo"); // no tocado
  });

  it("updateBranchDetail sobre una sucursal de OTRA organización -> null", async () => {
    const fixture = buildRestaurantFixture();
    const otherOrgId = randomUUID();
    const result = await fixture.repo.updateBranchDetail(otherOrgId, fixture.propertyId, { phone: "9999999999" });
    expect(result).toBeNull();
  });
});

describe("Pedidos — listado/filtro/paginación + cambio de estado real", () => {
  it("filtra por status real", async () => {
    const fixture = buildRestaurantFixture();
    const orderA = await createOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Hugo",
      customerPhone: "9990003333",
      customerAddress: "Calle 1",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
      source: "web",
    });
    await fixture.repo.updateOrderStatus(fixture.organizationId, orderA.id, "pending", "preparando");

    const pendingPage = await fixture.repo.listOrders(fixture.organizationId, { propertyIds: null, status: "pending", limit: 10 });
    expect(pendingPage.orders.some((o) => o.id === orderA.id)).toBe(false);

    const preparandoPage = await fixture.repo.listOrders(fixture.organizationId, { propertyIds: null, status: "preparando", limit: 10 });
    expect(preparandoPage.orders.some((o) => o.id === orderA.id)).toBe(true);
  });

  it("pagina con cursor de forma determinística (sin duplicados ni huecos)", async () => {
    const fixture = buildRestaurantFixture();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const order = await createOrder(fixture.repo, {
        organizationId: fixture.organizationId,
        branchSlug: "fco-montejo",
        customerName: `Cliente ${i}`,
        customerPhone: `99900040${i}`,
        customerAddress: "Calle 1",
        items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
        source: "web",
      });
      ids.push(order.id);
    }

    const page1 = await fixture.repo.listOrders(fixture.organizationId, { propertyIds: null, limit: 2 });
    expect(page1.orders).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await fixture.repo.listOrders(fixture.organizationId, { propertyIds: null, limit: 2, cursor: page1.nextCursor! });
    expect(page2.orders).toHaveLength(2);

    const page3 = await fixture.repo.listOrders(fixture.organizationId, { propertyIds: null, limit: 2, cursor: page2.nextCursor! });
    expect(page3.orders.length).toBeGreaterThanOrEqual(1);
    expect(page3.nextCursor).toBeNull();

    const allSeenIds = [...page1.orders, ...page2.orders, ...page3.orders].map((o) => o.id);
    expect(new Set(allSeenIds).size).toBe(allSeenIds.length); // sin duplicados
    expect(allSeenIds.sort()).toEqual(ids.sort()); // sin huecos
  });

  it("filtra por rango de fechas (historial)", async () => {
    const fixture = buildRestaurantFixture();
    const order = await createOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Iker",
      customerPhone: "9990005555",
      customerAddress: "Calle 1",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
      source: "web",
    });

    const withinRange = await fixture.repo.listOrders(fixture.organizationId, {
      propertyIds: null,
      dateFrom: new Date(Date.now() - 60_000),
      dateTo: new Date(Date.now() + 60_000),
      limit: 10,
    });
    expect(withinRange.orders.some((o) => o.id === order.id)).toBe(true);

    const outsideRange = await fixture.repo.listOrders(fixture.organizationId, {
      propertyIds: null,
      dateFrom: new Date(Date.now() - 120_000),
      dateTo: new Date(Date.now() - 60_000),
      limit: 10,
    });
    expect(outsideRange.orders.some((o) => o.id === order.id)).toBe(false);
  });

  it("updateOrderStatus sobre un pedido de OTRA organización -> null (nunca lo toca)", async () => {
    const fixture = buildRestaurantFixture();
    const order = await createOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Juana",
      customerPhone: "9990006666",
      customerAddress: "Calle 1",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
      source: "web",
    });
    const otherOrgId = randomUUID();
    const result = await fixture.repo.updateOrderStatus(otherOrgId, order.id, "pending", "preparando");
    expect(result).toBeNull();
    const reread = await fixture.repo.findOrderById(fixture.organizationId, order.id);
    expect(reread?.status).toBe("pending");
  });
});

describe("Clientes — listado/búsqueda/paginación de administración", () => {
  it("búsqueda por nombre o teléfono, insensible a mayúsculas en el nombre", async () => {
    const fixture = buildRestaurantFixture();
    await fixture.repo.upsertCustomer(fixture.organizationId, "9997778888", "Karla Pérez");
    await fixture.repo.upsertCustomer(fixture.organizationId, "9991112222", "Luis Gómez");

    const byName = await fixture.repo.listCustomers(fixture.organizationId, { search: "karla", limit: 10 });
    expect(byName.customers).toHaveLength(1);
    expect(byName.customers[0]?.name).toBe("Karla Pérez");

    const byPhone = await fixture.repo.listCustomers(fixture.organizationId, { search: "9991112222", limit: 10 });
    expect(byPhone.customers).toHaveLength(1);
    expect(byPhone.customers[0]?.name).toBe("Luis Gómez");
  });

  it("pagina con cursor de forma determinística", async () => {
    const fixture = buildRestaurantFixture();
    for (let i = 0; i < 5; i += 1) {
      await fixture.repo.upsertCustomer(fixture.organizationId, `999000${i}0000`, `Cliente ${i}`);
    }
    const page1 = await fixture.repo.listCustomers(fixture.organizationId, { limit: 2 });
    expect(page1.customers).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await fixture.repo.listCustomers(fixture.organizationId, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.customers.every((c) => !page1.customers.some((p) => p.id === c.id))).toBe(true); // sin duplicados
  });

  it("nunca lista clientes de otra organización", async () => {
    const fixture = buildRestaurantFixture();
    const otherOrgId = randomUUID();
    await fixture.repo.upsertCustomer(otherOrgId, "9994443333", "Cliente ajeno");
    const page = await fixture.repo.listCustomers(fixture.organizationId, { limit: 50 });
    expect(page.customers.some((c) => c.name === "Cliente ajeno")).toBe(false);
  });

  it("findCustomerById nunca devuelve un cliente de otra organización", async () => {
    const fixture = buildRestaurantFixture();
    const otherOrgId = randomUUID();
    const other = await fixture.repo.upsertCustomer(otherOrgId, "9998889999", "Cliente ajeno");
    expect(await fixture.repo.findCustomerById(fixture.organizationId, other.id)).toBeNull();
  });
});
