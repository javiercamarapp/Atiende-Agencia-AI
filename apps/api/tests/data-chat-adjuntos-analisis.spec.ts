// Analisis de archivos adjuntos del Copiloto (CSV / Excel / PDF): puro y determinista, sin red. Cubre el perfil por columna, la regla de datos personales
// (nunca se listan valores), los formatos de numero, las celdas citadas del CSV, un .xlsx real armado en memoria, un PDF real (pdf-lib) y los limites.
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ADJUNTO_MAX_BYTES, analizarAdjunto, numeroDe, parsearCsv, parsearXlsx, tipoDeAdjunto } from "../src/data-chat/adjuntos-analisis.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const filas = (r: Awaited<ReturnType<typeof analizarAdjunto>>) => {
  if (!r.ok) throw new Error(`fallo: ${r.motivo}`);
  return r.respuesta.blocks[0]!.rows as Record<string, string | number | null>[];
};

async function xlsx(hoja: string, compartidas: string[] = []): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", `<workbook><sheets><sheet name="Ventas" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/hoja-uno.xml"/></Relationships>`);
  zip.file("xl/sharedStrings.xml", `<sst>${compartidas.map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`);
  zip.file("xl/worksheets/hoja-uno.xml", `<worksheet><sheetData>${hoja}</sheetData></worksheet>`);
  return zip.generateAsync({ type: "uint8array" });
}

describe("numeroDe", () => {
  it("entiende los formatos comunes de captura y rechaza lo que no es numero", () => {
    expect(numeroDe("1234.5")).toBe(1234.5);
    expect(numeroDe("1,234.50")).toBe(1234.5);
    expect(numeroDe("$ 1,200")).toBe(1200);
    expect(numeroDe("1.234,56")).toBe(1234.56);
    expect(numeroDe("12,5")).toBe(12.5);
    expect(numeroDe("-7")).toBe(-7);
    expect(numeroDe("15%")).toBe(15);
    for (const x of ["", "abc", "12abc", "1,2,3", "2026-10-02"]) expect(numeroDe(x), x).toBeNull();
  });
});

describe("parsearCsv", () => {
  it("detecta el separador (coma, punto y coma, tabulador), respeta comillas con separadores y saltos de linea, y quita el BOM", () => {
    expect(parsearCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parsearCsv("a;b\r\n1;2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parsearCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parsearCsv('﻿nota,monto\n"hola, mundo ""x""\nlinea 2",5')).toEqual([["nota", "monto"], ['hola, mundo "x"\nlinea 2', "5"]]);
  });
  it("ignora lineas vacias y mas de 50,000 filas se rechazan sin reventar", () => {
    expect(parsearCsv("a,b\n\n1,2\n\n")).toEqual([["a", "b"], ["1", "2"]]);
    const enorme = `x\n${"1\n".repeat(50_005)}`;
    expect(() => parsearCsv(enorme)).toThrow(/50,000 filas/);
  });
});

describe("tipoDeAdjunto: manda el contenido, no solo la extension", () => {
  it("PDF por cabecera, Excel por extension + zip, CSV/TSV/TXT; lo demas no", () => {
    expect(tipoDeAdjunto("x.dat", enc("%PDF-1.7"))).toBe("pdf");
    expect(tipoDeAdjunto("x.pdf", enc("no es un pdf"))).toBeNull();
    expect(tipoDeAdjunto("x.xlsx", Uint8Array.from([0x50, 0x4b, 3, 4]))).toBe("xlsx");
    expect(tipoDeAdjunto("x.xlsx", enc("texto"))).toBeNull();
    expect(tipoDeAdjunto("ventas.CSV", enc("a,b"))).toBe("csv");
    expect(tipoDeAdjunto("x.csv", Uint8Array.from([0x50, 0x4b, 3, 4]))).toBeNull();
    expect(tipoDeAdjunto("virus.exe", enc("MZ"))).toBeNull();
  });
});

describe("analizarAdjunto: CSV", () => {
  const CSV = ["producto,unidades,precio,fecha,notas", "Taco,10,$25.50,2026-10-01 12:00:00,", "Torta,5,40,2026-10-02 13:30:00,sin cebolla", "Taco,3,25.50,2026-10-02 14:00:00,"].join("\n");

  it("perfila cada columna: tipo, con dato, distintos, suma, promedio, minimo y maximo", async () => {
    const r = await analizarAdjunto("ventas.csv", enc(CSV));
    expect(r.ok && r.tipo).toBe("csv");
    const f = filas(r);
    expect(f.find((x) => x["columna"] === "unidades")).toMatchObject({ tipo: "numérica", con_dato: 3, distintos: 3, suma: 18, promedio: 6, minimo: 3, maximo: 10 });
    expect(f.find((x) => x["columna"] === "precio")).toMatchObject({ tipo: "numérica", suma: 91, minimo: 25.5, maximo: 40 });
    expect(f.find((x) => x["columna"] === "producto")).toMatchObject({ tipo: "texto", con_dato: 3, distintos: 2, suma: null });
    // una fecha con hora NO se confunde con un telefono; una columna sin una sola celda con dato se declara vacia
    expect(f.find((x) => x["columna"] === "fecha")).toMatchObject({ tipo: "texto", distintos: 3 });
    expect(f.find((x) => x["columna"] === "notas")).toMatchObject({ tipo: "texto", con_dato: 1 });
    expect(r.ok && r.respuesta.text).toContain("3 filas de datos y 5 columnas");
    expect(r.ok && r.respuesta.sources[0]?.scopeLabel).toBe("Solo este archivo");
  });

  it("columnas con datos personales (por encabezado o por contenido): solo se cuentan celdas con dato; nunca valores, distintos ni sumas", async () => {
    const csv = ["Cliente,contacto,sin_titulo,monto", "Ana Pérez,ana@correo.mx,999 123 4567,100", "Luis,luis@correo.mx,998 765 4321,200", "Marta,,,300"].join("\n");
    const r = await analizarAdjunto("clientes.csv", enc(csv));
    const f = filas(r);
    for (const col of ["Cliente", "contacto", "sin_titulo"]) {
      expect(f.find((x) => x["columna"] === col), col).toMatchObject({ tipo: "personal", distintos: null, suma: null, promedio: null, minimo: null, maximo: null });
    }
    expect(f.find((x) => x["columna"] === "Cliente")?.["con_dato"]).toBe(3);
    expect(f.find((x) => x["columna"] === "monto")).toMatchObject({ tipo: "numérica", suma: 600 });
    // nada del contenido personal viaja en la respuesta
    const todo = JSON.stringify(r.ok ? r.respuesta : r);
    for (const secreto of ["Ana", "Pérez", "luis@", "999 123", "998 765", "Marta"]) expect(todo, secreto).not.toContain(secreto);
    expect(r.ok && r.respuesta.text).toContain("con datos personales");
  });

  it("encabezados duplicados o vacios se desambiguan y un encabezado con un correo se redacta", async () => {
    const r = await analizarAdjunto("x.csv", enc("a,a,,dueño juan@x.mx\n1,2,3,4"));
    expect(filas(r).map((x) => x["columna"])).toEqual(["a", "a (2)", "Columna 3", "dueño [correo]"]);
  });

  it("archivo vacio, solo encabezado, tipo no soportado y mas de 5 MB se rechazan con un motivo honesto", async () => {
    expect(await analizarAdjunto("x.csv", new Uint8Array())).toMatchObject({ ok: false, motivo: "El archivo está vacío." });
    expect(await analizarAdjunto("x.csv", enc("a,b"))).toMatchObject({ ok: false, status: "invalid_input" });
    expect(await analizarAdjunto("x.exe", enc("MZ"))).toMatchObject({ ok: false, motivo: "Solo puedo leer archivos CSV, Excel (.xlsx) y PDF." });
    expect(await analizarAdjunto("x.csv", new Uint8Array(ADJUNTO_MAX_BYTES + 1))).toMatchObject({ ok: false, motivo: "El archivo supera los 5 MB." });
  });

  it("mas de 200 columnas se rechaza", async () => {
    const ancho = Array.from({ length: 201 }, (_, i) => `c${i}`).join(",");
    expect(await analizarAdjunto("x.csv", enc(`${ancho}\n${ancho}`))).toMatchObject({ ok: false, motivo: expect.stringContaining("200 columnas") });
  });
});

describe("analizarAdjunto: Excel", () => {
  it("lee la primera hoja (la que dice el libro), cadenas compartidas, numeros, cadenas en linea y celdas salteadas", async () => {
    const hoja = [
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>`,
      `<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>1500.5</v></c><c r="D2" t="inlineStr"><is><t>a &amp; b</t></is></c></row>`,
      `<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>500</v></c><c r="D3" t="b"><v>1</v></c></row>`,
    ].join("");
    const bytes = await xlsx(hoja, ["producto", "monto", "nota", "Cerveza"]);
    expect(await parsearXlsx(bytes)).toEqual([["producto", "monto", "", "nota"], ["Cerveza", "1500.5", "", "a & b"], ["Cerveza", "500", "", "verdadero"]]);
    const r = await analizarAdjunto("ventas.xlsx", bytes);
    expect(r.ok && r.tipo).toBe("xlsx");
    expect(filas(r).find((x) => x["columna"] === "monto")).toMatchObject({ tipo: "numérica", suma: 2000.5, promedio: 1000.25 });
    expect(filas(r).find((x) => x["columna"] === "Columna 3")).toMatchObject({ tipo: "vacía" });
    expect(r.ok && r.respuesta.text).toContain("primera hoja");
  });

  it("una bomba de descompresion (zip pequeno que se expande a mas de 30 MB) se corta y se rechaza sin llenar la memoria", async () => {
    const zip = new JSZip();
    zip.file("xl/workbook.xml", "0".repeat(32_000_000));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
    expect(bytes.byteLength).toBeLessThan(ADJUNTO_MAX_BYTES);
    expect(await analizarAdjunto("bomba.xlsx", bytes)).toMatchObject({ ok: false, status: "invalid_input", motivo: "La hoja de Excel es demasiado grande para analizarla." });
  });

  it("un zip que no es un libro de Excel o un archivo dañado se rechazan sin lanzar", async () => {
    const zip = new JSZip();
    zip.file("otra-cosa.txt", "hola");
    expect(await analizarAdjunto("x.xlsx", await zip.generateAsync({ type: "uint8array" }))).toMatchObject({ ok: false, status: "invalid_input" });
    expect(await analizarAdjunto("x.xlsx", Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]))).toMatchObject({ ok: false, motivo: expect.stringContaining("No pude abrir") });
  });
});

describe("analizarAdjunto: PDF", () => {
  async function pdf(paginas: string[]): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const fuente = await doc.embedFont(StandardFonts.Helvetica);
    for (const t of paginas) {
      const p = doc.addPage();
      if (t) p.drawText(t, { x: 40, y: 700, size: 12, font: fuente });
    }
    return doc.save();
  }

  it("cuenta paginas, palabras y caracteres y da un extracto con telefonos y correos ocultos", async () => {
    const r = await analizarAdjunto("contrato.pdf", await pdf(["Contrato de servicios con ana@correo.mx telefono 999 123 4567 por mil pesos", "Segunda pagina con texto"]));
    expect(r.ok && r.tipo).toBe("pdf");
    const f = filas(r);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ pagina: 1 });
    expect(r.ok && r.respuesta.text).toContain("2 páginas");
    expect(r.ok && r.respuesta.text).toContain("[correo]");
    expect(r.ok && r.respuesta.text).not.toContain("ana@correo.mx");
    expect(r.ok && r.respuesta.text).not.toContain("999 123 4567");
  });

  it("un PDF sin capa de texto (escaneado) se declara como tal, no como vacio", async () => {
    const r = await analizarAdjunto("escaneo.pdf", await pdf(["", ""]));
    expect(r).toMatchObject({ ok: false, status: "invalid_input" });
    expect(!r.ok && r.motivo).toContain("escaneado");
  });

  it("un PDF dañado se rechaza con un motivo honesto", async () => {
    expect(await analizarAdjunto("roto.pdf", enc("%PDF-1.4 esto no es un pdf valido"))).toMatchObject({ ok: false, status: "invalid_input" });
  });
});
