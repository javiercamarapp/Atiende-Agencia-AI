import { describe, expect, it } from "vitest";
import { createOrder, prepareCreateOrder } from "../src/orders.ts";
import { OrderConflictError, OrderValidationError } from "../src/errors.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { CreateOrderInput } from "../src/types.ts";

function baseInput(fixture: ReturnType<typeof buildRestaurantFixture>, overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    organizationId: fixture.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Cliente de Prueba",
    customerPhone: "9991234567",
    customerAddress: "Calle 50 #200",
    items: [{ productId: fixture.products.cocaCola, requestedQuantity: 2 }],
    source: "web",
    ...overrides,
  };
}

describe("prepareCreateOrder — re-cotización server-side, nunca confía en el cliente", () => {
  it("cotiza contra branch_products real, ignorando cualquier precio implícito del cliente", async () => {
    const fixture = buildRestaurantFixture();
    const prepared = await prepareCreateOrder(fixture.repo, baseInput(fixture));
    expect(prepared.total).toBe(90);
    expect(prepared.branch.propertyId).toBe(fixture.propertyId);
  });

  it("RECHAZA un producto que no existe en la sucursal en vez de inventar un precio", async () => {
    const fixture = buildRestaurantFixture();
    await expect(prepareCreateOrder(fixture.repo, baseInput(fixture, { items: [{ productId: "00000000-0000-1000-8000-000000000000", requestedQuantity: 1 }] }))).rejects.toThrow(
      OrderValidationError,
    );
  });

  it("RECHAZA una sucursal inexistente", async () => {
    const fixture = buildRestaurantFixture();
    await expect(prepareCreateOrder(fixture.repo, baseInput(fixture, { branchSlug: "no-existe" }))).rejects.toThrow(OrderValidationError);
  });

  it("exige dirección completa para pedidos de voz/whatsapp", async () => {
    const fixture = buildRestaurantFixture();
    await expect(prepareCreateOrder(fixture.repo, baseInput(fixture, { source: "whatsapp", customerAddress: undefined }))).rejects.toThrow(
      /dirección completa/,
    );
  });

  it("exige confirmación de mayoría de edad antes de crear un pedido con alcohol", async () => {
    const fixture = buildRestaurantFixture();
    await expect(
      prepareCreateOrder(fixture.repo, baseInput(fixture, { source: "whatsapp", items: [{ productId: fixture.products.cervezaSol, requestedQuantity: 1 }], paymentMethod: "efectivo" })),
    ).rejects.toThrow(/mayor de edad/);
  });
});

describe("createOrder — memoria de cliente + idempotencia de dos niveles", () => {
  it("crea al cliente si no existía e incrementa order_count", async () => {
    const fixture = buildRestaurantFixture();
    expect(await fixture.repo.findCustomerByPhone(fixture.organizationId, "9991234567")).toBeNull();

    const order = await createOrder(fixture.repo, baseInput(fixture));
    expect(order.status).toBe("pending");
    expect(order.total).toBe(90);

    const customer = await fixture.repo.findCustomerByPhone(fixture.organizationId, "9991234567");
    expect(customer?.orderCount).toBe(1);
  });

  it("un idempotencyKey repetido devuelve EXACTAMENTE el mismo pedido, nunca crea una segunda fila", async () => {
    const fixture = buildRestaurantFixture();
    const input = baseInput(fixture, { idempotencyKey: "intento-1" });
    const first = await createOrder(fixture.repo, input);
    const second = await createOrder(fixture.repo, input);
    expect(second.id).toBe(first.id);

    const customer = await fixture.repo.findCustomerByPhone(fixture.organizationId, "9991234567");
    expect(customer?.orderCount).toBe(1); // nunca se incrementó dos veces
  });

  it("dos intentos CASI simultáneos sin idempotencyKey explícito (mismo fingerprint) colapsan en un solo pedido pending (dedupe automático)", async () => {
    const fixture = buildRestaurantFixture();
    const input = baseInput(fixture);
    const [a, b] = await Promise.all([createOrder(fixture.repo, input), createOrder(fixture.repo, input)]);
    expect(a.id).toBe(b.id);

    const customer = await fixture.repo.findCustomerByPhone(fixture.organizationId, "9991234567");
    expect(customer?.orderCount).toBe(1);
  });

  // Port literal de "idempotency database conflicts are exposed as a typed order
  // conflict" (restaurantes/supabase/functions/_shared/create-order-core.test.ts:395):
  // reutilizar la misma idempotencyKey con un pedido de contenido MATERIALMENTE
  // distinto (otra cantidad, aquí, pero aplica igual a otra dirección/productos/total)
  // nunca debe devolver en silencio el pedido viejo — debe fallar como conflicto
  // tipado (409), igual que insertError?.code === "PT409" en el origen.
  it("una idempotencyKey reutilizada con contenido DISTINTO se expone como OrderConflictError, nunca devuelve el pedido viejo en silencio", async () => {
    const fixture = buildRestaurantFixture();
    const input = baseInput(fixture, { idempotencyKey: "intento-1" });
    const first = await createOrder(fixture.repo, input);

    const conflicting = baseInput(fixture, {
      idempotencyKey: "intento-1",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 5 }],
    });
    await expect(createOrder(fixture.repo, conflicting)).rejects.toThrow(OrderConflictError);

    // El pedido original nunca se sobreescribe ni se duplica silenciosamente.
    const customer = await fixture.repo.findCustomerByPhone(fixture.organizationId, "9991234567");
    expect(customer?.orderCount).toBe(1);
    expect(first.total).toBe(90);
  });

  it("dos pedidos con contenido DISTINTO del mismo cliente SÍ crean dos filas (el dedupe nunca bloquea intención real distinta)", async () => {
    const fixture = buildRestaurantFixture();
    const first = await createOrder(fixture.repo, baseInput(fixture));
    const second = await createOrder(fixture.repo, baseInput(fixture, { items: [{ productId: fixture.products.cocaCola, requestedQuantity: 5 }] }));
    expect(second.id).not.toBe(first.id);
  });

  it("guarda la dirección del cliente para reconocerlo después con esa dirección", async () => {
    const fixture = buildRestaurantFixture();
    await createOrder(fixture.repo, baseInput(fixture, { customerAddress: "Calle 50 #200, entre 45 y 47" }));
    const customer = await fixture.repo.findCustomerByPhone(fixture.organizationId, "9991234567");
    const addresses = await fixture.repo.listCustomerAddresses(customer!.id);
    expect(addresses).toHaveLength(1);
    expect(addresses[0]!.address).toBe("Calle 50 #200, entre 45 y 47");
    expect(addresses[0]!.isDefault).toBe(true);
  });
});
