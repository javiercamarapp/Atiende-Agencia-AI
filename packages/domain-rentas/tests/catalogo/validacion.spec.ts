import { describe, expect, it } from "vitest";
import {
  esZonaHorariaIana,
  validarEntradaActualizarPropiedad,
  validarEntradaActualizarPropietario,
  validarEntradaActualizarRegla,
  validarEntradaActualizarUnidad,
  validarEntradaCrearPropiedad,
  validarEntradaCrearPropietario,
  validarEntradaCrearUnidad,
  validarEntradaRegla,
} from "../../src/catalogo/validacion.ts";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("esZonaHorariaIana", () => {
  it("acepta zonas IANA reales y rechaza texto inventado, vacio o con caracteres raros", () => {
    for (const z of ["America/Mexico_City", "America/Cancun", "America/Tijuana", "UTC"]) expect(esZonaHorariaIana(z), z).toBe(true);
    for (const z of ["", "Marte/Olimpo", "Mexico", "America/Mexico City", "../etc/passwd", "a".repeat(100)]) expect(esZonaHorariaIana(z), z).toBe(false);
  });
});

describe("validarEntradaRegla", () => {
  const base = { canalCodigo: "booking", alcance: "organizacion", yaNetoDeComision: false, comisionBasisPoints: 1500, fuente: "contrato 2027" };

  it("acepta una regla valida y conserva el alcance", () => {
    expect(validarEntradaRegla(base)).toEqual({ ok: true, valor: { alcance: "organizacion", canalCodigo: "booking", yaNetoDeComision: false, comisionBasisPoints: 1500, fuente: "contrato 2027" } });
    expect(validarEntradaRegla({ ...base, alcance: "propiedad" })).toMatchObject({ ok: true, valor: { alcance: "propiedad" } });
  });

  it("rechaza puntos base fuera de 0..10000, decimales y no numericos", () => {
    for (const bps of [-1, 10001, 15.5, "1500", null]) expect(validarEntradaRegla({ ...base, comisionBasisPoints: bps }), String(bps)).toMatchObject({ ok: false });
    expect(validarEntradaRegla({ ...base, comisionBasisPoints: 10000 })).toMatchObject({ ok: true });
    expect(validarEntradaRegla({ ...base, comisionBasisPoints: 0 })).toMatchObject({ ok: true });
  });

  it("un canal que ya entrega neto exige 0 pb", () => {
    expect(validarEntradaRegla({ ...base, yaNetoDeComision: true, comisionBasisPoints: 500 })).toMatchObject({ ok: false, error: expect.stringMatching(/neto/) });
    expect(validarEntradaRegla({ ...base, yaNetoDeComision: true, comisionBasisPoints: 0 })).toMatchObject({ ok: true });
  });

  it("exige fuente de 3 a 200 caracteres, alcance valido y canal con forma de codigo", () => {
    expect(validarEntradaRegla({ ...base, fuente: "ab" })).toMatchObject({ ok: false });
    expect(validarEntradaRegla({ ...base, fuente: "x".repeat(201) })).toMatchObject({ ok: false });
    expect(validarEntradaRegla({ ...base, alcance: "global" })).toMatchObject({ ok: false });
    expect(validarEntradaRegla({ ...base, canalCodigo: "Booking.com; drop" })).toMatchObject({ ok: false });
    expect(validarEntradaRegla(null)).toMatchObject({ ok: false });
    expect(validarEntradaRegla([])).toMatchObject({ ok: false });
  });
});

describe("validarEntradaActualizarRegla", () => {
  it("solo trae ya neto, pb y fuente", () => {
    expect(validarEntradaActualizarRegla({ yaNetoDeComision: false, comisionBasisPoints: 1800, fuente: "contrato firmado" })).toEqual({
      ok: true,
      valor: { yaNetoDeComision: false, comisionBasisPoints: 1800, fuente: "contrato firmado" },
    });
    expect(validarEntradaActualizarRegla({ comisionBasisPoints: 1800, fuente: "contrato firmado" })).toMatchObject({ ok: false });
  });
});

describe("propiedades", () => {
  it("alta: nombre 2..120, zona IANA y moneda MXN/USD", () => {
    expect(validarEntradaCrearPropiedad({ nombre: "  Casa Playa  ", zonaHoraria: "America/Cancun", moneda: "USD" })).toEqual({
      ok: true,
      valor: { nombre: "Casa Playa", zonaHoraria: "America/Cancun", moneda: "USD" },
    });
    expect(validarEntradaCrearPropiedad({ nombre: "X", zonaHoraria: "America/Cancun", moneda: "MXN" })).toMatchObject({ ok: false });
    expect(validarEntradaCrearPropiedad({ nombre: "Casa", zonaHoraria: "Marte/Olimpo", moneda: "MXN" })).toMatchObject({ ok: false });
    for (const m of ["EUR", "mxn", "", null, 5]) expect(validarEntradaCrearPropiedad({ nombre: "Casa", zonaHoraria: "America/Cancun", moneda: m }), String(m)).toMatchObject({ ok: false });
  });

  it("edicion: al menos un campo, cada uno validado", () => {
    expect(validarEntradaActualizarPropiedad({})).toMatchObject({ ok: false });
    expect(validarEntradaActualizarPropiedad({ moneda: "USD" })).toEqual({ ok: true, valor: { moneda: "USD" } });
    expect(validarEntradaActualizarPropiedad({ zonaHoraria: "no/existe" })).toMatchObject({ ok: false });
    expect(validarEntradaActualizarPropiedad({ nombre: "" })).toMatchObject({ ok: false });
  });
});

describe("unidades", () => {
  it("alta: nombre 1..120, propietario UUID o nulo, estancia minima 1..365 (por defecto 1)", () => {
    expect(validarEntradaCrearUnidad({ nombre: "Suite 1" })).toEqual({ ok: true, valor: { nombre: "Suite 1", propietarioId: null, duracionMinimaNoches: 1 } });
    expect(validarEntradaCrearUnidad({ nombre: "Suite 1", propietarioId: UUID, duracionMinimaNoches: 3 })).toMatchObject({ ok: true, valor: { propietarioId: UUID, duracionMinimaNoches: 3 } });
    expect(validarEntradaCrearUnidad({ nombre: "" })).toMatchObject({ ok: false });
    expect(validarEntradaCrearUnidad({ nombre: "S", propietarioId: "no-uuid" })).toMatchObject({ ok: false });
    for (const n of [0, 366, 1.5, "2"]) expect(validarEntradaCrearUnidad({ nombre: "S", duracionMinimaNoches: n }), String(n)).toMatchObject({ ok: false });
  });

  it("edicion: null quita el propietario, ausente lo deja igual", () => {
    expect(validarEntradaActualizarUnidad({ propietarioId: null })).toEqual({ ok: true, valor: { propietarioId: null } });
    expect(validarEntradaActualizarUnidad({ nombre: "Nueva" })).toEqual({ ok: true, valor: { nombre: "Nueva" } });
    expect(validarEntradaActualizarUnidad({})).toMatchObject({ ok: false });
  });
});

describe("propietarios", () => {
  it("alta: correo opcional, en minusculas y con forma de correo", () => {
    expect(validarEntradaCrearPropietario({ nombre: "Ana", email: "Ana@Example.COM" })).toEqual({ ok: true, valor: { nombre: "Ana", email: "ana@example.com" } });
    expect(validarEntradaCrearPropietario({ nombre: "Ana" })).toEqual({ ok: true, valor: { nombre: "Ana", email: null } });
    expect(validarEntradaCrearPropietario({ nombre: "Ana", email: "sin-arroba" })).toMatchObject({ ok: false });
    expect(validarEntradaCrearPropietario({ nombre: "A" })).toMatchObject({ ok: false });
  });

  it("edicion: email null lo borra", () => {
    expect(validarEntradaActualizarPropietario({ email: null })).toEqual({ ok: true, valor: { email: null } });
    expect(validarEntradaActualizarPropietario({})).toMatchObject({ ok: false });
  });
});
