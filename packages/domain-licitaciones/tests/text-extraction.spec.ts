import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFNumber, PDFPageLeaf, PDFRef } from "pdf-lib";
import { extractDocumentText } from "../src/text-extraction.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures", "pdf");

/**
 * Genera un PDF genuino de `pdf-lib` con `pageCount` páginas en blanco de
 * `size`, usando la API de bajo nivel de `pdf-lib` en vez de `doc.addPage()`
 * en un bucle -- ver el caso "R6-11" más abajo para el porqué:
 * `insertLeafNode` (lo que usa `addPage`/`insertPage` por debajo) recorre
 * linealmente todo el array `Kids` en cada llamada, así que generar miles de
 * páginas secuencialmente es O(n²). Esta función inserta cada página en
 * O(1) (`PDFArray.push` + `context.register`, sin pasar por
 * `insertLeafNode`) construyendo el mismo árbol de páginas a mano con las
 * clases públicas de `pdf-lib`. El archivo resultante es indistinguible en
 * estructura del que produce `doc.addPage()` -- mismo número de objetos
 * `/Type/Page` reales, mismo tamaño aproximado -- solo cambia CÓMO de rápido
 * se fabrica.
 */
async function createBlankPageBombFast(pageCount: number, size: [number, number]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const pagesTree = doc.catalog.Pages();
  const pagesRef = doc.catalog.get(PDFName.of("Pages"));
  if (!(pagesRef instanceof PDFRef)) {
    throw new Error("createBlankPageBombFast: /Pages del catálogo no es una referencia indirecta -- inesperado en un PDFDocument recién creado con PDFDocument.create().");
  }
  const kids = pagesTree.Kids();
  const [width, height] = size;
  for (let i = 0; i < pageCount; i += 1) {
    const leaf = PDFPageLeaf.withContextAndParent(doc.context, pagesRef);
    leaf.set(PDFName.of("MediaBox"), doc.context.obj([0, 0, width, height]));
    kids.push(doc.context.register(leaf));
  }
  pagesTree.set(PDFName.of("Count"), PDFNumber.of(pageCount));
  return Buffer.from(await doc.save());
}

/**
 * Unitario de `text-extraction.ts` (Fase 11). Port ~literal de
 * `licitaciones/apps/api/test/expediente-text-extraction.test.ts` --
 * ejercita el motor real (`pdfjs-dist`) con PDFs genuinos, sin mockear la
 * librería de PDF.
 */
describe("extractDocumentText (Fase 11 -- pipeline real de extracción de texto de PDF)", () => {
  it("PDF con cross-reference STREAM (xref-stream, PDF 1.5+, el formato que genera pdf-lib/Word/navegadores modernos) se extrae página por página real", async () => {
    const buffer = readFileSync(path.join(FIXTURES_DIR, "xref-stream.pdf"));
    expect(buffer.toString("latin1")).toContain("/Type /XRef");
    expect(buffer.toString("latin1")).not.toContain("\ntrailer");

    const result = await extractDocumentText(buffer, { filename: "bases.pdf", mimeType: "application/pdf" });
    expect(result.status).toBe("extracted");
    expect(result.text).toContain("garantia de cumplimiento");
    expect(result.pageCount).toBe(1);
    expect(result.pages).toHaveLength(1);
    expect(result.pages![0]!.page).toBe(1);
    expect(result.pages![0]!.text).toContain("Anexo 3");
  });

  it("PDF con tabla xref CLÁSICA (PDF <=1.4) también se extrae correctamente -- no es una regresión al soportar xref-stream", async () => {
    const buffer = readFileSync(path.join(FIXTURES_DIR, "xref-classic.pdf"));
    expect(buffer.toString("latin1")).toContain("\ntrailer");
    expect(buffer.toString("latin1")).not.toContain("/Type /XRef");

    const result = await extractDocumentText(buffer, { filename: "bases.pdf", mimeType: "application/pdf" });
    expect(result.status).toBe("extracted");
    expect(result.text).toContain("garantia de cumplimiento");
    expect(result.pageCount).toBe(1);
  });

  it("un PDF real de VARIAS páginas devuelve el texto de cada página con su número REAL (no una aproximación proporcional)", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont("Helvetica");
    const page1 = doc.addPage([400, 400]);
    page1.drawText("Contenido de la pagina uno.", { x: 20, y: 360, size: 12, font });
    const page2 = doc.addPage([400, 400]);
    page2.drawText("Contenido de la pagina dos: monto total.", { x: 20, y: 360, size: 12, font });
    const page3 = doc.addPage([400, 400]);
    page3.drawText("Contenido de la pagina tres.", { x: 20, y: 360, size: 12, font });
    const buffer = Buffer.from(await doc.save());

    const result = await extractDocumentText(buffer, { filename: "contrato.pdf", mimeType: "application/pdf" });
    expect(result.status).toBe("extracted");
    expect(result.pageCount).toBe(3);
    expect(result.pages).toHaveLength(3);
    expect(result.pages![0]).toMatchObject({ page: 1 });
    expect(result.pages![0]!.text).toContain("pagina uno");
    expect(result.pages![1]).toMatchObject({ page: 2 });
    expect(result.pages![1]!.text).toContain("pagina dos");
    expect(result.pages![2]).toMatchObject({ page: 3 });
    expect(result.pages![2]!.text).toContain("pagina tres");
  });

  it("un PDF real SIN ninguna capa de texto (página en blanco) queda 'requires_ocr', nunca texto vacío en silencio", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]); // sin drawText: no hay ninguna capa de texto.
    const buffer = Buffer.from(await doc.save());

    const result = await extractDocumentText(buffer, { filename: "escaneado.pdf", mimeType: "application/pdf" });
    expect(result.status).toBe("requires_ocr");
    expect(result.text).toBeNull();
    expect(result.pages).toBeNull();
    expect(result.pageCount).toBe(1);
    expect(result.detail).toContain("OCR");
  });

  it("texto plano se usa tal cual, como una única página", async () => {
    const result = await extractDocumentText(Buffer.from("Hola mundo, este es un documento de texto plano."), { filename: "bases.txt", mimeType: "text/plain" });
    expect(result.status).toBe("extracted");
    expect(result.text).toContain("Hola mundo");
    expect(result.pages).toEqual([{ page: 1, text: result.text }]);
  });

  it("un formato no soportado (ni PDF ni texto imprimible) queda 'failed' con detalle explícito", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]);
    const result = await extractDocumentText(binary, { filename: "foto.png", mimeType: "image/png" });
    expect(result.status).toBe("failed");
    expect(result.text).toBeNull();
    expect(result.pages).toBeNull();
    expect(result.detail).toBeTruthy();
  });

  it("un PDF corrupto (bytes truncados/inválidos tras el header) queda 'failed' con detalle explícito, nunca lanza sin capturar", async () => {
    const corrupt = Buffer.from("%PDF-1.4\n%%garbage not a real pdf structure at all\n");
    const result = await extractDocumentText(corrupt, { filename: "roto.pdf", mimeType: "application/pdf" });
    expect(result.status).toBe("failed");
    expect(result.text).toBeNull();
    expect(result.detail).toBeTruthy();
  });

  it("una 'bomba de páginas' (20.000 páginas en blanco, ~260 KB) se rechaza en menos de 2 s, ANTES de extraer texto de ninguna página, con estado explícito 'rechazado_por_limite' -- nunca 'requires_ocr'", async () => {
    const buffer = await createBlankPageBombFast(20_000, [50, 50]);
    expect(buffer.byteLength).toBeLessThan(1_000_000);

    const startedAt = Date.now();
    const result = await extractDocumentText(buffer, { filename: "bomba.pdf", mimeType: "application/pdf" });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(result.status).toBe("failed");
    expect(result.limitExceeded).toBe("paginas");
    expect(result.detail).toContain("rechazado_por_limite");
    expect(result.pageCount).toBe(20_000);
    expect(result.text).toBeNull();
    expect(result.pages).toBeNull();
  });

  it("AE-04: texto plano con <script>/HTML embebido se sanea antes de devolverse -- nunca se persiste como texto ejecutable", async () => {
    const result = await extractDocumentText(Buffer.from('<script>alert(1)</script><p>Monto total: $500.00</p>'), { filename: "bases.txt", mimeType: "text/plain" });
    expect(result.status).toBe("extracted");
    expect(result.text).not.toContain("<script>");
    expect(result.text).not.toContain("<p>");
    expect(result.text).toContain("Monto total: $500.00");
  });

  it("texto plano ÍNTEGRAMENTE HTML/script (nada de texto real fuera de las etiquetas) queda 'failed', nunca 'extracted' con texto vacío", async () => {
    const result = await extractDocumentText(Buffer.from("<script>alert(1)</script>"), { filename: "bases.txt", mimeType: "text/plain" });
    expect(result.status).toBe("failed");
    expect(result.text).toBeNull();
  });

  it("splitPersistedTextIntoPages reconstruye páginas reales a partir del separador PAGE_BREAK", async () => {
    const { splitPersistedTextIntoPages, PAGE_BREAK } = await import("../src/text-extraction.ts");
    const persisted = `pagina uno${PAGE_BREAK}pagina dos${PAGE_BREAK}pagina tres`;
    expect(splitPersistedTextIntoPages(persisted)).toEqual([
      { page: 1, text: "pagina uno" },
      { page: 2, text: "pagina dos" },
      { page: 3, text: "pagina tres" },
    ]);
  });

  it("splitPersistedTextIntoPages sin separador -- una única página, nunca inventa un número de página que el dato no sustenta", async () => {
    const { splitPersistedTextIntoPages } = await import("../src/text-extraction.ts");
    expect(splitPersistedTextIntoPages("texto plano sin separador")).toEqual([{ page: 1, text: "texto plano sin separador" }]);
  });
});
