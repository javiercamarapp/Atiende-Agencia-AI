// Formato y captura del contrato por cliente: dinero en centavos enteros, sin pasar por flotantes.
import { describe, expect, it } from "vitest";
import { bpAEditable, bpATexto, centavosAEditable, centavosAPesos, centavosATexto, fechaIsoATexto, mesActual, pesosACentavos, porcentajeABp } from "../src/superadmin/lib/contratos.ts";

describe("pesosACentavos", () => {
  it("convierte con aritmetica de cadenas: 19.99 -> 1999 (con flotantes daria 1998.9999999999998)", () => {
    expect(pesosACentavos("19.99")).toBe(1999);
    expect(pesosACentavos("0.29")).toBe(29);
    expect(pesosACentavos("1.1")).toBe(110);
    expect(pesosACentavos("5900")).toBe(590_000);
    expect(pesosACentavos("5,900.5")).toBe(590_050);
    expect(pesosACentavos("$3")).toBe(300);
    expect(pesosACentavos("0")).toBe(0);
  });

  it("rechaza vacio, negativos, mas de 2 decimales, letras y exponentes", () => {
    for (const malo of ["", "  ", "-1", "1.234", "abc", "1e5", "1.", ".5", "1,5,5", "9999999999"]) expect(pesosACentavos(malo), malo).toBeUndefined();
  });
});

describe("formato de montos", () => {
  it("centavosATexto con miles y siempre 2 decimales", () => {
    expect(centavosATexto(0)).toBe("0.00");
    expect(centavosATexto(5)).toBe("0.05");
    expect(centavosATexto(590_050)).toBe("5,900.50");
    expect(centavosATexto(123_456_789)).toBe("1,234,567.89");
  });

  it("centavosAPesos usa raya para null (nunca un 0 inventado)", () => {
    expect(centavosAPesos(null)).toBe("—");
    expect(centavosAPesos(1_390_000)).toBe("$13,900.00");
  });

  it("centavosAEditable ida y vuelta con pesosACentavos", () => {
    for (const c of [0, 1, 99, 100, 101, 590_000, 590_050, 1_999]) expect(pesosACentavos(centavosAEditable(c))).toBe(c);
    expect(centavosAEditable(590_000)).toBe("5900");
    expect(centavosAEditable(590_050)).toBe("5900.50");
  });
});

describe("descuento porcentual en puntos base", () => {
  it("12.5 % -> 1250 bp; vacio -> 0; mas de 100 o invalido -> undefined", () => {
    expect(porcentajeABp("12.5")).toBe(1250);
    expect(porcentajeABp("10%")).toBe(1000);
    expect(porcentajeABp("0.01")).toBe(1);
    expect(porcentajeABp("100")).toBe(10_000);
    expect(porcentajeABp("")).toBe(0);
    expect(porcentajeABp("100.01")).toBeUndefined();
    expect(porcentajeABp("-5")).toBeUndefined();
    expect(porcentajeABp("1.234")).toBeUndefined();
  });

  it("bpAEditable / bpATexto", () => {
    expect(bpAEditable(1250)).toBe("12.5");
    expect(bpAEditable(1205)).toBe("12.05");
    expect(bpAEditable(1000)).toBe("10");
    expect(bpAEditable(0)).toBe("");
    expect(bpATexto(0)).toBe("—");
    expect(bpATexto(1250)).toBe("12.5 %");
    for (const bp of [1, 50, 99, 100, 1250, 1205, 10_000]) expect(porcentajeABp(bpAEditable(bp))).toBe(bp);
  });
});

describe("fechas", () => {
  it("YYYY-MM-DD a dd/mm/yyyy sin corrimiento por zona horaria; null = sin fin", () => {
    expect(fechaIsoATexto("2026-10-01")).toBe("01/10/2026");
    expect(fechaIsoATexto("2026-12-31")).toBe("31/12/2026");
    expect(fechaIsoATexto(null)).toBe("sin fin");
  });

  it("mesActual en formato YYYY-MM", () => {
    expect(mesActual(new Date(2026, 9, 20))).toBe("2026-10");
    expect(mesActual(new Date(2026, 0, 1))).toBe("2026-01");
  });
});
