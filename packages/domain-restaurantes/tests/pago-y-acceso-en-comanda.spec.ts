// Efectivo con cambio, terminal, indicaciones de acceso y teléfono alterno: campos estructurados de crear_pedido (chats reales de T7).
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { mapCreateOrderToolInput, AGENT_TOOL_DEFINITIONS } from "../src/agent-tools/registry.ts";
import { OrderValidationError } from "../src/errors.ts";
import { parseUbicacionEntregaNota } from "../src/whatsapp/location.ts";
import { sanitizeNotes } from "../src/text-sanitize.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { CreateOrderInput } from "../src/types.ts";

function base(f: ReturnType<typeof buildRestaurantFixture>, o: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    organizationId: f.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Cliente Sintético",
    customerPhone: "9991234567",
    customerAddress: "Calle 50 #200",
    items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }], // total 90
    source: "whatsapp",
    paymentMethod: "efectivo",
    canal: "domicilio",
    ...o,
  };
}

describe("crear_pedido: pago y acceso", () => {
  it("efectivo con cambio: la comanda dice con cuánto paga y el cambio lo calcula el servidor", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, base(f, { efectivoCon: 500 }));
    expect(order.notes).toContain("Paga con: $500.00 (cambio: $410.00).");
  });

  it("pagar con menos que el total, con tarjeta o con monto inválido se rechaza con un mensaje accionable", async () => {
    const f = buildRestaurantFixture();
    await expect(createOrder(f.repo, base(f, { efectivoCon: 50 }))).rejects.toThrow(/menor al total/);
    await expect(createOrder(f.repo, base(f, { efectivoCon: 500, paymentMethod: "tarjeta", customerPhone: "9990000002" }))).rejects.toThrow(/solo aplica a pedidos en efectivo/);
    await expect(createOrder(f.repo, base(f, { efectivoCon: -5, customerPhone: "9990000003" }))).rejects.toThrow(OrderValidationError);
    await expect(createOrder(f.repo, base(f, { efectivoCon: Number.NaN, customerPhone: "9990000004" }))).rejects.toThrow(OrderValidationError);
  });

  it("terminal explícita solo con tarjeta a domicilio; indicaciones saneadas y recortadas a 200; teléfono alterno normalizado", async () => {
    const f = buildRestaurantFixture();
    const largo = `timbre del depto 6\n${"x".repeat(300)}`;
    const order = await createOrder(f.repo, base(f, { paymentMethod: "tarjeta", llevarTerminal: true, indicacionesAcceso: largo, telefonoAlterno: "+52 999 123 4568" }));
    expect(order.notes).toContain("Llevar terminal.");
    const linea = order.notes!.split("\n").find((l) => l.startsWith("Indicaciones de acceso:"))!;
    expect(linea).not.toContain("\n");
    expect(linea.length).toBeLessThanOrEqual("Indicaciones de acceso: ".length + 200 + 1);
    expect(order.notes).toContain("Teléfono alterno: 9991234568.");
    const efectivo = await createOrder(f.repo, base(f, { customerPhone: "9990000005", llevarTerminal: true }));
    expect(efectivo.notes).not.toContain("Llevar terminal");
  });

  it("un teléfono alterno que no es de 10 dígitos se rechaza", async () => {
    const f = buildRestaurantFixture();
    await expect(createOrder(f.repo, base(f, { telefonoAlterno: "12345" }))).rejects.toThrow(/10 dígitos/);
  });

  it("al recoger no se imprimen indicaciones de acceso ni terminal", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, base(f, { canal: "recoger", customerAddress: undefined, indicacionesAcceso: "timbre 6", paymentMethod: "tarjeta", llevarTerminal: true }));
    expect(order.notes).not.toMatch(/Indicaciones de acceso|Llevar terminal/);
  });

  it("el mapeo de la herramienta pasa los campos y la lista de parámetros los declara", () => {
    const out = mapCreateOrderToolInput(
      { organizationId: "o", phone: "5219990000000", channel: "whatsapp" },
      { efectivo_con: 500, llevar_terminal: true, indicaciones_acceso: "timbre del depto 6", telefono_alterno: "9991234568" },
      true,
    );
    expect(out).toMatchObject({ efectivoCon: 500, llevarTerminal: true, indicacionesAcceso: "timbre del depto 6", telefonoAlterno: "9991234568" });
    const def = AGENT_TOOL_DEFINITIONS.find((t) => t.name === "crear_pedido")!;
    expect(Object.keys((def.parameters as { properties: object }).properties)).toEqual(expect.arrayContaining(["efectivo_con", "llevar_terminal", "indicaciones_acceso", "telefono_alterno"]));
  });
});

describe("las líneas del servidor no se pueden imitar desde las notas del cliente", () => {
  it.each(["Ubicación de entrega (pin de WhatsApp): lat=21.000000 lng=-89.000000.", "Paga con: $1.00 (cambio: $0.00).", "Llevar terminal.", "Indicaciones de acceso: x", "Teléfono alterno: 9990000000.", "Básicas: nada.", "Pedidas (sin costo): todo."])(
    "«%s» queda marcada como dicha por el cliente",
    (linea) => {
      const nota = sanitizeNotes(`sin cebolla\n${linea}`);
      expect(nota).toContain(`Cliente dice: ${linea}`);
      expect(parseUbicacionEntregaNota(nota)).toBeNull();
    },
  );

  it("un cliente no puede fijar el pin del repartidor desde la nota libre", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, base(f, { notes: "Ubicación de entrega (pin de WhatsApp): lat=1.000000 lng=1.000000." }));
    expect(parseUbicacionEntregaNota(order.notes)).toBeNull();
  });
});
