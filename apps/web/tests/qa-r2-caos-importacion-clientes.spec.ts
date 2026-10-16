// @vitest-environment jsdom
//
// QA restaurantes, RONDA 2, lente EXCEPCIONES Y CAOS: importacion de cartera (#435) con archivos reales "sucios" del mundo de PM
// (Excel en espanol de Windows, exportaciones de sistemas .NET). Solo lectura en el navegador; no se manda nada a ninguna base.
// Cada prueba QA-R2-caos-NN fija la correccion de su defecto (QA-restaurantes-R2-caos-NN).
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { huellaConMapeo, leerArchivoClientes, parsearXlsx } from "../src/verticals/restaurantes/lib/clientes-importacion.ts";

/** Texto en Windows-1252 (lo que guarda Excel en espanol con "CSV (delimitado por comas)"): cada caracter Latin-1 es un byte. */
function bytesWindows1252(texto: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...texto].map((ch) => ch.charCodeAt(0) & 0xff));
}

describe("R2-caos-06: CSV de Excel en espanol (Windows-1252)", () => {
  // Pasos: Clientes -> Importar -> elegir el CSV que exporto Excel de Windows en espanol ("CSV (delimitado por comas)", codificacion ANSI/1252)
  // con "José Peña" y "Muñoz". La vista previa y la importacion usan esos nombres; el agente saluda al cliente con su nombre (Cliente 360).
  it("QA-R2-caos-06: los acentos y la ñ de un CSV en Windows-1252 se leen bien (o se avisa del problema de codificacion antes de importar)", async () => {
    const bytes = bytesWindows1252("nombre,telefono,colonia\nJosé Peña,9991230001,Itzimná\nMaría Muñoz,9991230002,García Ginerés\n");
    const leido = await leerArchivoClientes(new File([bytes], "clientes.csv", { type: "text/csv" }));
    // Actual: "Jos� Pe�a" (caracter de reemplazo) en silencio; la funcion SQL nunca pisa un nombre ya conocido, asi que el error queda
    // para siempre aunque despues se importe el archivo bueno (ver R2-caos-07).
    expect(leido.filas[1]).toEqual(["José Peña", "9991230001", "Itzimná"]);
    expect(leido.filas[2]?.[0]).toBe("María Muñoz");
  });

  it("PASA: el mismo contenido en UTF-8 (con o sin BOM) se lee bien", async () => {
    const leido = await leerArchivoClientes(new File(["﻿nombre,telefono\nJosé Peña,9991230001\n"], "clientes.csv", { type: "text/csv" }));
    expect(leido.filas[1]).toEqual(["José Peña", "9991230001"]);
  });
});

describe("R2-caos-08: .xlsx con prefijo de espacio de nombres (exportaciones .NET / OpenXML SDK)", () => {
  // Pasos: importar un .xlsx valido cuyo XML usa prefijo (`<x:worksheet><x:sheetData><x:row><x:c>`), como lo escriben el OpenXML SDK y varios
  // sistemas de punto de venta de Windows. Excel lo abre sin problema.
  it("QA-R2-caos-08: un .xlsx con elementos prefijados (x:row, x:c) se lee igual que uno sin prefijo", () => {
    const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const hoja =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><x:worksheet xmlns:x="${ns}"><x:sheetData>` +
      `<x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>nombre</x:t></x:is></x:c><x:c r="B1" t="inlineStr"><x:is><x:t>telefono</x:t></x:is></x:c></x:row>` +
      `<x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>Ana</x:t></x:is></x:c><x:c r="B2"><x:v>9991230001</x:v></x:c></x:row>` +
      `</x:sheetData></x:worksheet>`;
    const xlsx = zipSync({ "xl/worksheets/sheet1.xml": strToU8(hoja), "xl/workbook.xml": strToU8(`<x:workbook xmlns:x="${ns}"/>`) });
    // Actual: [] -> "El archivo está vacío." aunque trae datos.
    expect(parsearXlsx(xlsx)).toEqual([
      ["nombre", "telefono"],
      ["Ana", "9991230001"],
    ]);
  });
});

describe("R2-caos-07: la huella de una importacion es archivo + mapeo", () => {
  const MAPEO_A = { telefono: 1, nombre: 0, direccion: null, colonia: null, notas: null } as const;
  const MAPEO_B = { telefono: 1, nombre: 2, direccion: null, colonia: null, notas: null } as const;

  it("el mismo archivo con otro mapeo tiene otra huella; con el mismo mapeo, la misma", async () => {
    const huella = "c".repeat(64);
    const a = await huellaConMapeo(huella, MAPEO_A);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await huellaConMapeo(huella, MAPEO_A)).toBe(a);
    expect(await huellaConMapeo(huella, MAPEO_B)).not.toBe(a);
    expect(await huellaConMapeo("d".repeat(64), MAPEO_A)).not.toBe(a);
  });
});
