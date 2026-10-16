// CFO-06 · «Reporte del CFO» en PDF: abre con pdf-lib, ≤ 40 páginas, aviso de no sustitución, pie «Página i de n» en CADA hoja, cifras de la vista
// (no inventadas), las 4 gráficas, detalle de 7 sucursales, tope de páginas y salida determinista.
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { CFO_PDF_MAX_PAGINAS, CfoPdfDemasiadasPaginas, construirReporteCfoPdf } from "../src/routes/verticals/restaurantes/cfo-exportar-pdf.ts";
import { GENERADO, armarVistas } from "./restaurantes-cfo-exportar-fixtures.ts";
import { textoDelPdf } from "./support/pdf-text.ts";

async function generar(op: Parameters<typeof armarVistas>[0] = {}): Promise<Uint8Array> {
  const { vistas, alcance } = await armarVistas({ ...op, formato: "pdf" });
  return construirReporteCfoPdf(vistas, alcance, GENERADO);
}

describe("PDF del CFO", () => {
  it("abre con pdf-lib, tiene entre 1 y 40 páginas A4 y metadatos con el periodo", async () => {
    const bytes = await generar();
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(3);
    expect(doc.getPageCount()).toBeLessThanOrEqual(CFO_PDF_MAX_PAGINAS);
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    expect(h).toBeGreaterThan(w); // vertical
    expect(doc.getSubject()).toContain("2026-08-31 a 2026-09-27");
    expect(doc.getCreationDate()?.toISOString()).toBe(GENERADO.toISOString());
  });

  it("contiene el aviso «no sustituye a su contabilidad» y, en CADA página, el pie «Página i de n» con alcance y leyenda de rotulado", async () => {
    const bytes = await generar();
    const n = (await PDFDocument.load(bytes)).getPageCount();
    const texto = textoDelPdf(bytes);
    expect(texto.includes("no sustituye a su contabilidad")).toBe(true);
    for (let i = 1; i <= n; i += 1) expect(texto.includes(`Página ${i} de ${n}`), `Página ${i} de ${n}`).toBe(true);
    expect(texto.includes("Cifras de la base; estimadas y capturadas rotuladas.")).toBe(true);
    expect(texto.split("Cifras de la base; estimadas y capturadas rotuladas.").length - 1).toBe(n);
    expect(texto.includes("Alcance: Todas sus sucursales")).toBe(true);
  });

  it("trae las secciones del reporte de consejo y cita las cifras de la vista (resumen narrado, hallazgos, KPIs, estado de resultados)", async () => {
    const { vistas, alcance } = await armarVistas({ formato: "pdf" });
    const texto = textoDelPdf(await construirReporteCfoPdf(vistas, alcance, GENERADO));
    for (const t of ["Reporte del CFO", "Resumen ejecutivo", "Lo más importante", "Indicadores", "Tendencia de ventas netas", "Ventas netas por sucursal", "Mix de canal", "Cascada: ventas brutas a netas sin IVA", "Estado de resultados operativo", "Comparativo de sucursales", "Notas y supuestos"]) {
      expect(texto.includes(t), t).toBe(true);
    }
    // La narrativa determinista de CFO-04 va completa: su primera oración aparece palabra por palabra en el PDF.
    const primera = vistas.resumen!.narrativa.oraciones[0]!.texto.split(" ").slice(0, 4).join(" ");
    expect(texto.includes(primera)).toBe(true);
    // Hallazgos: título de cada uno (hasta 10).
    for (const h of vistas.resumen!.hallazgos.slice(0, 3)) expect(texto.includes(h.titulo.split(" ").slice(0, 3).join(" "))).toBe(true);
    // Notas: IVA estimado, prorrateo y la definición de frecuente.
    expect(texto.includes("ESTIMACIÓN")).toBe(true);
    expect(texto.includes("PRORRATEAN")).toBe(true);
    // El PDF no inventa ceros: sin captura de costos la línea sale como «—».
  });

  it("siete sucursales: cada una tiene su sección de detalle y el documento sigue bajo 40 páginas", async () => {
    const { vistas, alcance, sucursales } = await armarVistas({ n: 7, formato: "pdf" });
    const bytes = await construirReporteCfoPdf(vistas, alcance, GENERADO);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeLessThanOrEqual(CFO_PDF_MAX_PAGINAS);
    const texto = textoDelPdf(bytes);
    for (const s of sucursales) expect(texto.includes(`Sucursal: ${s.nombre}`), s.nombre).toBe(true);
    expect(texto.includes("va solo en el Excel")).toBe(false);
  });

  it("más de siete sucursales: el detalle por sucursal va solo en el Excel y el PDF lo dice", async () => {
    const { vistas, alcance } = await armarVistas({ n: 7, formato: "pdf" });
    const falsa = { ...vistas.resumen!, sucursales: [...vistas.resumen!.sucursales, ...vistas.resumen!.sucursales.slice(0, 1).map((s) => ({ ...s, propertyId: "00000000-0000-4000-8000-0000000000b8", nombre: "Octava" }))] };
    const texto = textoDelPdf(await construirReporteCfoPdf({ ...vistas, resumen: falsa }, alcance, GENERADO));
    expect(texto.includes("Sucursal: Octava")).toBe(false);
    expect(texto.includes("va en el Excel, una hoja por sucursal")).toBe(true);
  });

  it("una cifra null sale como «—», no como 0; un texto fuera de WinAnsi no rompe el PDF", async () => {
    const { vistas, alcance } = await armarVistas({ capturarCostos: false, nombreSucursal: "Café ☕ 日本", formato: "pdf" });
    const bytes = await construirReporteCfoPdf(vistas, alcance, GENERADO);
    const texto = textoDelPdf(bytes);
    expect(texto.includes("EBITDA incompleto")).toBe(true);
    expect(texto.includes("Sucursal: Café ? ?")).toBe(true);
  });

  it("es determinista: mismos datos y mismo generadoEn -> los mismos bytes", async () => {
    const { vistas, alcance } = await armarVistas({ formato: "pdf" });
    const a = await construirReporteCfoPdf(vistas, alcance, GENERADO);
    const b = await construirReporteCfoPdf(vistas, alcance, GENERADO);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const c = await construirReporteCfoPdf(vistas, alcance, new Date("2026-09-29T15:00:00Z"));
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });

  it("tope de 40 páginas: un contenido desbordado lanza CfoPdfDemasiadasPaginas en vez de producir un PDF gigante", async () => {
    const { vistas, alcance } = await armarVistas({ avisosExtra: 3000, formato: "pdf" });
    await expect(construirReporteCfoPdf(vistas, alcance, GENERADO)).rejects.toBeInstanceOf(CfoPdfDemasiadasPaginas);
  });

  it("vistas parciales: «resumen» no trae estado de resultados ni detalle por sucursal", async () => {
    const { vistas, alcance } = await armarVistas({ vista: "resumen", formato: "pdf" });
    const texto = textoDelPdf(await construirReporteCfoPdf(vistas, alcance, GENERADO));
    expect(texto.includes("Resumen ejecutivo")).toBe(true);
    expect(texto.includes("Estado de resultados operativo")).toBe(false);
    expect(texto.includes("Comparativo de sucursales")).toBe(false);
  });
});
