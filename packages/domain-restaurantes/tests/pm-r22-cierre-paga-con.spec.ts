// PM R22 (causa 4 / R2): el resumen canonico imprimia «paga con $total» en vez del billete que dio el cliente (SIM 093, 341, NU-1).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { limpiarEntorno, prepararEntorno, setup } from "./support/cierre-r11.ts";

afterEach(limpiarEntorno);
beforeEach(() => prepararEntorno(true));

describe("R22: «paga con» muestra el billete del cliente", () => {
  it("el cliente dijo «Pagaré con $500» y el modelo mandó el total: el resumen dice $500", async () => {
    const s = setup();
    await s.quote({ payment_method: "efectivo", efectivo_con: undefined });
    const total = await s.total();
    s.cliente("Pagaré con $500");
    await s.quote({ payment_method: "efectivo", efectivo_con: total });
    const c = await s.canonico();
    expect(c).toContain("Pago: efectivo (paga con $500)");
    expect(c).not.toContain(`paga con $${total}`);
  });

  it("si el cliente no dio billete, no se inventa uno (sin «paga con» cuando el modelo tampoco lo manda)", async () => {
    const s = setup();
    s.cliente("Va en efectivo");
    await s.quote({ payment_method: "efectivo", efectivo_con: undefined });
    expect(await s.canonico()).not.toContain("paga con");
  });

  it("sin billete en el mensaje, se respeta el efectivo_con del modelo", async () => {
    const s = setup();
    s.cliente("Con efectivo");
    await s.quote({ payment_method: "efectivo", efectivo_con: 500 });
    expect(await s.canonico()).toContain("paga con $500");
  });
});
