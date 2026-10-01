import { describe, expect, it } from "vitest";
import { validarInstruccion, validarPolitica } from "../../src/index.ts";

const BASE = { activo: true, horas_antes_checkin: 24, hora_checkin: "15:00", exigir_pago: true, ota_cuenta_como_pagada: false };

describe("validarPolitica", () => {
  it("acepta una política completa", () => {
    expect(validarPolitica(BASE)).toEqual({ ok: true, valor: { activo: true, horasAntesCheckin: 24, horaCheckin: "15:00", exigirPago: true, otaCuentaComoPagada: false } });
  });
  it("rechaza horas fuera de 1..168, no enteras, horas mal formadas y banderas que no son booleanas", () => {
    for (const malo of [{ ...BASE, horas_antes_checkin: 0 }, { ...BASE, horas_antes_checkin: 169 }, { ...BASE, horas_antes_checkin: 1.5 }, { ...BASE, horas_antes_checkin: "24" }, { ...BASE, hora_checkin: "24:00" }, { ...BASE, hora_checkin: "9:00" }, { ...BASE, activo: "si" }, { ...BASE, exigir_pago: undefined }, null, "x"]) {
      expect(validarPolitica(malo).ok).toBe(false);
    }
  });
  it("acepta los extremos 1 y 168 y 00:00/23:59", () => {
    expect(validarPolitica({ ...BASE, horas_antes_checkin: 1, hora_checkin: "00:00" }).ok).toBe(true);
    expect(validarPolitica({ ...BASE, horas_antes_checkin: 168, hora_checkin: "23:59" }).ok).toBe(true);
  });
});

describe("validarInstruccion", () => {
  it("recorta espacios y normaliza vacíos a null", () => {
    expect(validarInstruccion({ direccion_exacta: "  Calle 1  ", codigo_acceso: "  ", instrucciones: "x" })).toEqual({ ok: true, valor: { direccionExacta: "Calle 1", codigoAcceso: null, instrucciones: "x" } });
  });
  it("exige dirección y respeta los máximos", () => {
    expect(validarInstruccion({ direccion_exacta: "  " }).ok).toBe(false);
    expect(validarInstruccion({}).ok).toBe(false);
    expect(validarInstruccion({ direccion_exacta: "a".repeat(501) }).ok).toBe(false);
    expect(validarInstruccion({ direccion_exacta: "a", codigo_acceso: "1".repeat(101) }).ok).toBe(false);
    expect(validarInstruccion({ direccion_exacta: "a", instrucciones: "i".repeat(2001) }).ok).toBe(false);
    expect(validarInstruccion({ direccion_exacta: "a", codigo_acceso: 1234 }).ok).toBe(false);
  });
});
