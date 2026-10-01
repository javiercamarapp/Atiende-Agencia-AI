// D-11 -- cliente HTTP de la cola de cobranza: conversion de pesos a centavos SIN flotantes, formato de centavos,
// rutas, metodos y cuerpos reales.
import { describe, expect, it, vi } from "vitest";
import { crearGestion, encolarWhatsApp, fetchCola, fetchGestiones, fijarConsentimiento, formatearCentavos, pesosTextoACentavos, resolverGestion } from "../src/verticals/despachos/lib/cola-cobranza-client.ts";

const API = "https://api.test";
const TOKEN = "tok";
const PROP = "prop-1";

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, headers: new Headers() } as unknown as Response;
}

describe("pesosTextoACentavos", () => {
  it("convierte sin pasar por flotantes (0.07 y 1.15 no pierden un centavo)", () => {
    expect(pesosTextoACentavos("0.07")).toBe(7);
    expect(pesosTextoACentavos("1.15")).toBe(115);
    expect(pesosTextoACentavos("1,160.00")).toBe(116000);
    expect(pesosTextoACentavos("$ 99.9")).toBe(9990);
    expect(pesosTextoACentavos(" 1500 ")).toBe(150000);
  });
  it("rechaza vacio, cero, negativos, 3 decimales, letras y exceso de digitos", () => {
    for (const malo of ["", " ", "0", "0.00", "-5", "1.234", "abc", "1e3", "1.", ".5", "1234567890123"]) expect(pesosTextoACentavos(malo)).toBeNull();
  });
});

describe("formatearCentavos", () => {
  it("formatea enteros con miles y dos decimales", () => {
    expect(formatearCentavos(116000)).toBe("$1,160.00");
    expect(formatearCentavos(5)).toBe("$0.05");
    expect(formatearCentavos(123456789)).toBe("$1,234,567.89");
    expect(formatearCentavos(null)).toBe("—");
  });
});

describe("llamadas HTTP", () => {
  it("arma URL, metodo y cuerpo de cada operacion", async () => {
    const f = vi.fn(async () => okJson({ id: "x", disponible: true, gestiones: [], items: [], hoy: "2026-10-01" }));
    const fetchImpl = f as unknown as typeof fetch;
    await fetchGestiones(fetchImpl, API, TOKEN, PROP, { receivableId: "r1", estado: "pendiente" });
    await fetchCola(fetchImpl, API, TOKEN, PROP);
    await crearGestion(fetchImpl, API, TOKEN, PROP, { receivableId: "r1", tipo: "promesa_pago", montoPromesaCentavos: 116000, fechaPromesa: "2026-10-15" });
    await resolverGestion(fetchImpl, API, TOKEN, PROP, "g1", "cumplida");
    await fijarConsentimiento(fetchImpl, API, TOKEN, PROP, { rfcReceptor: "XAXX010101000", telefono: "9981234567", estado: "opt_in", evidencia: "contrato" });
    await encolarWhatsApp(fetchImpl, API, TOKEN, PROP, "r1", "vencimiento");
    const llamadas = f.mock.calls.map((c) => c as unknown as [string, RequestInit | undefined]);
    expect(llamadas[0]![0]).toBe(`${API}/despachos/${PROP}/cola-cobranza/gestiones?receivableId=r1&estado=pendiente`);
    expect(llamadas[1]![0]).toBe(`${API}/despachos/${PROP}/cola-cobranza/cola`);
    expect(llamadas[2]![0]).toBe(`${API}/despachos/${PROP}/cola-cobranza/gestiones`);
    expect(llamadas[2]![1]?.method).toBe("POST");
    expect(JSON.parse(llamadas[2]![1]!.body as string)).toMatchObject({ montoPromesaCentavos: 116000 });
    expect(llamadas[3]![0]).toBe(`${API}/despachos/${PROP}/cola-cobranza/gestiones/g1/estado`);
    expect(JSON.parse(llamadas[3]![1]!.body as string)).toEqual({ estado: "cumplida", nota: null });
    expect(llamadas[4]![0]).toBe(`${API}/despachos/${PROP}/cola-cobranza/whatsapp/consentimientos`);
    expect(llamadas[5]![0]).toBe(`${API}/despachos/${PROP}/cola-cobranza/cuentas/r1/whatsapp`);
    expect(JSON.parse(llamadas[5]![1]!.body as string)).toEqual({ etapa: "vencimiento" });
  });
});
