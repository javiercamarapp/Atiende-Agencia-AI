// H-06 -- helpers puros del cliente de grupos: pesos -> centavos ENTEROS (sin flotantes), descuento en puntos base, total
// con el mismo redondeo que la migracion 036, noches, liberacion y botones por estado/rol.
import { describe, expect, it } from "vitest";
import {
  accionesCotizacion,
  brutoCentavos,
  describirLiberacion,
  diasParaLiberacion,
  formatearCentavos,
  nochesEntre,
  pesosACentavos,
  porcentajeABps,
  totalConDescuento,
} from "../src/verticals/hoteles/lib/grupos-client.ts";

describe("pesosACentavos", () => {
  it("convierte sin flotantes: 1500, 1,500.50, $99.9, 0.07", () => {
    expect(pesosACentavos("1500")).toBe(150_000);
    expect(pesosACentavos("1,500.50")).toBe(150_050);
    expect(pesosACentavos("$99.9")).toBe(9_990);
    expect(pesosACentavos("0.07")).toBe(7);
    expect(pesosACentavos("  250  ")).toBe(25_000);
    // 19.99 * 100 = 1998.9999999999998 con flotantes: aqui es exacto
    expect(pesosACentavos("19.99")).toBe(1_999);
    expect(pesosACentavos("1.15")).toBe(115);
  });
  it("rechaza mas de 2 decimales, negativos, vacio y texto (nunca redondea en silencio)", () => {
    for (const bad of ["1.234", "-5", "", "abc", "1e3", "1.", ".5", "1,5,5x"]) expect(pesosACentavos(bad), bad).toBeNull();
  });
});

describe("porcentajeABps", () => {
  it("10 % = 1000 bps, 12.5 % = 1250, 0 y 100 son los extremos", () => {
    expect(porcentajeABps("10")).toBe(1000);
    expect(porcentajeABps("12.5")).toBe(1250);
    expect(porcentajeABps("0")).toBe(0);
    expect(porcentajeABps("100")).toBe(10_000);
    expect(porcentajeABps("0.01")).toBe(1);
  });
  it("rechaza mas de 100 %, 3 decimales, negativos y texto", () => {
    for (const bad of ["100.01", "101", "1.234", "-1", "", "diez"]) expect(porcentajeABps(bad), bad).toBeNull();
  });
});

describe("total", () => {
  it("bruto = cuartos x noches x tarifa y total half-up igual que la base (33333 con 0.01 % = 33330)", () => {
    expect(brutoCentavos([{ cuartos: 5, tarifaCentavos: 150_000 }], 3)).toBe(2_250_000);
    expect(totalConDescuento(2_250_000, 1000)).toBe(2_025_000);
    expect(totalConDescuento(33_333, 1)).toBe(33_330);
    expect(totalConDescuento(5, 1000)).toBe(5); // 4.5 -> 5
    expect(totalConDescuento(5, 3000)).toBe(4); // 3.5 -> 4
    expect(totalConDescuento(100, 0)).toBe(100);
    expect(totalConDescuento(100, 10_000)).toBe(0);
  });
});

describe("fechas y liberacion", () => {
  it("noches y dias para el cutoff", () => {
    expect(nochesEntre("2031-06-12", "2031-06-15")).toBe(3);
    expect(nochesEntre("2031-06-15", "2031-06-12")).toBe(0);
    expect(nochesEntre("x", "2031-06-12")).toBe(0);
    expect(diasParaLiberacion("2031-06-05", "2031-06-02")).toBe(3);
    expect(diasParaLiberacion("2031-06-05", "2031-06-06")).toBe(-1);
  });
  it("describe la liberacion segun estado y cercania", () => {
    const b = { estado: "activo", fechaLiberacion: "2031-06-05", tipoLiberacion: null } as const;
    expect(describirLiberacion(b, "2031-06-05")).toBe("Se libera hoy");
    expect(describirLiberacion(b, "2031-06-04")).toBe("Se libera mañana");
    expect(describirLiberacion(b, "2031-06-01")).toBe("Se libera en 4 días");
    expect(describirLiberacion(b, "2031-06-09")).toMatch(/Venció el 2031-06-05/);
    expect(describirLiberacion({ estado: "liberado", fechaLiberacion: "2031-06-05", tipoLiberacion: "cutoff" }, "2031-06-09")).toBe("Liberado (Por fecha de liberación)");
  });
});

describe("accionesCotizacion", () => {
  const base = { anticipoRegistradoCentavos: 0, totalCentavos: 1000 };
  it("borrador y enviada solo para quien gestiona; el anticipo solo para owner/gm/accountant y mientras falte saldo", () => {
    expect(accionesCotizacion({ ...base, estado: "borrador" }, "reservations")).toEqual(["enviar", "cancelar"]);
    expect(accionesCotizacion({ ...base, estado: "enviada" }, "owner")).toEqual(["aceptar", "rechazar", "cancelar"]);
    expect(accionesCotizacion({ ...base, estado: "enviada" }, "frontdesk")).toEqual([]);
    expect(accionesCotizacion({ ...base, estado: "aceptada" }, "accountant")).toEqual(["anticipo"]);
    expect(accionesCotizacion({ ...base, estado: "aceptada" }, "reservations")).toEqual([]);
    expect(accionesCotizacion({ estado: "aceptada", anticipoRegistradoCentavos: 1000, totalCentavos: 1000 }, "owner")).toEqual([]);
    expect(accionesCotizacion({ ...base, estado: "vencida" }, "owner")).toEqual([]);
  });
});

describe("formatearCentavos", () => {
  it("formatea MXN y nulos", () => {
    expect(formatearCentavos(123_450)).toMatch(/1,234\.50/);
    expect(formatearCentavos(null)).toBe("—");
  });
});
