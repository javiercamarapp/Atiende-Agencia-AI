// cotizar_pedido real (Fase 2 §1.3) — `quoteOrder` es el wrapper nuevo que
// resuelve sucursal + renglones y delega la cotización real a
// `buildOrderQuoteFromProducts` (Fase 1, sin tocar una línea). Cubre lo que
// ES nuevo aquí: resolución de sucursal por slug y la guardia anti-
// alucinación de producto reutilizada — la aritmética de cotización en sí ya
// está cubierta exhaustivamente en order-quote.spec.ts.
import { describe, expect, it } from "vitest";
import { quoteOrder } from "../src/orders.ts";
import { OrderValidationError } from "../src/errors.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

describe("quoteOrder — wrapper real de cotizar_pedido", () => {
  it("cotiza contra el catálogo real de la sucursal (precio server-side, nunca inventado)", async () => {
    const fixture = buildRestaurantFixture();
    const quote = await quoteOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 2 }],
    });
    expect(quote.total).toBe(90);
    expect(quote.lines[0]!.price).toBe(45);
  });

  it("una sucursal inexistente se rechaza con un mensaje explícito, nunca cae a una sucursal default", async () => {
    const fixture = buildRestaurantFixture();
    await expect(
      quoteOrder(fixture.repo, { organizationId: fixture.organizationId, branchSlug: "sucursal-que-no-existe", items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }] }),
    ).rejects.toThrow(OrderValidationError);
  });

  it("no persiste NADA — dos cotizaciones del mismo pedido nunca crean un pedido real", async () => {
    const fixture = buildRestaurantFixture();
    await quoteOrder(fixture.repo, { organizationId: fixture.organizationId, branchSlug: "fco-montejo", items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }] });
    await quoteOrder(fixture.repo, { organizationId: fixture.organizationId, branchSlug: "fco-montejo", items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }] });
    const history = await fixture.repo.listEligibleOrderHistory("cualquier-id-nunca-existira");
    expect(history).toHaveLength(0);
  });

  it("propaga la guardia anti-alucinación de precio: un product_id fuera del catálogo real se rechaza", async () => {
    const fixture = buildRestaurantFixture();
    await expect(
      quoteOrder(fixture.repo, {
        organizationId: fixture.organizationId,
        branchSlug: "fco-montejo",
        items: [{ productId: "00000000-0000-4000-8000-000000000000", requestedQuantity: 1 }],
      }),
    ).rejects.toThrow(/no disponible/i);
  });

  it("exige confirmación explícita de mayoría de edad para alcohol, nunca la infiere", async () => {
    const fixture = buildRestaurantFixture();
    await expect(
      quoteOrder(fixture.repo, { organizationId: fixture.organizationId, branchSlug: "fco-montejo", items: [{ productId: fixture.products.cervezaSol, requestedQuantity: 1 }] }),
    ).rejects.toThrow(/mayor de edad/);

    const quote = await quoteOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      items: [{ productId: fixture.products.cervezaSol, requestedQuantity: 1 }],
      adultConfirmed: true,
    });
    expect(quote.containsAlcohol).toBe(true);
  });
});
