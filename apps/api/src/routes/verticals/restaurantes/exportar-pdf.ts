// R-17: PDF tabular de las exportaciones de Historial y Clientes con pdf-lib (ya dependencia de apps/api): sin servicios externos, sin
// navegador. Hoja A4 horizontal, Helvetica estandar (WinAnsi: acentos y n del espanol si; cualquier otro caracter se sustituye por "?" en
// vez de lanzar), encabezado de tabla repetido en cada pagina, una linea por fila (el texto largo se corta con "..."), y en CADA pagina un
// pie con la fecha de generacion, el alcance (sucursal/filtros) y "Pagina i de n". Se escribio aparte del render de despachos
// (despachos/reporte-pdf.ts) a proposito: ese esta atado al modelo `ReporteCliente` (contribuyente, RFC, periodo fiscal) y reutilizarlo
// habria obligado a inventar esos campos; aqui se copian solo las constantes de diseno (A4 horizontal, colores, tamanos).
//
// Determinista: fecha de creacion/modificacion = `generadoEn` (inyectada), no el reloj del proceso.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";

const PAGE_W = 841.89;
const PAGE_H = 595.28;
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FONT_SIZE = 8.5;
const ROW_H = 14;
const PAD = 4;
const FOOTER_Y = 20;
const COLOR_TEXT = rgb(0.1, 0.1, 0.12);
const COLOR_MUTED = rgb(0.4, 0.42, 0.46);
const COLOR_HEADER_BG = rgb(0.9, 0.93, 0.97);
const COLOR_RULE = rgb(0.78, 0.8, 0.84);

export interface ColumnaPdf {
  readonly titulo: string;
  /** Peso relativo del ancho de la columna. */
  readonly ancho: number;
  /** Alinea a la derecha (dinero, conteos). */
  readonly numerica?: boolean;
}

export interface TablaPdf {
  readonly titulo: string;
  /** Lineas de contexto bajo el titulo: filtros vigentes, total de filas. */
  readonly contexto: readonly string[];
  readonly columnas: readonly ColumnaPdf[];
  readonly filas: readonly (readonly string[])[];
  /** Texto del pie, izquierda: fecha de generacion y alcance. */
  readonly pie: string;
  readonly generadoEn: Date;
  /** Se pinta en lugar de la tabla cuando no hay filas (nunca una tabla vacia). */
  readonly mensajeSinFilas: string;
}

/** Tope de paginas: una exportacion nunca produce un PDF gigante (el servidor limita ademas las filas). */
export const EXPORTAR_PDF_MAX_PAGINAS = 80;

export async function tablaAPdf(t: TablaPdf): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const [regular, negrita] = await Promise.all([doc.embedFont(StandardFonts.Helvetica), doc.embedFont(StandardFonts.HelveticaBold)]);
  const permitidos = new Set(regular.getCharacterSet());
  const limpiar = (s: string): string => {
    let out = "";
    for (const ch of s.replace(/[\r\n\t]+/g, " ")) out += permitidos.has(ch.codePointAt(0)!) ? ch : "?";
    return out;
  };
  const ancho = (s: string, f: PDFFont, size = FONT_SIZE): number => f.widthOfTextAtSize(s, size);
  /** Corta a una linea con "..." si no cabe. */
  const recortar = (s: string, max: number, f: PDFFont): string => {
    const base = limpiar(s);
    if (ancho(base, f) <= max) return base;
    let corte = base.length;
    while (corte > 1 && ancho(`${base.slice(0, corte)}...`, f) > max) corte -= 1;
    return `${base.slice(0, corte)}...`;
  };

  const fechaDoc = t.generadoEn;
  doc.setTitle(limpiar(t.titulo));
  doc.setProducer("Atiende - Restaurantes");
  doc.setCreator("Atiende - Restaurantes");
  doc.setCreationDate(fechaDoc);
  doc.setModificationDate(fechaDoc);

  const paginas: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const nuevaPagina = (): void => {
    if (paginas.length >= EXPORTAR_PDF_MAX_PAGINAS) throw new Error("exportar_pdf_demasiadas_paginas");
    page = doc.addPage([PAGE_W, PAGE_H]);
    paginas.push(page);
    y = PAGE_H - MARGIN;
  };
  nuevaPagina();

  page.drawText(limpiar(t.titulo), { x: MARGIN, y: y - 14, size: 14, font: negrita, color: COLOR_TEXT });
  y -= 22;
  for (const linea of t.contexto) {
    page.drawText(recortar(linea, CONTENT_W, regular), { x: MARGIN, y: y - 9, size: 9, font: regular, color: COLOR_MUTED });
    y -= 13;
  }
  y -= 8;

  if (t.filas.length === 0) {
    page.drawText(limpiar(t.mensajeSinFilas), { x: MARGIN, y: y - 10, size: 10, font: negrita, color: COLOR_TEXT });
  } else {
    const pesoTotal = t.columnas.reduce((a, c) => a + c.ancho, 0);
    const anchos = t.columnas.map((c) => (c.ancho / pesoTotal) * CONTENT_W);
    const celda = (texto: string, i: number, f: PDFFont): { texto: string; x: number } => {
      const col = t.columnas[i]!;
      const x0 = MARGIN + anchos.slice(0, i).reduce((a, b) => a + b, 0);
      const corto = recortar(texto, anchos[i]! - PAD * 2, f);
      return { texto: corto, x: col.numerica ? x0 + anchos[i]! - PAD - ancho(corto, f) : x0 + PAD };
    };
    const encabezado = (): void => {
      page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: CONTENT_W, height: ROW_H, color: COLOR_HEADER_BG });
      t.columnas.forEach((c, i) => {
        const { texto, x } = celda(c.titulo, i, negrita);
        page.drawText(texto, { x, y: y - ROW_H + 4, size: FONT_SIZE, font: negrita, color: COLOR_TEXT });
      });
      y -= ROW_H;
    };
    encabezado();
    for (const fila of t.filas) {
      if (y - ROW_H < MARGIN + FOOTER_Y) {
        nuevaPagina();
        encabezado();
      }
      fila.forEach((valor, i) => {
        const { texto, x } = celda(valor, i, regular);
        page.drawText(texto, { x, y: y - ROW_H + 4, size: FONT_SIZE, font: regular, color: COLOR_TEXT });
      });
      y -= ROW_H;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + CONTENT_W, y }, thickness: 0.4, color: COLOR_RULE });
    }
  }

  const total = paginas.length;
  paginas.forEach((p, i) => {
    p.drawText(recortar(t.pie, CONTENT_W - 90, regular), { x: MARGIN, y: FOOTER_Y, size: 7.5, font: regular, color: COLOR_MUTED });
    const der = `Página ${i + 1} de ${total}`;
    p.drawText(der, { x: PAGE_W - MARGIN - ancho(der, regular, 7.5), y: FOOTER_Y, size: 7.5, font: regular, color: COLOR_MUTED });
  });
  return doc.save();
}
