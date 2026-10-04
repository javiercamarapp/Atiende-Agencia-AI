// D-32 -- desglose de una prefactura de honorarios y maquina de estados. Los vectores con retenciones se repiten en
// scripts/verify-despachos-facturacion-honorarios (la base recalcula con la misma aritmetica entera).
import { desgloseCuadra } from "@atiende/billing";
import { describe, expect, it } from "vitest";
import { ESTADOS_PREFACTURA, TRANSICIONES, calcularDesglose, dosTercios, evaluarTimbrabilidad, importesParaPac, porcentajeCentavos, puedeTransicionar, validarIgualaCapturada } from "../src/honorarios/index.ts";
import type { AccionPrefactura } from "../src/honorarios/index.ts";

const base = { montoBaseCentavos: 100_000, tasaIvaBp: 1600, retencionIsrBp: 0, retieneIvaDosTercios: false };

describe("calcularDesglose", () => {
  it("honorarios simples: base + 16 % de IVA", () => {
    expect(calcularDesglose(base)).toEqual({ baseCentavos: 100_000, ivaCentavos: 16_000, retencionIsrCentavos: 0, retencionIvaCentavos: 0, totalCentavos: 116_000 });
  });
  it("con retenciones: ISR 10 % y 2/3 del IVA", () => {
    expect(calcularDesglose({ ...base, retencionIsrBp: 1000, retieneIvaDosTercios: true })).toEqual({ baseCentavos: 100_000, ivaCentavos: 16_000, retencionIsrCentavos: 10_000, retencionIvaCentavos: 10_667, totalCentavos: 95_333 });
  });
  it("redondea a centavo, mitad hacia arriba (vector compartido con la base)", () => {
    // 12345 * 16 % = 1975.2 -> 1975; ISR 10 % = 1234.5 -> 1235; 2/3 de 1975 = 1316.67 -> 1317.
    expect(calcularDesglose({ montoBaseCentavos: 12_345, tasaIvaBp: 1600, retencionIsrBp: 1000, retieneIvaDosTercios: true })).toEqual({
      baseCentavos: 12_345, ivaCentavos: 1975, retencionIsrCentavos: 1235, retencionIvaCentavos: 1317, totalCentavos: 11_768,
    });
  });
  it("tasa 0 % y tasa de frontera 8 %", () => {
    expect(calcularDesglose({ ...base, tasaIvaBp: 0 }).ivaCentavos).toBe(0);
    expect(calcularDesglose({ ...base, tasaIvaBp: 800 }).ivaCentavos).toBe(8_000);
  });
  it("sin flotantes: porcentaje y dos tercios exactos en el borde", () => {
    expect(porcentajeCentavos(5, 1000)).toBe(1); // 0.5 -> 1 (mitad hacia arriba)
    expect(porcentajeCentavos(4, 1000)).toBe(0);
    expect(dosTercios(1)).toBe(1); // 0.67 -> 1
    expect(dosTercios(3)).toBe(2);
    expect(dosTercios(0)).toBe(0);
  });
  it("la suma siempre cuadra: total = base + IVA - retenciones, y base + IVA cuadra con `desgloseCuadra` del motor de facturacion", () => {
    for (let b = 1; b <= 3000; b += 7) {
      const d = calcularDesglose({ montoBaseCentavos: b, tasaIvaBp: 1600, retencionIsrBp: 1000, retieneIvaDosTercios: b % 2 === 0 });
      expect(d.totalCentavos).toBe(d.baseCentavos + d.ivaCentavos - d.retencionIsrCentavos - d.retencionIvaCentavos);
      const p = importesParaPac(d);
      expect(desgloseCuadra(p.total, p.subtotal, p.iva)).toBe(true);
    }
  });
  it.each([
    [{ ...base, montoBaseCentavos: 0 }],
    [{ ...base, montoBaseCentavos: -5 }],
    [{ ...base, montoBaseCentavos: 10.5 }],
    [{ ...base, montoBaseCentavos: 100_000_000_001 }],
    [{ ...base, tasaIvaBp: 1000 }],
    [{ ...base, retencionIsrBp: 3600 }],
  ])("rechaza datos invalidos (%j)", (entrada) => {
    expect(() => calcularDesglose(entrada)).toThrow();
  });
});

describe("evaluarTimbrabilidad (no se timbra sin desglose)", () => {
  const ok = calcularDesglose(base);
  it("un desglose que cuadra y sin retenciones es timbrable", () => expect(evaluarTimbrabilidad(ok)).toEqual({ ok: true }));
  it("sin base o con IVA invalido: sin_desglose", () => {
    expect(evaluarTimbrabilidad({ ...ok, baseCentavos: 0 })).toMatchObject({ ok: false, codigo: "sin_desglose" });
    expect(evaluarTimbrabilidad({ ...ok, ivaCentavos: Number.NaN })).toMatchObject({ ok: false, codigo: "sin_desglose" });
  });
  it("un total que no cuadra: desglose_no_cuadra", () => expect(evaluarTimbrabilidad({ ...ok, totalCentavos: ok.totalCentavos + 1 })).toMatchObject({ ok: false, codigo: "desglose_no_cuadra" }));
  it("con retenciones no se timbra (el puerto del PAC no las transporta; NO VERIFICADO D-34)", () => {
    expect(evaluarTimbrabilidad(calcularDesglose({ ...base, retencionIsrBp: 1000 }))).toMatchObject({ ok: false, codigo: "retenciones_pendientes_verificar" });
  });
});

describe("maquina de estados", () => {
  const esperado: Record<AccionPrefactura, readonly string[]> = {
    aprobar: ["borrador"],
    reservar_timbrado: ["aprobada", "fallida"],
    registrar_timbre: ["timbrando"],
    registrar_fallo: ["timbrando"],
    cancelar: ["borrador", "aprobada", "fallida", "timbrada"],
  };
  it("coincide con la matriz documentada en la migracion 023 para TODAS las combinaciones estado x accion", () => {
    for (const accion of Object.keys(esperado) as AccionPrefactura[]) {
      for (const estado of ESTADOS_PREFACTURA) expect(puedeTransicionar(estado, accion), `${estado} -> ${accion}`).toBe(esperado[accion].includes(estado));
    }
  });
  it("timbrando y cancelada nunca se cancelan; timbrada y cancelada no se aprueban", () => {
    expect(puedeTransicionar("timbrando", "cancelar")).toBe(false);
    expect(puedeTransicionar("cancelada", "cancelar")).toBe(false);
    expect(TRANSICIONES.reservar_timbrado.hacia).toBe("timbrando");
  });
});

describe("validarIgualaCapturada", () => {
  const valida = { concepto: "Iguala contable mensual", montoBaseCentavos: 250_000 };
  it("aplica los valores por defecto (G03, E48, 84111500, 16 %, dia 1, activa)", () => {
    const r = validarIgualaCapturada(valida);
    expect(r).toEqual({ ok: true, valor: { concepto: "Iguala contable mensual", claveProdServ: "84111500", claveUnidad: "E48", montoBaseCentavos: 250_000, tasaIvaBp: 1600, retencionIsrBp: 0, retieneIvaDosTercios: false, diaEmision: 1, usoCfdi: "G03", activa: true } });
  });
  it("devuelve un error por campo y no redondea un decimal de centavos", () => {
    const r = validarIgualaCapturada({ concepto: "ab", montoBaseCentavos: 10.5, tasaIvaBp: 1000, diaEmision: 29, usoCfdi: "zz", claveProdServ: "123" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.map((e) => e.campo).sort()).toEqual(["claveProdServ", "concepto", "diaEmision", "montoBaseCentavos", "usoCfdi"].sort());
  });
});
