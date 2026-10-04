// D-32 -- cliente y helpers de honorarios (puros): porcentajes en puntos base sin flotantes, errores por campo, cuerpo de la iguala y validacion de la cancelacion.
import { describe, expect, it, vi } from "vitest";
import {
  FORMULARIO_IGUALA_VACIO,
  bpAPorcentaje,
  cancelarPrefactura,
  cuerpoIguala,
  erroresIguala,
  errorCancelacion,
  fetchPrefacturas,
  formularioDesdeIguala,
  generarPrefacturas,
  porcentajeABp,
} from "../src/verticals/despachos/lib/honorarios-client.ts";
import { centavosAPesos, pesosACentavos } from "../src/verticals/despachos/lib/libro-client.ts";

const U = "11111111-1111-4111-8111-111111111111";

describe("porcentajeABp / bpAPorcentaje", () => {
  it("convierte sin flotantes y rechaza lo fuera de rango", () => {
    expect(porcentajeABp("0")).toBe(0);
    expect(porcentajeABp("10")).toBe(1000);
    expect(porcentajeABp("10.5")).toBe(1050);
    expect(porcentajeABp("1.25")).toBe(125);
    expect(porcentajeABp("35")).toBe(3500);
    for (const malo of ["", "36", "35.01", "-1", "1,5", "abc", "10.555", "100"]) expect(porcentajeABp(malo), malo).toBeNull();
  });
  it("ida y vuelta", () => {
    for (const bp of [0, 125, 1000, 1050, 3500]) expect(porcentajeABp(bpAPorcentaje(bp))).toBe(bp);
  });
});

describe("formulario de iguala", () => {
  const ok = { ...FORMULARIO_IGUALA_VACIO, concepto: "Iguala contable", montoPesos: "2,500.00" };
  it("sin errores y cuerpo en centavos enteros", () => {
    expect(erroresIguala(ok, pesosACentavos)).toEqual({});
    expect(cuerpoIguala({ ...ok, retencionIsrPorcentaje: "10", retieneIvaDosTercios: true, usoCfdi: "g03" }, pesosACentavos)).toEqual({
      concepto: "Iguala contable", montoBaseCentavos: 250_000, tasaIvaBp: 1600, retencionIsrBp: 1000, retieneIvaDosTercios: true, diaEmision: 1, usoCfdi: "G03", claveProdServ: "84111500", claveUnidad: "E48", activa: true,
    });
  });
  it("un error por campo y el monto con mas de 2 decimales se rechaza (nunca se redondea)", () => {
    const e = erroresIguala({ ...FORMULARIO_IGUALA_VACIO, concepto: "ab", montoPesos: "10.555", diaEmision: "29", retencionIsrPorcentaje: "50", usoCfdi: "zz", claveProdServ: "123", claveUnidad: "" }, pesosACentavos);
    expect(Object.keys(e).sort()).toEqual(["claveProdServ", "claveUnidad", "concepto", "diaEmision", "montoPesos", "retencionIsrPorcentaje", "usoCfdi"]);
  });
  it("editar vuelve a poner los valores del servidor en el formulario", () => {
    const f = formularioDesdeIguala({ id: "i", concepto: "X Y Z", claveProdServ: "84111500", claveUnidad: "E48", claveSatEstado: "por_verificar", montoBaseCentavos: 123_456, tasaIvaBp: 800, retencionIsrBp: 1050, retieneIvaDosTercios: true, periodicidad: "mensual", diaEmision: 7, usoCfdi: "G03", activa: false }, centavosAPesos);
    expect(f).toMatchObject({ montoPesos: "1,234.56", tasaIvaBp: "800", retencionIsrPorcentaje: "10.5", retieneIvaDosTercios: true, diaEmision: "7", activa: false });
  });
});

describe("errorCancelacion", () => {
  it("motivo 01-04; el 01 exige UUID; los demas no admiten folio", () => {
    expect(errorCancelacion("", "")).not.toBeNull();
    expect(errorCancelacion("05", "")).not.toBeNull();
    expect(errorCancelacion("01", "")).not.toBeNull();
    expect(errorCancelacion("01", "no-uuid")).not.toBeNull();
    expect(errorCancelacion("01", U)).toBeNull();
    expect(errorCancelacion("02", U)).not.toBeNull();
    for (const m of ["02", "03", "04"]) expect(errorCancelacion(m, "")).toBeNull();
  });
});

describe("llamadas HTTP", () => {
  const respuesta = (cuerpo: unknown) => vi.fn(async () => ({ ok: true, status: 200, json: async () => cuerpo }) as unknown as Response);
  it("lista, genera y cancela con las rutas y cuerpos del servidor", async () => {
    const f = respuesta({ ok: true });
    await fetchPrefacturas(f as unknown as typeof fetch, "https://api.test", "tok", "p1", "2026-07");
    await generarPrefacturas(f as unknown as typeof fetch, "https://api.test", "tok", "p1", "2026-07");
    await cancelarPrefactura(f as unknown as typeof fetch, "https://api.test", "tok", "p1", "f1", "01", U);
    await cancelarPrefactura(f as unknown as typeof fetch, "https://api.test", "tok", "p1", "f1", "02", null);
    const llamadas = f.mock.calls as unknown as [string, RequestInit | undefined][];
    expect(llamadas[0]![0]).toBe("https://api.test/despachos/p1/honorarios/prefacturas?periodo=2026-07");
    expect(llamadas[1]![0]).toBe("https://api.test/despachos/p1/honorarios/generar-prefacturas?periodo=2026-07");
    expect(llamadas[1]![1]?.method).toBe("POST");
    expect(JSON.parse(String(llamadas[2]![1]?.body))).toEqual({ motivo: "01", folioSustitucion: U });
    expect(JSON.parse(String(llamadas[3]![1]?.body))).toEqual({ motivo: "02" });
  });
});
