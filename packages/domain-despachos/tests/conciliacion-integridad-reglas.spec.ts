// D-P3-10/11/12 -- reglas puras nuevas de la conciliación: verificación de par ACOTADA al par, revisión de direcciones indeterminadas, selección de lo que el piloto
// automático puede confirmar (solo nivel 1 ÚNICO con dirección explícita), propuestas guardadas y su validación al leer.
import { describe, expect, it } from "vitest";
import {
  aPropuestasGuardadas,
  calcularPropuestas,
  ConciliacionRevisionRequeridaError,
  leerPropuestasGuardadas,
  ParNoPropuestoPorMotorError,
  resolverParesAcotados,
  seleccionarAutoconfirmables,
  vigentesDe,
} from "../src/index.ts";
import type { MovimientoGuardado, RegistroConciliable } from "../src/index.ts";

const mov = (id: string, monto: number, fecha = "2025-03-10", descripcion = "COBRO"): MovimientoGuardado => ({
  id,
  hash: id,
  cuenta: null,
  fecha,
  descripcion,
  referencia: null,
  cargo: monto < 0 ? -monto : null,
  abono: monto > 0 ? monto : null,
  saldo: null,
  monto,
  banco: "generic",
  formato: "csv",
});
const reg = (id: string, total: number, extra: Partial<RegistroConciliable> = {}): RegistroConciliable => ({ id, fecha: "2025-03-10", total, descripcion: "COBRO", direccion: "emitido", ...extra });

describe("resolverParesAcotados: verifica cada par a solas, nunca confía en el cliente", () => {
  const movs = new Map([["m1", mov("m1", 1000)]]);
  const regs = new Map([["c1", reg("c1", 1000)], ["c2", reg("c2", 5000)], ["ind", reg("ind", 1000, { direccion: "indeterminado" })]]);

  it("un par que el motor propone toma nivel y confianza del SERVIDOR", () => {
    const r = resolverParesAcotados([{ movimientoId: "m1", invoiceId: "c1", manual: false }], movs, regs);
    expect(r).toEqual([{ movimientoId: "m1", invoiceId: "c1", nivel: 1, confianza: 100, origen: "motor" }]);
  });
  it("un par que el motor no propone, aun a solas, se rechaza", () => {
    expect(() => resolverParesAcotados([{ movimientoId: "m1", invoiceId: "c2", manual: false }], movs, regs)).toThrow(ParNoPropuestoPorMotorError);
  });
  it("un movimiento o CFDI desconocido (no libre) se rechaza", () => {
    expect(() => resolverParesAcotados([{ movimientoId: "x", invoiceId: "c1", manual: false }], movs, regs)).toThrow(ParNoPropuestoPorMotorError);
    expect(() => resolverParesAcotados([{ movimientoId: "m1", invoiceId: "x", manual: false }], movs, regs)).toThrow(ParNoPropuestoPorMotorError);
  });
  it("un par manual no lleva nivel ni confianza", () => {
    expect(resolverParesAcotados([{ movimientoId: "m1", invoiceId: "c2", manual: true }], movs, regs)).toEqual([{ movimientoId: "m1", invoiceId: "c2", nivel: null, confianza: null, origen: "manual" }]);
  });
  it("dirección indeterminada: exige `revisado: true`", () => {
    expect(() => resolverParesAcotados([{ movimientoId: "m1", invoiceId: "ind", manual: false }], movs, regs)).toThrow(ConciliacionRevisionRequeridaError);
    expect(resolverParesAcotados([{ movimientoId: "m1", invoiceId: "ind", manual: false, revisado: true }], movs, regs)[0]!.origen).toBe("motor");
  });
});

describe("seleccionarAutoconfirmables: el piloto solo confirma nivel 1 ÚNICO con dirección explícita", () => {
  const sel = (movs: MovimientoGuardado[], regs: RegistroConciliable[]) => seleccionarAutoconfirmables(calcularPropuestas(movs, regs).propuestas, movs, regs);

  it("un par exacto y único se autoconfirma", () => {
    expect(sel([mov("m1", 1000)], [reg("c1", 1000)])).toEqual([{ movimientoId: "m1", invoiceId: "c1", confianza: 100 }]);
  });
  it("NO si hay otro CFDI que cuadra con el movimiento (ambiguo para el movimiento)", () => {
    expect(sel([mov("m1", 1000)], [reg("c1", 1000), reg("c2", 1000)])).toEqual([]);
  });
  it("NO si hay otro movimiento que cuadra con el CFDI (ambiguo para el CFDI)", () => {
    expect(sel([mov("m1", 1000), mov("m2", 1000)], [reg("c1", 1000)])).toEqual([]);
  });
  it("NO con dirección indeterminada ni sin dato", () => {
    expect(sel([mov("m1", 1000)], [reg("c1", 1000, { direccion: "indeterminado" })])).toEqual([]);
    expect(sel([mov("m1", 1000)], [reg("c1", 1000, { direccion: undefined })])).toEqual([]);
  });
  it("NO nivel 2 (fuzzy): monto cercano pero no igual", () => {
    const movs = [mov("m1", 1010, "2025-03-11", "SPEI RECIBIDO CLIENTE ACME")];
    const regs = [reg("c1", 1000, { descripcion: "CLIENTE ACME" })];
    expect(calcularPropuestas(movs, regs).propuestas[0]?.nivel).toBe(2);
    expect(sel(movs, regs)).toEqual([]);
  });
  it("NO grupos (multi-línea) ni ambiguos", () => {
    expect(sel([mov("m1", 600)], [reg("a", 100), reg("b", 200), reg("c", 300)])).toEqual([]);
    expect(sel([mov("m1", 300)], [reg("a", 100), reg("b", 200), reg("c", 150), reg("d", 150)])).toEqual([]);
  });
  it("NO con el signo invertido (cargo contra CFDI emitido)", () => {
    expect(sel([mov("m1", -1000)], [reg("c1", 1000)])).toEqual([]);
  });
});

describe("propuestas guardadas", () => {
  const movs = [mov("m1", 1000), mov("m2", 300)];
  const regs = [reg("c1", 1000), reg("a", 100), reg("b", 200), reg("c", 150), reg("d", 150)];
  const calculo = calcularPropuestas(movs, regs);
  const g = aPropuestasGuardadas(calculo, "2026-10-04T00:00:00.000Z");

  it("sobreviven a un viaje por JSON (lo que hace la base) y se validan al leer", () => {
    const leido = leerPropuestasGuardadas(JSON.parse(JSON.stringify(g)));
    expect(leido).toEqual(g);
    expect(leido!.propuestas).toHaveLength(1);
    expect(leido!.ambiguas).toHaveLength(1);
  });
  it("un valor malformado o de otra versión se descarta (nunca rompe el GET)", () => {
    expect(leerPropuestasGuardadas(null)).toBeNull();
    expect(leerPropuestasGuardadas({ version: 2 })).toBeNull();
    expect(leerPropuestasGuardadas({ version: 1, calculadoEn: "x", propuestas: "no", multiLinea: [], ambiguas: [], sinConciliar: [] })).toBeNull();
    expect(leerPropuestasGuardadas({ version: 1, calculadoEn: "x", propuestas: [{ movimientoId: 1 }], multiLinea: [], ambiguas: [], sinConciliar: [] })).toBeNull();
  });
  it("vigentesDe descarta lo que dejó de estar libre sin volver a correr el motor", () => {
    const v = vigentesDe(g, new Set(["m2"]), new Set(["c1", "a", "b", "c", "d"]));
    expect(v.propuestas).toHaveLength(0); // m1 ya se concilió
    expect(v.ambiguas).toHaveLength(1);
    const sinCfdi = vigentesDe(g, new Set(["m1", "m2"]), new Set(["a", "b"])); // c1, c y d se consumieron
    expect(sinCfdi.propuestas).toHaveLength(0);
    expect(sinCfdi.ambiguas).toHaveLength(0); // ya no quedan 2 combinaciones posibles
  });
});
