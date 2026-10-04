// Pruebas de `create-order-core.test.ts` del original (ORIG/supabase/functions/_shared/) que NO tenian equivalente en
// main: memoria del cliente, errores que impiden crear el pedido, huella de dedupe y rechazo de payloads abusivos.
// El resto de esa suite esta citada en README.md (T-RD11.., T-AM.., X24, X49, product-search.spec.ts...).
import { describe, expect, it, vi } from "vitest";
import { OrderValidationError } from "../../src/errors.ts";
import { createOrder } from "../../src/orders.ts";
import { lookupCustomer } from "../../src/customers.ts";
import { item, pedido, pmFixture } from "./fixture.ts";
import type { CreateOrderInput } from "../../src/types.ts";

describe("create-order-core.test.ts:271 / :282 -- memoria del cliente y errores previos al pedido", () => {
  it("original :271: pedidos concurrentes del mismo cliente conservan el conteo exacto y la direccion mas usada queda por defecto", async () => {
    const f = pmFixture();
    const casa = "Calle 7 #210 x 20 y 22, Vista Alegre";
    const oficina = "Calle 60 #500, Centro";
    await Promise.all([1, 2, 3].map((q) => createOrder(f.repo, pedido(f, [item(f.p.cocaCola, q)], { customerPhone: "9996660001", customerAddress: casa }))));
    await createOrder(f.repo, pedido(f, [item(f.p.cocaCola, 4)], { customerPhone: "9996660001", customerAddress: oficina }));
    const cliente = await lookupCustomer(f.repo, f.organizationId, "9996660001");
    if (cliente.isNew) throw new Error("esperaba cliente conocido");
    expect(cliente.orderCount).toBe(4);
    expect(cliente.addresses.find((a) => a.isDefault)?.address).toBe(casa);
  });

  it("original :282: si fallan la busqueda del cliente, el conteo de direcciones o su escritura, NO se crea el pedido", async () => {
    for (const metodo of ["upsertCustomer", "addCustomerAddressIfNew"] as const) {
      const f = pmFixture();
      const crear = vi.spyOn(f.repo, "createOrderIdempotent");
      vi.spyOn(f.repo, metodo).mockRejectedValue(new Error(`${metodo} fallo`));
      await expect(createOrder(f.repo, pedido(f, [item(f.p.cocaCola, 1)]))).rejects.toThrow(`${metodo} fallo`);
      expect(crear, metodo).not.toHaveBeenCalled();
    }
  });
});

describe("create-order-core.test.ts:320 / :349 -- huella de dedupe", () => {
  it("original :320: pedidos canonicamente identicos (quantity vs requestedQuantity, renglones en otro orden) son UN solo pedido", async () => {
    const f = pmFixture();
    const a = await createOrder(f.repo, pedido(f, [{ productId: f.p.cocaCola, quantity: 2 }, { productId: f.p.guacamole, quantity: 1 }], { customerPhone: "9996660002" }));
    const b = await createOrder(f.repo, pedido(f, [{ productId: f.p.guacamole, requestedQuantity: 1 }, { productId: f.p.cocaCola, requestedQuantity: 2 }], { customerPhone: "9996660002" }));
    expect(b.id).toBe(a.id);
    const cliente = await f.repo.findCustomerByPhone(f.organizationId, "9996660002");
    expect(cliente?.orderCount).toBe(1);
  });

  it("original :349: un cambio material (cantidad, notas, direccion) cambia la huella y crea otro pedido; la MISMA llave de reintento sigue siendo estable", async () => {
    const f = pmFixture();
    const base: Partial<CreateOrderInput> = { customerPhone: "9996660003", idempotencyKey: "k-original-349" };
    const a = await createOrder(f.repo, pedido(f, [item(f.p.cocaCola, 2)], base));
    const reintento = await createOrder(f.repo, pedido(f, [item(f.p.cocaCola, 2)], base));
    expect(reintento.id).toBe(a.id);
    for (const [i, cambio] of [{ items: [item(f.p.cocaCola, 3)] }, { notes: "sin hielo" }, { customerAddress: "Calle 9 #1, Centro" }].entries()) {
      const input = pedido(f, [item(f.p.cocaCola, 2)], { customerPhone: "9996660003", ...cambio });
      const otro = await createOrder(f.repo, { ...input, items: (cambio as { items?: CreateOrderInput["items"] }).items ?? input.items });
      expect(otro.id, `cambio ${i}`).not.toBe(a.id);
    }
  });
});

describe("create-order-core.test.ts:540 / :545 / :554 -- payloads abusivos", () => {
  const rechaza = async (f: ReturnType<typeof pmFixture>, input: unknown) => {
    const crear = vi.spyOn(f.repo, "createOrderIdempotent");
    await expect(createOrder(f.repo, input as CreateOrderInput)).rejects.toBeInstanceOf(OrderValidationError);
    expect(crear).not.toHaveBeenCalled();
  };

  it("original :540: un payload que no es objeto, o sin identidad (sucursal, nombre, telefono), se rechaza", async () => {
    const f = pmFixture();
    await rechaza(f, null);
    await rechaza(f, "texto");
    await rechaza(f, pedido(f, [item(f.p.cocaCola, 1)], { customerName: "  " }));
    await rechaza(f, pedido(f, [item(f.p.cocaCola, 1)], { customerPhone: "" }));
    await rechaza(f, pedido(f, [item(f.p.cocaCola, 1)], { branchSlug: "" }));
  });

  it("original :545: los campos controlados por el cliente tienen tope de tamano", async () => {
    const f = pmFixture();
    await rechaza(f, pedido(f, [item(f.p.cocaCola, 1)], { customerName: "x".repeat(161) }));
    await rechaza(f, pedido(f, [item(f.p.cocaCola, 1)], { notes: "x".repeat(2001) }));
    await rechaza(f, pedido(f, [item(f.p.cocaCola, 1)], { customerAddress: "x".repeat(1001) }));
    await rechaza(f, pedido(f, [item(f.p.cocaCola, 1)], { customerPhone: "9".repeat(65) }));
  });

  it("original :554: demasiados renglones o cantidades fuera de 1-100 se rechazan", async () => {
    const f = pmFixture();
    await rechaza(f, pedido(f, Array.from({ length: 101 }, () => item(f.p.cocaCola, 1))));
    await rechaza(f, pedido(f, [item(f.p.cocaCola, 101)]));
    await rechaza(f, pedido(f, [item(f.p.cocaCola, 0)]));
  });
});
