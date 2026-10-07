// Autopiloto: taxonomia cerrada, KPI de precision del agente, tiempo prometido aprendido y saturacion (funciones puras).
import { describe, expect, it } from "vitest";
import {
  ETIQUETA_MOTIVO_CANCELACION, MIN_MUESTRAS_TIEMPO, MOTIVOS_CANCELACION, MOTIVOS_QUEJA, esMotivoCancelacion, esMotivoQueja, estimarTiempo, evaluarSaturacion,
  medianaMinutos, pisoMinutosDeTexto, precisionAgente,
} from "../src/autopiloto/index.ts";

const TEXTO_PM = "Domicilio 30-45 minutos (hora pico 45-60). Recoger 15-25 minutos.";
const SIN_SATURACION = { umbral1: null, umbral2: null, extraMinutos: 15 } as const;
const muestras = (n: number, valor: number) => Array.from({ length: n }, () => valor);

describe("taxonomia cerrada", () => {
  it("las listas son las del brief", () => {
    expect([...MOTIVOS_QUEJA]).toEqual(["faltante", "equivocado", "frio", "tarde", "trato", "otro"]);
    expect([...MOTIVOS_CANCELACION]).toEqual(["cliente_desistio", "sin_producto", "fuera_de_zona", "duplicado", "error_agente", "otro"]);
  });
  it("valida pertenencia y rechaza texto libre", () => {
    expect(esMotivoCancelacion("error_agente")).toBe(true);
    expect(esMotivoCancelacion("porque si")).toBe(false);
    expect(esMotivoCancelacion(undefined)).toBe(false);
    expect(esMotivoQueja("frio")).toBe(true);
    expect(esMotivoQueja("cancelar")).toBe(false);
  });
  it("cada motivo de cancelacion tiene etiqueta", () => {
    for (const m of MOTIVOS_CANCELACION) expect(ETIQUETA_MOTIVO_CANCELACION[m].length).toBeGreaterThan(2);
  });
});

describe("precision del agente", () => {
  it("1 - (cancelaciones error_agente + quejas equivocado) / pedidos del agente", () => {
    expect(precisionAgente({ pedidosAgente: 100, cancelacionesErrorAgente: 3, quejasEquivocado: 2 })).toBeCloseTo(0.95);
  });
  it("sin pedidos del agente es null (nunca 100 % inventado)", () => {
    expect(precisionAgente({ pedidosAgente: 0, cancelacionesErrorAgente: 0, quejasEquivocado: 0 })).toBeNull();
  });
  it("se acota a [0, 1]", () => {
    expect(precisionAgente({ pedidosAgente: 2, cancelacionesErrorAgente: 5, quejasEquivocado: 5 })).toBe(0);
  });
});

describe("mediana y piso del texto fijo", () => {
  it("mediana de impares y pares; ignora valores invalidos", () => {
    expect(medianaMinutos([30, 10, 20])).toBe(20);
    expect(medianaMinutos([10, 20, 30, 40])).toBe(25);
    expect(medianaMinutos([Number.NaN, -5])).toBeNull();
  });
  it("lee el limite inferior por canal", () => {
    expect(pisoMinutosDeTexto(TEXTO_PM, "domicilio")).toBe(30);
    expect(pisoMinutosDeTexto(TEXTO_PM, "recoger")).toBe(15);
    expect(pisoMinutosDeTexto("llega rapido", "domicilio")).toBeNull();
    expect(pisoMinutosDeTexto(null, "recoger")).toBeNull();
  });
});

describe("estimarTiempo (tiempo prometido aprendido)", () => {
  it("con menos de 20 muestras usa el texto fijo del dueno", () => {
    const t = estimarTiempo({ textoFijo: TEXTO_PM, canal: "domicilio", muestras: muestras(MIN_MUESTRAS_TIEMPO - 1, 50), abiertos: 0, saturacion: SIN_SATURACION });
    expect(t.origen).toBe("texto_fijo");
    expect(t.texto).toContain("30-45");
    expect(t.rango).toBeNull();
  });
  it("con 20 muestras estima la mediana redondeada a rangos de 10 minutos", () => {
    const t = estimarTiempo({ textoFijo: TEXTO_PM, canal: "domicilio", muestras: muestras(20, 47), abiertos: 0, saturacion: SIN_SATURACION });
    expect(t.origen).toBe("aprendido");
    expect(t.rango).toEqual({ minimo: 40, maximo: 50 });
    expect(t.texto).toBe("de 40 a 50 minutos");
  });
  it("NUNCA promete menos que el piso del dueno", () => {
    const t = estimarTiempo({ textoFijo: TEXTO_PM, canal: "domicilio", muestras: muestras(25, 12), abiertos: 0, saturacion: SIN_SATURACION });
    expect(t.rango!.minimo).toBeGreaterThanOrEqual(30);
    expect(t.rango!.maximo).toBeGreaterThan(t.rango!.minimo);
  });
  it("si no puede leer el piso del texto no inventa: usa el texto fijo", () => {
    const t = estimarTiempo({ textoFijo: "Lo confirmamos al pedir", canal: "domicilio", muestras: muestras(30, 40), abiertos: 0, saturacion: SIN_SATURACION });
    expect(t.origen).toBe("texto_fijo");
  });
  it("sin texto del dueno ni muestras no promete minutos", () => {
    const t = estimarTiempo({ textoFijo: null, canal: "recoger", muestras: [], abiertos: 0, saturacion: SIN_SATURACION });
    expect(t.origen).toBe("texto_fijo");
    expect(t.texto).toMatch(/sucursal/i);
  });
});

describe("saturacion", () => {
  const cfg = { umbral1: 10, umbral2: 20, extraMinutos: 15 };
  it("apagada por omision (umbrales null)", () => {
    expect(evaluarSaturacion(500, SIN_SATURACION)).toBe("normal");
  });
  it("por encima del primer umbral alarga; por encima del segundo propone pausa (nunca la aplica)", () => {
    expect(evaluarSaturacion(10, cfg)).toBe("normal");
    expect(evaluarSaturacion(11, cfg)).toBe("alargado");
    expect(evaluarSaturacion(21, cfg)).toBe("proponer_pausa");
  });
  it("alarga el tiempo prometido en +15 minutos", () => {
    const t = estimarTiempo({ textoFijo: TEXTO_PM, canal: "domicilio", muestras: muestras(20, 47), abiertos: 11, saturacion: cfg });
    expect(t.saturacion).toBe("alargado");
    expect(t.rango).toEqual({ minimo: 55, maximo: 65 });
  });
  it("sin muestras suficientes avisa la carga en el texto fijo", () => {
    const t = estimarTiempo({ textoFijo: TEXTO_PM, canal: "domicilio", muestras: [], abiertos: 30, saturacion: cfg });
    expect(t.texto).toContain("15 minutos mas");
    expect(t.saturacion).toBe("proponer_pausa");
  });
});
