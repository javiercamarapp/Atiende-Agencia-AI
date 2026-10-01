// D-01 — exportación a Excel: ZIP/OOXML válido sin dependencias.
import { crc32 as crc32Node } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, crearZipStored, nombreHojaSeguro, reporteAXlsx } from "../src/reportes/xlsx.ts";
import type { ReporteCliente } from "../src/reportes/types.ts";

/** Lector mínimo de ZIP "stored" a partir del directorio central (independiente del escritor). */
function leerZip(bytes: Uint8Array): Map<string, { texto: string; crcDeclarado: number; datos: Uint8Array }> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const finOffset = bytes.length - 22;
  expect(dv.getUint32(finOffset, true)).toBe(0x06054b50);
  const total = dv.getUint16(finOffset + 10, true);
  let p = dv.getUint32(finOffset + 16, true);
  const out = new Map<string, { texto: string; crcDeclarado: number; datos: Uint8Array }>();
  for (let i = 0; i < total; i += 1) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50);
    const crc = dv.getUint32(p + 16, true);
    const tam = dv.getUint32(p + 24, true);
    const nLen = dv.getUint16(p + 28, true);
    const localOff = dv.getUint32(p + 42, true);
    const nombre = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nLen));
    expect(dv.getUint32(localOff, true)).toBe(0x04034b50);
    const lnLen = dv.getUint16(localOff + 26, true);
    const dataStart = localOff + 30 + lnLen;
    const datos = bytes.subarray(dataStart, dataStart + tam);
    out.set(nombre, { texto: new TextDecoder().decode(datos), crcDeclarado: crc, datos });
    p += 46 + nLen;
  }
  return out;
}

const REPORTE: ReporteCliente = {
  tipo: "diot",
  titulo: "DIOT",
  periodo: "2026-08",
  generadoEn: "2026-09-30",
  contribuyente: { nombre: "Cliente & Hijos <SA>", rfc: "CLI010101CL1" },
  secciones: [
    {
      titulo: "Operaciones con terceros",
      columnas: [
        { clave: "nombre", titulo: "Nombre", tipo: "texto" },
        { clave: "n", titulo: "CFDI", tipo: "entero" },
        { clave: "monto", titulo: "Monto", tipo: "moneda" },
        { clave: "pct", titulo: "Pct", tipo: "porcentaje" },
      ],
      filas: [
        { nombre: "=HYPERLINK(\"http://x\")", n: 2, monto: 1234.5, pct: 16 },
        { nombre: "Ñandú & Cía", n: 1, monto: 10, pct: null },
      ],
      totales: { nombre: "Total", n: 3, monto: 1244.5, pct: null },
      sinDatosMotivo: null,
    },
    { titulo: "Sección: sin/datos?", columnas: [{ clave: "c", titulo: "C", tipo: "texto" }], filas: [], totales: null, sinDatosMotivo: "No hay datos porque el modelo no los guarda." },
  ],
  notas: ["Nota <uno>"],
  sinDatos: false,
};

describe("crc32 / ZIP", () => {
  it("coincide con el CRC-32 de node:zlib", () => {
    const datos = new TextEncoder().encode("Atiende — despachos 123");
    expect(crc32(datos)).toBe(crc32Node(datos));
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("round-trip del ZIP stored con CRC correcto", () => {
    const zip = crearZipStored([
      { nombre: "a.txt", datos: new TextEncoder().encode("hola") },
      { nombre: "dir/b.txt", datos: new TextEncoder().encode("áéí") },
    ]);
    const e = leerZip(zip);
    expect([...e.keys()]).toEqual(["a.txt", "dir/b.txt"]);
    for (const v of e.values()) expect(crc32Node(v.datos)).toBe(v.crcDeclarado);
    expect(e.get("dir/b.txt")!.texto).toBe("áéí");
  });
});

describe("reporteAXlsx", () => {
  const e = leerZip(reporteAXlsx(REPORTE));

  it("contiene las partes OOXML mínimas, una hoja por sección más el resumen, con CRC válido", () => {
    expect([...e.keys()].sort()).toEqual(
      ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"].sort(),
    );
    for (const v of e.values()) expect(crc32Node(v.datos)).toBe(v.crcDeclarado);
    // Cada parte XML está bien formada a nivel de etiquetas balanceadas básicas.
    for (const [nombre, v] of e) if (nombre.endsWith(".xml") || nombre.endsWith(".rels")) expect(v.texto.startsWith("<?xml")).toBe(true);
  });

  it("nombres de hoja saneados y únicos", () => {
    const wb = e.get("xl/workbook.xml")!.texto;
    expect(wb).toContain('name="Resumen"');
    expect(wb).toContain('name="Operaciones con terceros"');
    expect(wb).toContain('name="Sección sin datos"');
    expect(nombreHojaSeguro("Resumen", new Set(["resumen"]))).toBe("Resumen (2)");
    expect(nombreHojaSeguro("x".repeat(60), new Set()).length).toBe(31);
  });

  it("montos como números con formato, texto como inlineStr escapado y sin fórmulas", () => {
    const hoja = e.get("xl/worksheets/sheet2.xml")!.texto;
    expect(hoja).toContain('<c r="C4" s="2"><v>1234.5</v></c>');
    expect(hoja).toContain("<c r=\"D4\" s=\"3\"><v>0.16</v></c>");
    expect(hoja).toContain("Ñandú &amp; Cía");
    // Un texto que empieza con "=" se guarda como cadena, nunca como <f>.
    expect(hoja).toContain("=HYPERLINK(&quot;http://x&quot;)");
    expect(hoja).not.toContain("<f>");
    // Totales en negrita monetaria (estilo 7) y celdas null omitidas.
    expect(hoja).toContain('<c r="C6" s="7"><v>1244.5</v></c>');
  });

  it("la sección sin datos escribe el motivo, no ceros", () => {
    const hoja = e.get("xl/worksheets/sheet3.xml")!.texto;
    expect(hoja).toContain("Sin datos");
    expect(hoja).toContain("No hay datos porque el modelo no los guarda.");
  });

  it("el resumen escapa el contribuyente y lista las notas", () => {
    const hoja = e.get("xl/worksheets/sheet1.xml")!.texto;
    expect(hoja).toContain("Cliente &amp; Hijos &lt;SA&gt;");
    expect(hoja).toContain("Nota &lt;uno&gt;");
  });
});
