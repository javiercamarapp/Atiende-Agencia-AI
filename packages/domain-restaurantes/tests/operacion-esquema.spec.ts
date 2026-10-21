// Mini-biblioteca de esquemas de los contratos del panel del operador: validacion en runtime, errores por campo, claves de mas.
import { describe, expect, it } from "vitest";
import { arreglo, booleano, describirErrores, enumerado, fechaIso, nulable, numero, objeto, opcional, registro, texto, uuid } from "../src/operacion/esquema.ts";

describe("esquema: primitivos", () => {
  it("texto respeta min, max y patron", () => {
    const e = texto({ min: 1, max: 3, patron: /^[a-z]+$/, descripcion: "solo letras." });
    expect(e.validar("ab")).toEqual({ ok: true, valor: "ab" });
    expect(e.validar("")).toMatchObject({ ok: false });
    expect(e.validar("abcd")).toMatchObject({ ok: false });
    expect(e.validar("a1")).toMatchObject({ ok: false, errores: [{ mensaje: "solo letras." }] });
    expect(e.validar(7)).toMatchObject({ ok: false });
  });

  it("numero rechaza NaN, Infinity, no enteros y fuera de rango", () => {
    const e = numero({ min: 1, max: 5, entero: true });
    expect(e.validar(3).ok).toBe(true);
    for (const malo of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, 0, 6, "3", null]) expect(e.validar(malo).ok).toBe(false);
  });

  it("enumerado, booleano, uuid y fechaIso", () => {
    expect(enumerado(["a", "b"] as const).validar("c").ok).toBe(false);
    expect(enumerado(["a", "b"] as const).validar("a").ok).toBe(true);
    expect(booleano().validar("true").ok).toBe(false);
    expect(uuid().validar("3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b").ok).toBe(true);
    expect(uuid().validar("no-es-uuid").ok).toBe(false);
    expect(fechaIso().validar("2026-10-21T20:41:00.000Z").ok).toBe(true);
    expect(fechaIso().validar("2026-10-21").ok).toBe(false);
    expect(fechaIso().validar("2026-13-45T00:00:00Z").ok).toBe(false);
  });
});

describe("esquema: compuestos", () => {
  const e = objeto({
    nombre: texto({ min: 1 }),
    edad: opcional(numero({ min: 0 })),
    nota: nulable(texto()),
    etiquetas: arreglo(texto({ min: 1 }), { max: 2 }),
  });

  it("acepta un objeto valido, omite opcionales ausentes y descarta claves de mas", () => {
    const r = e.validar({ nombre: "Ana", nota: null, etiquetas: ["x"], intruso: 1 });
    expect(r).toEqual({ ok: true, valor: { nombre: "Ana", nota: null, etiquetas: ["x"] } });
  });

  it("un campo obligatorio ausente y un nulable ausente son errores distintos al opcional", () => {
    const r = e.validar({ etiquetas: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.map((x) => x.campo).sort()).toEqual(["nombre", "nota"]);
  });

  it("reporta la ruta de los errores anidados y en listas", () => {
    const r = e.validar({ nombre: "Ana", nota: null, etiquetas: ["ok", "", "otra"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.map((x) => x.campo)).toEqual(["etiquetas"]);
    const r2 = e.validar({ nombre: "Ana", nota: null, etiquetas: ["ok", ""] });
    if (!r2.ok) expect(describirErrores(r2.errores)).toBe("etiquetas[1]: no puede ir vacio.");
    expect(e.validar([]).ok).toBe(false);
    expect(e.validar(null).ok).toBe(false);
  });

  it("registro valida cada valor", () => {
    const r = registro(numero({ min: 0 })).validar({ a: 1, b: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores[0]?.campo).toBe("b");
  });
});
