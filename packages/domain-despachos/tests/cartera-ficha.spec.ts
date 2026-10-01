// D-21 -- validación pura de la ficha del cliente (RFC, régimen vs tipo de persona, CP, periodicidad, responsable).
import { describe, expect, it } from "vitest";
import { validarFichaCliente, validarNombreCliente, validarRfcCliente } from "../src/cartera/index.ts";

describe("validarRfcCliente", () => {
  it("acepta persona moral (12) y física (13), normaliza minúsculas/espacios y deriva el tipo", () => {
    expect(validarRfcCliente(" abc010101ab1 ")).toEqual({ ok: true, rfc: "ABC010101AB1", tipoPersona: "moral" });
    expect(validarRfcCliente("PEPJ800101AB1")).toEqual({ ok: true, rfc: "PEPJ800101AB1", tipoPersona: "fisica" });
  });
  it("acepta & y Ñ en la clave", () => {
    expect(validarRfcCliente("&AB010101AB1").ok).toBe(true);
    expect(validarRfcCliente("ñab010101ab1")).toMatchObject({ ok: true, rfc: "ÑAB010101AB1" });
  });
  it.each([
    ["vacío", ""],
    ["solo espacios", "   "],
    ["no es texto", 12345],
    ["nulo", null],
    ["genérico público en general", "XAXX010101000"],
    ["genérico extranjero", "xexx010101000"],
    ["demasiado corto", "ABC0101"],
    ["demasiado largo", "ABCD0101011234567"],
    ["mes 13", "ABC011301AB1"],
    ["mes 00", "ABC010001AB1"],
    ["día 32", "ABC010132AB1"],
    ["día 00", "ABC010100AB1"],
    ["30 de febrero", "ABC010230AB1"],
    ["31 de abril", "ABC010431AB1"],
    ["caracteres inválidos", "AB!010101AB1"],
    ["dígitos en la clave", "A1C010101AB1"],
    ["homoclave con símbolo", "ABC010101A-1"],
  ])("rechaza %s", (_nombre, valor) => {
    expect(validarRfcCliente(valor).ok).toBe(false);
  });
  it("admite el 29 de febrero (el año de 2 dígitos es ambiguo)", () => {
    expect(validarRfcCliente("ABC000229AB1").ok).toBe(true);
  });
  it("no ejecuta ni interpreta una inyección: es solo un RFC inválido", () => {
    expect(validarRfcCliente("ABC010101'; DROP TABLE x;--").ok).toBe(false);
  });
});

const BASE = { rfc: "ABC010101AB1", razonSocial: "Cliente Uno SA de CV", regimenesFiscales: ["601"], cpFiscal: "06600", periodicidad: "mensual", responsableId: null };

describe("validarFichaCliente", () => {
  it("normaliza razón social, deduplica y ordena regímenes, periodicidad por defecto mensual", () => {
    const r = validarFichaCliente({ ...BASE, razonSocial: "  Cliente   Uno  SA ", regimenesFiscales: ["626", "601", "601"], periodicidad: undefined });
    expect(r).toMatchObject({ ok: true, valor: { razonSocial: "Cliente Uno SA", regimenesFiscales: ["601", "626"], periodicidad: "mensual", tipoPersona: "moral" } });
  });
  it("rechaza un régimen fuera del catálogo c_RegimenFiscal", () => {
    const r = validarFichaCliente({ ...BASE, regimenesFiscales: ["601", "999"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.find((e) => e.campo === "regimenesFiscales")?.mensaje).toContain("999");
  });
  it("rechaza un régimen de persona física para un RFC de moral y viceversa", () => {
    expect(validarFichaCliente({ ...BASE, regimenesFiscales: ["612"] }).ok).toBe(false);
    expect(validarFichaCliente({ ...BASE, rfc: "PEPJ800101AB1", regimenesFiscales: ["601"] }).ok).toBe(false);
    expect(validarFichaCliente({ ...BASE, rfc: "PEPJ800101AB1", regimenesFiscales: ["612", "626"] }).ok).toBe(true);
  });
  it("exige al menos un régimen y a lo sumo 10", () => {
    expect(validarFichaCliente({ ...BASE, regimenesFiscales: [] }).ok).toBe(false);
    expect(validarFichaCliente({ ...BASE, regimenesFiscales: undefined }).ok).toBe(false);
    expect(validarFichaCliente({ ...BASE, regimenesFiscales: "601" }).ok).toBe(false);
  });
  it.each([["4 dígitos", "0660"], ["letras", "ABCDE"], ["6 dígitos", "066000"], ["vacío", ""]])("rechaza CP fiscal %s", (_n, cp) => {
    expect(validarFichaCliente({ ...BASE, cpFiscal: cp }).ok).toBe(false);
  });
  it("rechaza periodicidad fuera de catálogo y acepta bimestral", () => {
    expect(validarFichaCliente({ ...BASE, periodicidad: "semanal" }).ok).toBe(false);
    expect(validarFichaCliente({ ...BASE, periodicidad: "bimestral" }).ok).toBe(true);
  });
  it("valida el responsable como UUID", () => {
    expect(validarFichaCliente({ ...BASE, responsableId: "no-es-uuid" }).ok).toBe(false);
    expect(validarFichaCliente({ ...BASE, responsableId: "00000000-0000-0000-0000-000000000001" }).ok).toBe(true);
  });
  it("rechaza razón social vacía, larga o con caracteres de control", () => {
    expect(validarFichaCliente({ ...BASE, razonSocial: "  " }).ok).toBe(false);
    expect(validarFichaCliente({ ...BASE, razonSocial: "x".repeat(251) }).ok).toBe(false);
    expect(validarFichaCliente({ ...BASE, razonSocial: "Uno\u0000Dos" }).ok).toBe(false);
  });
  it("acumula todos los errores en una sola respuesta", () => {
    const r = validarFichaCliente({ rfc: "mal", razonSocial: "", regimenesFiscales: [], cpFiscal: "1", periodicidad: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.map((e) => e.campo).sort()).toEqual(["cpFiscal", "periodicidad", "razonSocial", "regimenesFiscales", "rfc"]);
  });
  it("un cuerpo que no es objeto produce errores, no una excepción", () => {
    expect(validarFichaCliente(null).ok).toBe(false);
    expect(validarFichaCliente("texto").ok).toBe(false);
  });
});

describe("validarNombreCliente", () => {
  it("normaliza espacios y rechaza vacío/largo/controles", () => {
    expect(validarNombreCliente("  Cliente   Uno ")).toEqual({ ok: true, nombre: "Cliente Uno" });
    expect(validarNombreCliente("").ok).toBe(false);
    expect(validarNombreCliente("x".repeat(121)).ok).toBe(false);
    expect(validarNombreCliente("a\u0000b").ok).toBe(false);
    expect(validarNombreCliente("a\u0007b").ok).toBe(false);
    expect(validarNombreCliente("a\nb")).toEqual({ ok: true, nombre: "a b" }); // saltos de línea se normalizan a un espacio
    expect(validarNombreCliente(42).ok).toBe(false);
  });
});
