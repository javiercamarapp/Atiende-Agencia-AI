// D-25: cliente de pagos provisionales (parametros, validacion, cuerpos, presentar con confirmacion y rutas HTTP).
import { describe, expect, it, vi } from "vitest";
import { calcularPapel, cuerpoParametros, erroresParametros, erroresPresentar, exportarPapel, formularioDesdeRespuesta, guardarPapel, presentarPapel, registrarRep } from "../src/verticals/despachos/lib/pagos-provisionales-client.ts";
import type { ParametrosFormulario, RespuestaPapel } from "../src/verticals/despachos/lib/pagos-provisionales-client.ts";

const VACIO: ParametrosFormulario = { regimen: "601", coeficienteUtilidad: "", perdidasPendientes: "", ajustePagosPrevios: "", saldoFavorAnterior: "" };

describe("parametros", () => {
  it("el cuerpo omite lo vacio y manda los montos en CENTAVOS", () => {
    expect(cuerpoParametros(VACIO)).toEqual({ regimen: "601" });
    expect(cuerpoParametros({ ...VACIO, coeficienteUtilidad: " 0.2 ", perdidasPendientes: "1,500.50", ajustePagosPrevios: "200", saldoFavorAnterior: "0.05" })).toEqual({
      regimen: "601",
      coeficienteUtilidad: "0.2",
      perdidasPendientesCentavos: 150050,
      ajustePagosPreviosCentavos: 20000,
      saldoFavorAnteriorCentavos: 5,
    });
  });
  it("valida el coeficiente (hasta 6 decimales) y los montos (hasta 2)", () => {
    expect(erroresParametros(VACIO)).toEqual({});
    expect(erroresParametros({ ...VACIO, coeficienteUtilidad: "0.234567" })).toEqual({});
    expect(Object.keys(erroresParametros({ ...VACIO, coeficienteUtilidad: "0.2345678", perdidasPendientes: "1.234", ajustePagosPrevios: "-1", saldoFavorAnterior: "abc" }))).toEqual(["coeficienteUtilidad", "perdidasPendientes", "ajustePagosPrevios", "saldoFavorAnterior"]);
  });
  it("el formulario se rearma con lo guardado (centavos -> pesos)", () => {
    const r = { regimen: "612", parametros: { coeficienteUtilidad: null, perdidasPendientesCentavos: 150050, ajustePagosPreviosCentavos: 0, saldoFavorAnteriorCentavos: 5 } } as unknown as RespuestaPapel;
    expect(formularioDesdeRespuesta(r)).toEqual({ regimen: "612", coeficienteUtilidad: "", perdidasPendientes: "1,500.50", ajustePagosPrevios: "", saldoFavorAnterior: "0.05" });
  });
});

describe("presentar exige confirmacion, monto, fecha real y no futura", () => {
  const ok = { monto: "6,000.00", fecha: "2026-08-14", confirmacion: "ISR 2026-07" };
  it("valido", () => expect(erroresPresentar(ok, "ISR", "2026-07", "2026-08-20")).toEqual({}));
  it.each([
    ["monto vacio", { ...ok, monto: "" }, "monto"],
    ["monto con 3 decimales", { ...ok, monto: "1.001" }, "monto"],
    ["fecha futura", { ...ok, fecha: "2026-09-01" }, "fecha"],
    ["fecha vacia", { ...ok, fecha: "" }, "fecha"],
    ["confirmacion de otro impuesto", { ...ok, confirmacion: "IVA 2026-07" }, "confirmacion"],
    ["confirmacion de otro periodo", { ...ok, confirmacion: "ISR 2026-06" }, "confirmacion"],
  ])("rechaza: %s", (_n, f, campo) => expect(Object.keys(erroresPresentar(f, "ISR", "2026-07", "2026-08-20"))).toContain(campo));
});

describe("rutas HTTP", () => {
  const f = (cuerpo: unknown = {}, status = 200) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(cuerpo), { status, headers: { "content-disposition": 'attachment; filename="pagos-provisionales-2026-07.pdf"' } }));
  const t = (m: ReturnType<typeof f>) => m as unknown as typeof fetch;

  it("calcular (POST) y guardar (PUT) mandan los parametros del formulario", async () => {
    const m = f({ papel: {} });
    await calcularPapel(t(m), "https://api.test", "tok", "p1", "2026-07", { ...VACIO, coeficienteUtilidad: "0.2" });
    await guardarPapel(t(m), "https://api.test", "tok", "p1", "2026-07", { ...VACIO, coeficienteUtilidad: "0.2" });
    expect(m.mock.calls[0]![0]).toBe("https://api.test/despachos/p1/pagos-provisionales/2026-07/calcular");
    expect(m.mock.calls[0]![1]!.method).toBe("POST");
    expect(m.mock.calls[1]![1]!.method).toBe("PUT");
    expect(JSON.parse(String(m.mock.calls[1]![1]!.body))).toEqual({ regimen: "601", coeficienteUtilidad: "0.2" });
  });
  it("presentar manda centavos, fecha y la confirmacion exacta", async () => {
    const m = f({});
    await presentarPapel(t(m), "https://api.test", "tok", "p1", "2026-07", "ISR", { monto: "6,000.00", fecha: "2026-08-14", confirmacion: "ISR 2026-07" });
    expect(JSON.parse(String(m.mock.calls[0]![1]!.body))).toEqual({ impuesto: "ISR", montoPagadoCentavos: 600000, fechaPresentacion: "2026-08-14", confirmacion: "ISR 2026-07" });
  });
  it("exportar pide el formato y el regimen; registrar REP manda el XML", async () => {
    const m = f({ registrados: 1 });
    const r = await exportarPapel(t(m), "https://api.test", "tok", "p1", "2026-07", "pdf", "601");
    expect(m.mock.calls[0]![0]).toBe("https://api.test/despachos/p1/pagos-provisionales/2026-07/exportar?formato=pdf&regimen=601");
    expect(r.nombre).toBe("pagos-provisionales-2026-07.pdf");
    await registrarRep(t(m), "https://api.test", "tok", "p1", "<xml/>");
    expect(m.mock.calls[1]![0]).toBe("https://api.test/despachos/p1/pagos-provisionales/rep");
    expect(JSON.parse(String(m.mock.calls[1]![1]!.body))).toEqual({ xml: "<xml/>" });
  });
  it("un 503 (base sin migrar) llega con su mensaje", async () => {
    const m = f({ code: "service_unavailable", message: "falta aplicar la migración 018" }, 503);
    await expect(calcularPapel(t(m), "https://api.test", "tok", "p1", "2026-07", VACIO)).rejects.toThrow(/migración 018/);
  });
});
