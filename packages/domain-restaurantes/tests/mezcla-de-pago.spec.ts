// Mezcla de pago y propinas (seccion 5.2): reparto por forma de pago, propinas solo con tarjeta, redondeo y casos limite.
import { describe, expect, it } from "vitest";
import { mezclaDePago } from "../src/mezcla-de-pago.ts";

describe("mezclaDePago", () => {
  it("reparte ventas por forma de pago con participacion y suma las propinas con tarjeta", () => {
    const m = mezclaDePago([
      { paymentMethod: "efectivo", total: 300, propina: null },
      { paymentMethod: "efectivo", total: 100, propina: null },
      { paymentMethod: "tarjeta", total: 500, propina: 50 },
      { paymentMethod: "tarjeta", total: 100, propina: 10.5 },
      { paymentMethod: "transferencia", total: 100, propina: null },
    ]);
    expect(m.totalPedidos).toBe(5);
    expect(m.totalVentas).toBe(1100);
    expect(m.lineas).toEqual([
      { forma: "efectivo", pedidos: 2, ventas: 400, participacion: 36.4 },
      { forma: "tarjeta", pedidos: 2, ventas: 600, participacion: 54.5 },
      { forma: "transferencia", pedidos: 1, ventas: 100, participacion: 9.1 },
    ]);
    expect(m.propinasTarjeta).toBe(60.5);
    expect(m.propinasOtrasFormas).toBe(0);
  });

  it("una forma desconocida o null cuenta como 'sin_dato' (no se inventa)", () => {
    const m = mezclaDePago([
      { paymentMethod: null, total: 80, propina: null },
      { paymentMethod: "cheque", total: 20, propina: null },
    ]);
    expect(m.lineas).toEqual([{ forma: "sin_dato", pedidos: 2, ventas: 100, participacion: 100 }]);
  });

  it("propina con una forma que no es tarjeta NO se mezcla con las de tarjeta: queda aparte para revisarla", () => {
    const m = mezclaDePago([
      { paymentMethod: "efectivo", total: 100, propina: 15 },
      { paymentMethod: "tarjeta", total: 100, propina: 10 },
    ]);
    expect(m.propinasTarjeta).toBe(10);
    expect(m.propinasOtrasFormas).toBe(15);
  });

  it("sin pedidos: todo en cero, sin lineas ni division entre cero", () => {
    expect(mezclaDePago([])).toEqual({ lineas: [], totalPedidos: 0, totalVentas: 0, propinasTarjeta: 0, propinasOtrasFormas: 0 });
  });

  it("ignora totales invalidos (negativos o no finitos) y propinas no positivas", () => {
    const m = mezclaDePago([
      { paymentMethod: "tarjeta", total: Number.NaN, propina: 5 },
      { paymentMethod: "tarjeta", total: -10, propina: 5 },
      { paymentMethod: "tarjeta", total: 200, propina: -3 },
    ]);
    expect(m.totalPedidos).toBe(1);
    expect(m.propinasTarjeta).toBe(0);
  });

  it("redondea a centavos sin acumular error de coma flotante", () => {
    const m = mezclaDePago(Array.from({ length: 10 }, () => ({ paymentMethod: "tarjeta", total: 0.1, propina: 0.1 })));
    expect(m.totalVentas).toBe(1);
    expect(m.propinasTarjeta).toBe(1);
  });
});
