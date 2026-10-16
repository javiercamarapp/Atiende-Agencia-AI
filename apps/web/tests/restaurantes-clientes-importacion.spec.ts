// @vitest-environment jsdom
//
// Importacion de cartera: lectura de CSV y Excel en el navegador, mapeo asistido de columnas y huella del archivo.
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  ArchivoImportacionError,
  construirFilas,
  huellaSha256,
  leerArchivoClientes,
  parsearCsv,
  parsearXlsx,
  sugerirMapeo,
} from "../src/verticals/restaurantes/lib/clientes-importacion.ts";

describe("parsearCsv", () => {
  it("separa por coma, respeta comillas, comillas dobles escapadas y saltos de linea dentro de una celda", () => {
    const filas = parsearCsv('nombre,telefono,notas\n"Ana, la del 5",9991230001,"dijo ""hola""\nsegunda linea"\nBeto,9991230002,\n');
    expect(filas).toEqual([
      ["nombre", "telefono", "notas"],
      ["Ana, la del 5", "9991230001", 'dijo "hola"\nsegunda linea'],
      ["Beto", "9991230002", ""],
    ]);
  });

  it("detecta punto y coma y tabulador, quita el BOM y ignora renglones vacios; CRLF", () => {
    expect(parsearCsv("﻿nombre;telefono\r\nAna;9991230001\r\n\r\n")).toEqual([
      ["nombre", "telefono"],
      ["Ana", "9991230001"],
    ]);
    expect(parsearCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("sugerirMapeo y construirFilas", () => {
  it("reconoce encabezados comunes en espanol (con acentos) y no repite una columna", () => {
    const m = sugerirMapeo(["Nombre del cliente", "Teléfono", "Dirección", "Colonia", "Comentarios"]);
    expect(m).toEqual({ telefono: 1, nombre: 0, direccion: 2, colonia: 3, notas: 4 });
  });

  it("sin coincidencias deja el campo sin mapear", () => {
    expect(sugerirMapeo(["A", "B"])).toEqual({ telefono: null, nombre: null, direccion: null, colonia: null, notas: null });
  });

  it("arma los renglones segun el mapeo (campo sin mapear = vacio) y recorta espacios", () => {
    const filas = construirFilas([[" Ana ", "9991230001", "x"]], { telefono: 1, nombre: 0, direccion: null, colonia: null, notas: null });
    expect(filas).toEqual([{ telefono: "9991230001", nombre: "Ana", direccion: "", colonia: "", notas: "" }]);
  });
});

function xlsxDePrueba(filas: Array<Array<string | number>>): Uint8Array {
  const compartidas: string[] = [];
  const cel = (v: string | number, c: number, r: number) => {
    const ref = `${String.fromCharCode(65 + c)}${r}`;
    if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
    compartidas.push(v);
    return `<c r="${ref}" t="s"><v>${compartidas.length - 1}</v></c>`;
  };
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${filas.map((f, i) => `<row r="${i + 1}">${f.map((v, c) => cel(v, c, i + 1)).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const sst = `<?xml version="1.0"?><sst>${compartidas.map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`;
  return zipSync({ "xl/worksheets/sheet1.xml": strToU8(sheet), "xl/sharedStrings.xml": strToU8(sst), "xl/workbook.xml": strToU8("<workbook/>") });
}

describe("parsearXlsx", () => {
  it("lee texto compartido y numeros (un telefono guardado como numero se lee entero)", () => {
    const filas = parsearXlsx(xlsxDePrueba([["Nombre", "Teléfono"], ["Ana", 9991230001], ["Beto", "9991230002"]]));
    expect(filas).toEqual([
      ["Nombre", "Teléfono"],
      ["Ana", "9991230001"],
      ["Beto", "9991230002"],
    ]);
  });

  it("un archivo que no es xlsx da un error claro", () => {
    expect(() => parsearXlsx(new TextEncoder().encode("esto no es un zip"))).toThrow(ArchivoImportacionError);
  });
});

describe("huella y lectura de archivos", () => {
  it("SHA-256 en hexadecimal minusculas (vector conocido de 'abc')", async () => {
    expect(await huellaSha256(new TextEncoder().encode("abc").buffer as ArrayBuffer)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("el mismo archivo da la misma huella y uno distinto otra", async () => {
    const a = await leerArchivoClientes(new File(["nombre,telefono\nAna,9991230001\n"], "a.csv", { type: "text/csv" }));
    const b = await leerArchivoClientes(new File(["nombre,telefono\nAna,9991230001\n"], "otro-nombre.csv", { type: "text/csv" }));
    const c = await leerArchivoClientes(new File(["nombre,telefono\nAna,9991230002\n"], "a.csv", { type: "text/csv" }));
    expect(a.huella).toBe(b.huella);
    expect(a.huella).not.toBe(c.huella);
    expect(a.huella).toMatch(/^[0-9a-f]{64}$/);
    expect(a.filas).toHaveLength(2);
  });

  it("rechaza formatos no admitidos y archivos vacios", async () => {
    await expect(leerArchivoClientes(new File(["x"], "clientes.pdf", { type: "application/pdf" }))).rejects.toThrow(/Formato no admitido/);
    await expect(leerArchivoClientes(new File([""], "vacio.csv", { type: "text/csv" }))).rejects.toThrow(/vacío/);
  });
});
