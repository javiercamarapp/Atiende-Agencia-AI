import { describe, expect, it } from "vitest";
import { buscarCanalCatalogo, buscarCanalCatalogoPorCanalAtiende, CATALOGO_CANALES_MX } from "../../src/canales/catalogo.ts";

describe("catálogo de canales de México (Rn-P3-15)", () => {
  it("lista los ocho canales del encargo, sin códigos repetidos", () => {
    const codigos = CATALOGO_CANALES_MX.map((c) => c.codigo);
    expect(codigos.sort()).toEqual(["agoda", "airbnb", "booking", "despegar", "directo", "expedia", "google_vr", "vrbo"]);
    expect(new Set(codigos).size).toBe(codigos.length);
  });

  it("no inventa cifras: toda latencia trae fuente o es sin_evidencia (y viceversa)", () => {
    for (const c of CATALOGO_CANALES_MX) {
      if (c.latencia.confianza === "sin_evidencia") {
        expect(c.latencia.fuente, c.codigo).toBeNull();
        expect(c.latencia.texto, c.codigo).toBe("SIN EVIDENCIA");
      } else {
        expect(c.latencia.fuente, c.codigo).toMatch(/\S/);
      }
    }
  });

  it("toda vía bloqueada trae motivo y cita; todo canal de solo-partner trae bloqueo", () => {
    for (const c of CATALOGO_CANALES_MX) {
      if (c.bloqueo) {
        expect(c.bloqueo.motivo, c.codigo).toMatch(/\S/);
        expect(c.bloqueo.cita, c.codigo).toMatch(/\S/);
      }
      if (c.viaHoy === "partner") expect(c.bloqueo, c.codigo).not.toBeNull();
    }
  });

  it("conserva literalmente los datos del suelto para Airbnb, Vrbo y Booking", () => {
    const airbnb = buscarCanalCatalogo("airbnb")!;
    expect(airbnb.capacidades).toEqual({ import: true, export: true, tarifas: false, mensajes: false });
    expect(airbnb.latencia.confianza).toBe("baja");
    expect(airbnb.latencia.texto).toContain("~3 horas");
    expect(airbnb.bloqueo?.motivo).toContain("NDA + revisión de seguridad + 6 meses");

    const vrbo = buscarCanalCatalogo("vrbo")!;
    expect(vrbo.latencia.texto).toBe("~30 min + 20 min de propagación");
    expect(vrbo.latencia.confianza).toBe("media");

    const booking = buscarCanalCatalogo("booking")!;
    expect(booking.capacidades).toEqual({ import: false, export: false, tarifas: false, mensajes: false });
    expect(booking.latencia.confianza).toBe("sin_evidencia");
    expect(booking.viaIcal).toBe("sin_evidencia");
    expect(booking.bloqueo?.motivo).toContain("pausing integrations with new connectivity providers");
  });

  it("ningún canal sin vía implementada declara capacidades de hoy", () => {
    for (const c of CATALOGO_CANALES_MX.filter((x) => x.viaHoy === "partner" || x.viaHoy === "sin_adaptador" || x.viaHoy === "sin_evidencia")) {
      expect(c.capacidades, c.codigo).toEqual({ import: false, export: false, tarifas: false, mensajes: false });
    }
  });

  it("Atiende solo registra con canal propio airbnb, booking, vrbo y la reserva directa", () => {
    const registrados = CATALOGO_CANALES_MX.filter((c) => c.canalAtiende !== null).map((c) => c.canalAtiende);
    expect(registrados.sort()).toEqual(["airbnb", "booking", "manual", "vrbo"]);
    expect(buscarCanalCatalogoPorCanalAtiende("manual")?.codigo).toBe("directo");
    expect(buscarCanalCatalogoPorCanalAtiende("expedia")).toBeUndefined();
  });
});
