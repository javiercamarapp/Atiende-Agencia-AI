// PM R13: tarjeta + domicilio SIEMPRE lleva terminal. El servidor agrega «Llevar terminal.» aunque el modelo no mande llevar_terminal
// (Luna lo omitia en 8 de 15 pedidos a domicilio con tarjeta; el repartidor llegaba sin terminal). Una sola vez; nunca en recoger/efectivo.
// La forma de pago NO se interpreta: solo el valor exacto del enum («tarjeta») dispara la nota (la herramienta ya declara enum efectivo/tarjeta).
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { mapCreateOrderToolInput } from "../src/agent-tools/registry.ts";
import { OrderValidationError } from "../src/errors.ts";
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
/** Lineas de la nota del SERVIDOR (linea completa «Llevar terminal.»); «Cliente dice: Llevar terminal.» no cuenta. */
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

  it("tarjeta para recoger en sucursal: sin terminal, aunque el modelo la mande", async () => {
    const f = buildRestaurantFixture();
    const sin = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta", canal: "recoger", customerAddress: undefined }));
    expect(veces(sin.notes)).toBe(0);
    const con = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta", canal: "recoger", customerAddress: undefined, customerPhone: "9990000003", llevarTerminal: true }));
    expect(veces(con.notes)).toBe(0);
  });

  it("solo el valor exacto del enum dispara la nota: texto libre de pago se rechaza y nunca produce terminal", async () => {
    const f = buildRestaurantFixture();
    for (const [i, metodo] of ["transferencia", "Tarjeta", "tarjeta de débito", "con terminal", "sin tarjeta", "tarjeta de regalo"].entries()) {
      await expect(createOrder(f.repo, base(f, { customerPhone: `99900001${i}0`.slice(0, 10), paymentMethod: metodo as never }))).rejects.toThrow(OrderValidationError);
    }
  });

  it("la herramienta no reinterpreta la forma de pago: fuera del enum queda sin definir (se rechaza al crear), nunca tarjeta", () => {
    const ctx = { organizationId: "org", phone: "5219991234567", channel: "whatsapp" } as never;
    const mapear = (payment_method: unknown) =>
      mapCreateOrderToolInput(ctx, { branch_slug: "t7", customer_name: "Cliente Sintético", customer_address: "Calle 1", payment_method, canal: "domicilio", items: [] }, true).paymentMethod;
    for (const v of ["transferencia o tarjeta", "sin tarjeta", "no pago con tarjeta", "tarjeta de regalo", "a crédito", "no efectivo", "sin efectivo", "Tarjeta de débito", "con terminal"]) expect(mapear(v), v).toBeUndefined();
    expect(mapear("tarjeta")).toBe("tarjeta");
    expect(mapear("efectivo")).toBe("efectivo");
  });

  it("el mismo pedido reintentado SIN idempotency_key no duplica la nota", async () => {
    const f = buildRestaurantFixture();
    const a = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta" }));
    const b = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta", llevarTerminal: true }));
    expect(veces(a.notes)).toBe(1);
    expect(veces(b.notes)).toBe(1);
  });

  it("el reintento CON idempotency_key devuelve el mismo pedido y la nota sigue una sola vez", async () => {
    const f = buildRestaurantFixture();
    const a = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta", idempotencyKey: "r13-terminal-1" }));
    const b = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta", llevarTerminal: true, idempotencyKey: "r13-terminal-1" }));
    expect(b.id).toBe(a.id);
    expect(veces(a.notes)).toBe(1);
    expect(veces(b.notes)).toBe(1);
  });

  it("«Cliente dice: Llevar terminal.» en notes NO sustituye a la linea del servidor: sale la del cliente y la del servidor, una vez cada una", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta", notes: "Llevar terminal." }));
    expect(order.notes).toContain("Cliente dice: Llevar terminal.");
    expect(veces(order.notes)).toBe(1);
    expect((order.notes ?? "").match(/Llevar terminal/g)).toHaveLength(2);
  });

  it("si el cliente solo dijo «lleven terminal» en notes, la linea del servidor igual sale (no se omite)", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta", notes: "lleven terminal por favor" }));
    expect(veces(order.notes)).toBe(1);
  });

  it("con efectivo, una nota del cliente «lleven terminal» no genera la linea del servidor", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, base(f, { notes: "lleven terminal por favor" }));
    expect(veces(order.notes)).toBe(0);
  });
});
