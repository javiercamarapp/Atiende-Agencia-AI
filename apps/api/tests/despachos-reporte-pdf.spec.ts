// D-01 — render PDF de un reporte de cliente (pdf-lib): estructura válida, paginación con
// encabezado repetido, texto en español y robustez ante caracteres fuera de WinAnsi.
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { construirReporteImpuestos } from "@atiende/domain-despachos";
import type { ReporteCliente } from "@atiende/domain-despachos";
import { formatearCelda, reporteAPdf } from "../src/routes/verticals/despachos/reporte-pdf.ts";

/** Texto dibujado por pdf-lib: los streams de contenido vienen comprimidos (Flate); se inflan y se leen las cadenas
 * hexadecimales `<...> Tj` (fuentes estándar, WinAnsi ~ latin1). */
function textoDelPdf(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const latin = raw.toString("latin1");
  let out = "";
  for (const m of latin.matchAll(/stream\r?\n/g)) {
    const inicio = m.index! + m[0].length;
    const fin = latin.indexOf("endstream", inicio);
    if (fin < 0) continue;
    let contenido: string;
    try {
      contenido = inflateSync(raw.subarray(inicio, fin)).toString("latin1");
    } catch {
      contenido = latin.slice(inicio, fin);
    }
    for (const t of contenido.matchAll(/<([0-9A-Fa-f]{2,})>\s*Tj/g)) {
      const hex = t[1]!;
      for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      out += "\n";
    }
  }
  return out;
}

const BASE: ReporteCliente = {
  tipo: "diot",
  titulo: "DIOT (Declaración Informativa de Operaciones con Terceros)",
  periodo: "2026-08",
  generadoEn: "2026-09-30",
  contribuyente: { nombre: "Cliente Ñandú, S.A. de C.V.", rfc: "CLI010101CL1" },
  secciones: [
    {
      titulo: "Operaciones con terceros",
      columnas: [
        { clave: "rfc", titulo: "RFC del tercero", tipo: "texto" },
        { clave: "nombre", titulo: "Nombre o razón social", tipo: "texto" },
        { clave: "n", titulo: "CFDI", tipo: "entero" },
        { clave: "monto", titulo: "Valor de actos (base)", tipo: "moneda" },
      ],
      filas: [{ rfc: "AAA010101AAA", nombre: "Proveedor Único → ✓ 😀", n: 2, monto: 1234.5 }],
      totales: { rfc: "Total", nombre: null, n: 2, monto: 1234.5 },
      sinDatosMotivo: null,
    },
    { titulo: "Desglose por empleado", columnas: [{ clave: "c", titulo: "Concepto", tipo: "texto" }], filas: [], totales: null, sinDatosMotivo: "No se persiste la nómina procesada." },
  ],
  notas: ["Reporte informativo; no sustituye la presentación ante el SAT."],
  sinDatos: false,
};

describe("formatearCelda", () => {
  it("formatea moneda MXN, enteros, porcentajes y null", () => {
    expect(formatearCelda(1234.5, { clave: "m", titulo: "m", tipo: "moneda" })).toMatch(/1,234\.50/);
    expect(formatearCelda(1234, { clave: "n", titulo: "n", tipo: "entero" })).toBe("1,234");
    expect(formatearCelda(16, { clave: "p", titulo: "p", tipo: "porcentaje" })).toBe("16.0 %");
    expect(formatearCelda(null, { clave: "x", titulo: "x", tipo: "texto" })).toBe("");
  });
});

describe("reporteAPdf", () => {
  it("genera un PDF válido con metadatos deterministas y el contenido real del reporte", async () => {
    const bytes = await reporteAPdf(BASE);
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toContain("Cliente Ñandú");
    expect(doc.getCreationDate()?.toISOString().slice(0, 10)).toBe("2026-09-30");

    const texto = textoDelPdf(bytes);
    expect(texto).toContain("DIOT (Declaración Informativa de Operaciones con Terceros)");
    expect(texto).toContain("RFC: CLI010101CL1");
    expect(texto).toContain("Operaciones con terceros");
    expect(texto).toContain("AAA010101AAA");
    expect(texto).toMatch(/\$1,234\.50/);
    expect(texto).toContain("Sin datos");
    expect(texto).toContain("No se persiste la nómina procesada.");
    expect(texto).toContain("Página 1 de 1");
    // Caracteres fuera de WinAnsi (flecha, palomita, emoji) no rompen el render: se sustituyen.
    expect(texto).toContain("Proveedor Único ? ? ?");
  });

  it("misma entrada produce el mismo PDF (sin reloj ni aleatoriedad)", async () => {
    const [a, b] = await Promise.all([reporteAPdf(BASE), reporteAPdf(BASE)]);
    // pdf-lib agrega un /ID aleatorio al trailer solo en `save` con ciertas opciones; comparamos el contenido de páginas.
    expect(textoDelPdf(a)).toBe(textoDelPdf(b));
  });

  it("una tabla larga pagina y repite el encabezado en cada página, con numeración", async () => {
    const filas = Array.from({ length: 120 }, (_, i) => ({ rfc: `RFC${String(i).padStart(3, "0")}`, nombre: `Proveedor ${i}`, n: 1, monto: i * 10 }));
    const grande: ReporteCliente = { ...BASE, secciones: [{ ...BASE.secciones[0]!, filas, totales: null }] };
    const bytes = await reporteAPdf(grande);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(2);
    const texto = textoDelPdf(bytes);
    expect(texto.split("RFC del tercero").length - 1).toBe(doc.getPageCount()); // encabezado en cada página
    expect(texto).toContain(`Página ${doc.getPageCount()} de ${doc.getPageCount()}`);
    expect(texto).toContain("RFC119");
  });

  it("un reporte sin datos lo dice explícitamente", async () => {
    const vacio: ReporteCliente = { ...BASE, contribuyente: { nombre: "Cliente", rfc: null }, sinDatos: true, secciones: [BASE.secciones[1]!] };
    const texto = textoDelPdf(await reporteAPdf(vacio));
    expect(texto).toContain("Sin datos para el período indicado.");
    expect(texto).toContain("RFC: sin datos (sin ficha de cartera)");
  });

  it("D-P3-05: el reporte de impuestos sin papel guardado imprime el motivo verdadero y el papel guardado imprime sus cifras", async () => {
    const entrada = { periodo: "2026-08", generadoEn: "2026-09-30", contribuyente: { nombre: "Cliente" }, rfcContribuyente: "CLI010101CL1" };
    const sin = textoDelPdf(await reporteAPdf(construirReporteImpuestos(entrada, [], { estado: "disponible", papeles: [] })));
    expect(sin).toContain("No se ha generado el papel de pagos provisionales de 2026-08");
    expect(sin).not.toContain("no persiste");
    const papel = { id: "p", ejercicio: 2026, mes: 8, impuesto: "IVA" as const, regimen: "601", baseCentavos: 1_000_000, determinadoCentavos: 160_000, acreditableCentavos: 64_000, aCargoCentavos: 96_000, aFavorCentavos: 0, parametros: {}, advertencias: 0, estado: "borrador" as const, montoPagadoCentavos: null, fechaPresentacion: null, updatedAt: "2026-09-01T00:00:00Z" };
    const con = textoDelPdf(await reporteAPdf(construirReporteImpuestos(entrada, [], { estado: "disponible", papeles: [papel] })));
    expect(con).toContain("Borrador");
    expect(con).toContain("RFC: CLI010101CL1");
  });

  it("una palabra más ancha que la celda se corta en vez de salirse de la página", async () => {
    const largo: ReporteCliente = { ...BASE, secciones: [{ ...BASE.secciones[0]!, filas: [{ rfc: "X".repeat(400), nombre: "n", n: 1, monto: 1 }], totales: null }] };
    await expect(reporteAPdf(largo)).resolves.toBeInstanceOf(Uint8Array);
  });
});
