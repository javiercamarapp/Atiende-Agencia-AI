import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { textoDelPdf } from "./support/pdf-text.ts";

// Regresion del flake de reporte-copiloto-rutas (2-oct): cuando el flujo comprimido de una pagina termina justo en el byte
// 0x0D, el extractor lo confundia con un CRLF de cierre, el inflate fallaba en silencio y el texto desaparecia (~1 de 256 flujos).
// El texto "Narrativa no disponible 4lnow" produce, con pdf-lib, un flujo que termina en 0x0D (determinista: depende solo del texto).
async function pdfConTexto(texto: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText(texto, { font, size: 10, x: 10, y: 10 });
  return doc.save({ useObjectStreams: false });
}

describe("textoDelPdf", () => {
  it("recupera el texto aunque el flujo comprimido termine en 0x0D", async () => {
    const texto = "Narrativa no disponible 4lnow";
    const bytes = await pdfConTexto(texto);
    expect(Buffer.from(bytes).toString("latin1")).toMatch(/\r\nendstream/); // la entrada si reproduce el caso limite
    expect(textoDelPdf(bytes)).toContain(texto);
  });

  it("recupera texto de un PDF comun", async () => {
    expect(textoDelPdf(await pdfConTexto("Hola reporte"))).toContain("Hola reporte");
  });
});
