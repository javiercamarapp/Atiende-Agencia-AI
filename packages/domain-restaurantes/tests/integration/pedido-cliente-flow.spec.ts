// Test de integración end-to-end del flujo real documentado de restaurantes (ver
// diseño Fase 1, tarea 5): "pedido nuevo -> cliente creado -> segunda consulta ->
// reconocido con dirección". Ejercita createOrder + lookupCustomer juntos, tal como
// los usarían las rutas Hono reales (public.ts::POST /orders y
// public.ts::POST /customers/lookup) sobre el MISMO repositorio — sin mocks de la
// lógica de negocio, solo el adaptador en memoria en vez de Postgres real (packages/db
// no tiene todavía motor de conexión, ver packages/db/README.md).
import { describe, expect, it } from "vitest";
import { createOrder } from "../../src/orders.ts";
import { lookupCustomer } from "../../src/customers.ts";
import { buildRestaurantFixture } from "../fixtures.ts";
import type { CreateOrderInput } from "../../src/types.ts";

describe("Flujo real: pedido nuevo -> cliente creado -> segunda consulta -> reconocido con dirección", () => {
  it("un cliente nunca visto se vuelve una memoria real y persistente tras su primer pedido", async () => {
    const fixture = buildRestaurantFixture();
    const phoneComoLoEscribióElCliente = "999 123 45 67"; // formato tecleado real en el checkout web
    const phoneComoLoTranscribióVoz = "+52 999 123 4567"; // mismo cliente, formato de voz distinto

    // 1) ANTES del primer pedido: buscar_cliente/customer-lookup debe decir "nuevo".
    const antes = await lookupCustomer(fixture.repo, fixture.organizationId, phoneComoLoEscribióElCliente);
    expect(antes).toEqual({ isNew: true });

    // 2) PEDIDO NUEVO — mismo flujo real de POST /orders: valida, re-cotiza contra
    // branch_products (nunca confía en un total del cliente), crea al cliente
    // (memoria por teléfono) y persiste su dirección de entrega.
    const input: CreateOrderInput = {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "María Fernanda",
      customerPhone: phoneComoLoEscribióElCliente,
      customerAddress: "Calle 21 #310 x 36 y 38, Col. México, Mérida",
      items: [
        { productId: fixture.products.tacosPastor, requestedQuantity: 3, tortilla: "maiz" },
        { productId: fixture.products.cocaCola, requestedQuantity: 1 },
      ],
      source: "web",
      paymentMethod: "efectivo",
    };
    const order = await createOrder(fixture.repo, input);

    expect(order.status).toBe("pending");
    // Precio SIEMPRE server-side: 1 orden de 3 tacos ($164) + 1 Coca-Cola ($45).
    expect(order.total).toBe(164 + 45);
    expect(order.customerId).not.toBeNull();

    // 3) CLIENTE CREADO — la memoria ya existe en restaurantes.customers (aquí, el
    // adaptador en memoria con las mismas reglas de unicidad que el UNIQUE real).
    const customer = await fixture.repo.findCustomerByPhone(fixture.organizationId, "9991234567");
    expect(customer).not.toBeNull();
    expect(customer!.name).toBe("María Fernanda");
    expect(customer!.orderCount).toBe(1);

    // 4) SEGUNDA CONSULTA — un canal DISTINTO (voz) la busca con un formato de
    // teléfono distinto al que se usó para crearla. Debe RECONOCERLA (normalización
    // compartida, ver phone.ts), no tratarla como cliente nueva.
    const segunda = await lookupCustomer(fixture.repo, fixture.organizationId, phoneComoLoTranscribióVoz);

    // 5) RECONOCIDO CON DIRECCIÓN — nombre, historial y la dirección real que dejó en
    // su primer pedido, lista para que el agente la ofrezca sin que el cliente tenga
    // que repetirla.
    expect(segunda.isNew).toBe(false);
    if (segunda.isNew) throw new Error("unreachable"); // narrowing para TS
    expect(segunda.name).toBe("María Fernanda");
    expect(segunda.orderCount).toBe(1);
    expect(segunda.addresses).toHaveLength(1);
    expect(segunda.addresses[0]).toMatchObject({ address: "Calle 21 #310 x 36 y 38, Col. México, Mérida", isDefault: true });
    expect(segunda.lastOrderItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Tacos de Bistec de Res (orden de 3)", quantity: 1 }),
        expect.objectContaining({ name: "Coca-Cola", quantity: 1 }),
      ]),
    );
  });

  it("un SEGUNDO pedido real del mismo cliente amplía frequent_items y lo hace elegible para '¿lo de siempre?'", async () => {
    const fixture = buildRestaurantFixture();
    const phone = "9998887766";

    await createOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Jorge",
      customerPhone: phone,
      customerAddress: "Calle 60 #500",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 2 }],
      source: "web",
    });
    await createOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Jorge",
      customerPhone: phone,
      customerAddress: "Calle 60 #500",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 3 }],
      source: "web",
    });

    const result = await lookupCustomer(fixture.repo, fixture.organizationId, phone);
    expect(result.isNew).toBe(false);
    if (result.isNew) throw new Error("unreachable");
    expect(result.orderCount).toBe(2);
    expect(result.frequentItems).toEqual([{ name: "Coca-Cola", quantity: 5 }]);
    expect(result.agentNotes.some((n) => /lo de siempre/i.test(n))).toBe(true);
  });
});
