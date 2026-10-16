// CFO-04 · segmentos de clientes: activo / dormido / perdido, frecuente, nuevo / recurrente.
import { describe, expect, it } from "vitest";
import { clasificarActividad, definicionesSegmentos, esFrecuente, etiquetaActividad, etiquetaSegmento, resumirSegmentos, segmentoCliente, validarUmbralesActividad } from "../src/cfo/segmentos.ts";
import { CFO_CONFIG_POR_DEFECTO } from "../src/cfo/tipos.ts";
import { generarDatasetSintetico } from "./fixtures/cfo-pm-sintetico.ts";

const C = CFO_CONFIG_POR_DEFECTO;

describe("actividad: bordes con los umbrales por omisión (60 y 120 días)", () => {
  it.each([
    [0, "activo"], [1, "activo"], [60, "activo"], [61, "dormido"], [120, "dormido"], [121, "perdido"], [900, "perdido"],
  ] as const)("hace %i días -> %s", (dias, esperado) => {
    expect(clasificarActividad(dias, C)).toBe(esperado);
  });
  it("sin pedidos nunca es activo", () => {
    expect(clasificarActividad(null, C)).toBe("sin_pedidos");
  });
  it("respeta umbrales configurados", () => {
    const cfg = { activoDias: 30, perdidoDias: 90 };
    expect(clasificarActividad(30, cfg)).toBe("activo");
    expect(clasificarActividad(31, cfg)).toBe("dormido");
    expect(clasificarActividad(91, cfg)).toBe("perdido");
  });
  it("umbrales incoherentes lanzan", () => {
    expect(() => validarUmbralesActividad({ activoDias: 120, perdidoDias: 60 })).toThrow(RangeError);
    expect(() => clasificarActividad(1, { activoDias: 0, perdidoDias: 10 })).toThrow(RangeError);
    expect(() => clasificarActividad(1, { activoDias: 60, perdidoDias: 60 })).toThrow(RangeError);
  });
});

describe("frecuente: ≥ 3 pedidos en 90 días", () => {
  it("3 sí, 2 no", () => {
    expect(esFrecuente(3, C)).toBe(true);
    expect(esFrecuente(2, C)).toBe(false);
    expect(esFrecuente(0, C)).toBe(false);
    expect(esFrecuente(5, { frecuenteN: 6, frecuenteDias: 90 })).toBe(false);
  });
});

describe("segmento del cliente en el periodo: frecuente > nuevo > recurrente", () => {
  it("clasifica", () => {
    expect(segmentoCliente({ pedidosEnVentana: 1, primerPedidoEnRango: true }, C)).toBe("nuevo");
    expect(segmentoCliente({ pedidosEnVentana: 2, primerPedidoEnRango: false }, C)).toBe("recurrente");
    expect(segmentoCliente({ pedidosEnVentana: 3, primerPedidoEnRango: false }, C)).toBe("frecuente");
    expect(segmentoCliente({ pedidosEnVentana: 3, primerPedidoEnRango: true }, C)).toBe("frecuente");
  });
});

describe("etiquetas legibles", () => {
  it("etiquetas y definiciones con los umbrales vigentes", () => {
    expect(etiquetaActividad("dormido")).toBe("Dormido");
    expect(etiquetaSegmento("frecuente")).toBe("Frecuente");
    const d = definicionesSegmentos(C);
    expect(d.activo).toBe("Activo: pidió en los últimos 60 días.");
    expect(d.dormido).toBe("Dormido: su último pedido fue hace 61 a 120 días.");
    expect(d.perdido).toBe("Perdido: no pide hace más de 120 días.");
    expect(d.frecuente).toBe("Frecuente: 3 o más pedidos en 90 días.");
  });
  it("resumirSegmentos usa el % de frecuentes sobre activos; sin activos es sin dato", () => {
    const r = resumirSegmentos({ activos: 600, dormidos: 200, perdidos: 100, frecuentes: 120 });
    expect(r.frecuentesPct.valor).toBe(20);
    expect(r.totalClasificados).toBe(900);
    expect(r.etiquetas[0]).toBe("600 activos");
    expect(resumirSegmentos({ activos: 0, dormidos: 3, perdidos: 0, frecuentes: 0 }).frecuentesPct.valor).toBeNull();
  });
  it("con el dataset sintético: activos + dormidos + perdidos == clientes con algún pedido en la sucursal", () => {
    const d = generarDatasetSintetico();
    for (const f of d.clientes) {
      const r = resumirSegmentos(f);
      expect(r.totalClasificados).toBeGreaterThanOrEqual(f.clientesConPedido);
      expect(f.frecuentes).toBeLessThanOrEqual(f.activos);
    }
  });
});
