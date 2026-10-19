// PM R13: tarjeta + domicilio SIEMPRE lleva terminal. El servidor agrega «Llevar terminal.» aunque el modelo no mande llevar_terminal
// (Luna lo omitia en 8 de 15 pedidos a domicilio con tarjeta; el repartidor llegaba sin terminal). Idempotente; nunca en recoger/efectivo.
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { mapCreateOrderToolInput } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { CreateOrderInput } from "../src/types.ts";

function base(f: ReturnType<typeof buildRestaurantFixture>, o: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    organizationId: f.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Cliente Sintético",
    customerPhone: "9991234567",
    customerAddress: "Calle 50 #200",
    items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }],
    source: "whatsapp",
    paymentMethod: "efectivo",
    canal: "domicilio",
    ...o,
  };
}
const veces = (notas: string | null | undefined) => (notas ?? "").split("\n").filter((l) => /^Llevar terminal\.?$/i.test(l.trim())).length;

describe("terminal implicita: createOrder", () => {
  it.each(["whatsapp", "voice"] as const)("tarjeta + domicilio SIN llevar_terminal agrega la nota (%s)", async (source) => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, base(f, { source, paymentMethod: "tarjeta" }));
    expect(veces(order.notes)).toBe(1);
  });

  it("canal omitido (por omision es domicilio) con tarjeta lleva terminal", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta", canal: undefined }));
    expect(veces(order.notes)).toBe(1);
  });

  it.each(["whatsapp", "voice"] as const)("con llevar_terminal explicito la nota sale UNA sola vez (%s)", async (source) => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, base(f, { source, paymentMethod: "tarjeta", llevarTerminal: true }));
    expect(veces(order.notes)).toBe(1);
  });

  it("llevar_terminal false explicito con tarjeta a domicilio igual lleva terminal (politica operativa)", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta", llevarTerminal: false }));
    expect(veces(order.notes)).toBe(1);
  });

  it("efectivo a domicilio: sin terminal, aunque el modelo la mande", async () => {
    const f = buildRestaurantFixture();
    expect(veces((await createOrder(f.repo, base(f))).notes)).toBe(0);
    expect(veces((await createOrder(f.repo, base(f, { customerPhone: "9990000002", llevarTerminal: true }))).notes)).toBe(0);
  });

  it("tarjeta para recoger en sucursal: sin terminal", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta", canal: "recoger", customerAddress: undefined }));
    expect(veces(order.notes)).toBe(0);
  });

  it("el mismo pedido reintentado no duplica la nota (idempotente)", async () => {
    const f = buildRestaurantFixture();
    const a = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta" }));
    const b = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta", llevarTerminal: true }));
    expect(veces(a.notes)).toBe(1);
    expect(veces(b.notes)).toBe(1);
  });

  it("si el modelo ya puso «Llevar terminal.» en notes (sale como «Cliente dice: ...»), la linea del servidor sale una sola vez", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta", notes: "Llevar terminal." }));
    expect(veces(order.notes)).toBe(1);
  });
});

describe("terminal implicita: la herramienta crear_pedido normaliza la forma de pago", () => {
  const ctx = (channel: "whatsapp" | "voz") => ({ organizationId: "org", phone: "5219991234567", channel }) as never;
  const mapear = (payment_method: unknown, channel: "whatsapp" | "voz" = "whatsapp") =>
    mapCreateOrderToolInput(ctx(channel), { branch_slug: "t7", customer_name: "Cliente Sintético", customer_address: "Calle 1", payment_method, canal: "domicilio", items: [] }, true).paymentMethod;

  const TARJETA = [
    "tarjeta", "Tarjeta", "TARJETA", "tarjeta de débito", "tarjeta de debito", "Tarjeta de crédito", "tarjeta de credito",
    "con terminal", "pago con tarjeta", "con tarjeta", "débito", "debito", "crédito", "credito", "terminal", "pagar con tarjeta", "  tarjeta  ", "tarjeta debito",
  ];
  it.each(TARJETA)("«%s» es tarjeta", (v) => {
    expect(mapear(v)).toBe("tarjeta");
  });
  it.each(TARJETA.slice(0, 6))("«%s» es tarjeta tambien en voz", (v) => {
    expect(mapear(v, "voz")).toBe("tarjeta");
  });

  it.each(["efectivo", "Efectivo", "en efectivo", "pago en efectivo", "EFECTIVO"])("«%s» es efectivo", (v) => {
    expect(mapear(v)).toBe("efectivo");
  });

  it.each(["transferencia", "depósito", "", "cheque", "tarjeta o efectivo", 5, null, undefined])("%j no es tarjeta ni efectivo", (v) => {
    expect(mapear(v)).toBeUndefined();
  });

  it("de punta a punta: «tarjeta de débito» a domicilio sin llevar_terminal termina con la nota", async () => {
    const f = buildRestaurantFixture();
    const input = mapCreateOrderToolInput(
      { organizationId: f.organizationId, phone: "5219991234567", channel: "whatsapp" } as never,
      { branch_slug: "fco-montejo", customer_name: "Cliente Sintético", customer_address: "Calle 50 #200", payment_method: "tarjeta de débito", canal: "domicilio", items: [] },
      true,
    );
    const order = await createOrder(f.repo, { ...input, items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }] });
    expect(order.paymentMethod).toBe("tarjeta");
    expect(veces(order.notes)).toBe(1);
  });
});
