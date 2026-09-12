// Test de integración end-to-end de Fase 5 (back-office CORE): "staff da de alta un
// producto nuevo -> lo activa en una sucursal -> un cliente real lo pide -> el
// staff avanza el pedido por sus estados reales -> el staff lo consulta en el
// historial y en la ficha del cliente". Ejercita, sobre el MISMO repositorio en
// memoria (sin mocks de lógica de negocio), exactamente las piezas que las rutas
// HTTP nuevas (admin-catalog.ts/admin-orders.ts/admin-customers.ts) orquestan por
// separado — mismo espíritu que pedido-cliente-flow.spec.ts (Fase 1).
import { describe, expect, it } from "vitest";
import { createOrder } from "../../src/orders.ts";
import { getCustomerDetailById } from "../../src/customers.ts";
import { changeOrderStatus } from "../../src/order-lifecycle.ts";
import { buildRestaurantFixture } from "../fixtures.ts";
import type { CreateOrderInput } from "../../src/types.ts";

describe("Flujo real: alta de producto -> pedido -> ciclo de vida -> historial/ficha de cliente", () => {
  it("un producto recién creado no es pedible hasta activarse en la sucursal, y una vez activo sigue el ciclo completo", async () => {
    const fixture = buildRestaurantFixture();

    // 1) Staff crea una categoría y un producto nuevo — organization-wide, todavía
    // sin precio/disponibilidad en NINGUNA sucursal.
    const categoria = await fixture.repo.createCategory(fixture.organizationId, { name: "Postres", slug: "postres" });
    const producto = await fixture.repo.createProduct(fixture.organizationId, { name: "Flan Napolitano", price: 55, categoryId: categoria.id });

    // 2) Mientras no se active en la sucursal, NUNCA aparece en el catálogo real de
    // pedido — createOrder debe rechazarlo igual que un producto inexistente.
    const intentoPrematuro: CreateOrderInput = {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Cliente impaciente",
      customerPhone: "9990009999",
      customerAddress: "Calle 1",
      items: [{ productId: producto.id, requestedQuantity: 1 }],
      source: "web",
    };
    await expect(createOrder(fixture.repo, intentoPrematuro)).rejects.toThrow(/no disponible/i);

    // 3) Staff lo activa en la sucursal con precio propio.
    await fixture.repo.upsertBranchProductState(fixture.propertyId, producto.id, 60, true);

    // 4) Un cliente real lo pide — el precio SIEMPRE sale de branch_products (60), no
    // del precio base del producto (55).
    const order = await createOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Rosa",
      customerPhone: "9990001234",
      customerAddress: "Calle 45 #12",
      items: [{ productId: producto.id, requestedQuantity: 2 }],
      source: "web",
    });
    expect(order.total).toBe(120); // 2 * 60, nunca 2 * 55
    expect(order.status).toBe("pending");

    // 5) Staff avanza el pedido por su ciclo de vida real, un paso a la vez.
    const preparando = await changeOrderStatus(fixture.repo, fixture.organizationId, order, "preparando");
    const enCamino = await changeOrderStatus(fixture.repo, fixture.organizationId, preparando, "en_camino");
    const entregado = await changeOrderStatus(fixture.repo, fixture.organizationId, enCamino, "entregado");
    const completado = await changeOrderStatus(fixture.repo, fixture.organizationId, entregado, "completado");
    expect(completado.status).toBe("completado");

    // 6) Historial de administración: el pedido completado aparece filtrando por
    // status real, y la ficha del cliente ya refleja el pedido en su conteo.
    const historial = await fixture.repo.listOrders(fixture.organizationId, { propertyIds: null, status: "completado", limit: 10 });
    expect(historial.orders.some((o) => o.id === order.id)).toBe(true);

    const customer = await fixture.repo.findCustomerByPhone(fixture.organizationId, "9990001234");
    const ficha = await getCustomerDetailById(fixture.repo, fixture.organizationId, customer!.id);
    expect(ficha?.isNew).toBe(false);
    if (ficha?.isNew === false) {
      expect(ficha.orderCount).toBe(1);
      expect(ficha.frequentItems[0]).toMatchObject({ name: "Flan Napolitano", quantity: 2 });
    }
  });
});
