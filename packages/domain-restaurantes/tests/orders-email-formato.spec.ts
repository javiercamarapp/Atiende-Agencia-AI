// El formato del correo del pedido (algo@dominio.tld, mismo criterio que el CHECK de restaurantes.orders.customer_email) se valida con una
// expresion LINEAL (sin backtracking ambiguo): una cadena adversarial de longitud maxima se rechaza al instante. Disponibilidad / defensa
// en profundidad: ninguna entrada acotada a 320 caracteres puede monopolizar el proceso.
import { describe, expect, it } from "vitest";
import { validateCreateOrderPayload } from "../src/orders.ts";
import type { CreateOrderInput } from "../src/types.ts";

const base = (customerEmail: string): CreateOrderInput => ({
  organizationId: "00000000-0000-4000-8000-0000000000b1",
  branchSlug: "fco-montejo",
  customerName: "Ana",
  customerPhone: "9995550101",
  customerAddress: "Calle 1 #100",
  items: [{ productId: "00000000-0000-4000-8000-0000000000c1", requestedQuantity: 1 }],
  source: "web",
  customerEmail,
});

describe("correo del pedido", () => {
  it.each(["ana@ejemplo.com", "ana+pedidos@sub.ejemplo.com.mx", "a@b.co"])("acepta %s", (correo) => {
    expect(validateCreateOrderPayload(base(correo)).customerEmail).toBe(correo);
  });

  it.each(["ana@ejemplo", "ana@b..co", "ana@.co", "ana @ejemplo.com", "ana@@ejemplo.com", "@ejemplo.com", "ana@ejemplo."])("rechaza %s", (correo) => {
    expect(() => validateCreateOrderPayload(base(correo))).toThrow(/customerEmail inválido/);
  });

  it("una cadena adversarial de longitud maxima (320) se rechaza en tiempo lineal", () => {
    const adversarial = `a@${"!.".repeat(158)}!`;
    expect(adversarial.length).toBeLessThanOrEqual(320);
    const inicio = performance.now();
    expect(() => validateCreateOrderPayload(base(adversarial))).toThrow(/customerEmail inválido/);
    expect(performance.now() - inicio).toBeLessThan(100);
  });
});
