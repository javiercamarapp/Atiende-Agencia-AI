// Render a PDF de un `ReporteCliente` (D-01) con pdf-lib (ya dependencia de apps/api), sin
// servicios externos. Hoja A4 horizontal (las tablas DIOT/nómina tienen hasta 8 columnas),
// fuentes estándar Helvetica (WinAnsi: acentos y ñ del español sí; cualquier carácter fuera
// del juego se sustituye por "?" en vez de lanzar), tablas con encabezado repetido en cada
// página, filas con ajuste de línea, fila de totales en negrita y las secciones "sin datos"
// con su motivo (nunca una tabla vacía ni ceros).
//
// Determinista: la fecha de creación/modificación del PDF es la de generación del reporte
// (`generadoEn`, inyectada), no el reloj del proceso.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";
import type { CeldaReporte, ColumnaReporte, ReporteCliente, SeccionReporte } from "@atiende/domain-despachos";

const PAGE_W = 841.89;
const PAGE_H = 595.28;
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FONT_SIZE = 8.5;
const LINE_H = 11;
const PAD = 3;
const MAX_LINES_PER_CELL = 4;
const COLOR_TEXT = rgb(0.1, 0.1, 0.12);
const COLOR_MUTED = rgb(0.4, 0.42, 0.46);
const COLOR_HEADER_BG = rgb(0.9, 0.93, 0.97);
const COLOR_RULE = rgb(0.78, 0.8, 0.84);

/** Lo que el render necesita: un `ReporteCliente` (D-01) o cualquier reporte tabular con la misma forma (p. ej. la
 * cartera D-11, que usa una fecha de corte: `etiquetaPeriodo` reemplaza al texto "Período AAAA-MM"). */
export type ReportePdf = Omit<ReporteCliente, "tipo"> & { readonly tipo: string; readonly etiquetaPeriodo?: string };

const MONEDA = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const ENTERO = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
const PCT = new Intl.NumberFormat("es-MX", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatearCelda(valor: CeldaReporte, col: ColumnaReporte): string {
  if (valor === null) return "";
  if (typeof valor === "number") {
    if (col.tipo === "moneda") return MONEDA.format(valor);
    if (col.tipo === "porcentaje") return `${PCT.format(valor)} %`;
    return ENTERO.format(valor);
  }
  return valor;
}

class Escritor {
  private page!: PDFPage;
  private y = 0;
  private readonly paginas: PDFPage[] = [];
  private readonly permitidos: Set<number>;

  constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly negrita: PDFFont,
    private readonly cursiva: PDFFont,
  ) {
    this.permitidos = new Set(regular.getCharacterSet());
    this.nuevaPagina();
  }

  private nuevaPagina(): void {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.paginas.push(this.page);
    this.y = PAGE_H - MARGIN;
  }

  /** Reemplaza lo que WinAnsi no puede codificar y colapsa saltos de línea/tabulaciones. */
  limpiar(texto: string): string {
    let out = "";
    for (const ch of texto.replace(/[\r\n\t]+/g, " ")) {
      const cp = ch.codePointAt(0)!;
      out += this.permitidos.has(cp) ? ch : "?";
    }
    return out;
  }

  private ancho(texto: string, font: PDFFont, size = FONT_SIZE): number {
    return font.widthOfTextAtSize(texto, size);
  }

  /** Ajuste de línea por palabras; una palabra más ancha que la celda se corta por caracteres. */
  ajustar(texto: string, anchoMax: number, font: PDFFont, size = FONT_SIZE): string[] {
    const limpio = this.limpiar(texto);
    const lineas: string[] = [];
    let actual = "";
    const empujar = (palabra: string) => {
      let w = palabra;
      while (this.ancho(w, font, size) > anchoMax && w.length > 1) {
        let corte = w.length - 1;
        while (corte > 1 && this.ancho(w.slice(0, corte), font, size) > anchoMax) corte -= 1;
        if (actual) {
          lineas.push(actual);
          actual = "";
        }
        lineas.push(w.slice(0, corte));
        w = w.slice(corte);
      }
      const candidata = actual ? `${actual} ${w}` : w;
      if (this.ancho(candidata, font, size) <= anchoMax) actual = candidata;
      else {
        if (actual) lineas.push(actual);
        actual = w;
      }
    };
    for (const palabra of limpio.split(" ")) if (palabra) empujar(palabra);
    if (actual) lineas.push(actual);
    return lineas.length > 0 ? lineas : [""];
  }

  asegurarEspacio(alto: number): boolean {
    if (this.y - alto < MARGIN + 18) {
      this.nuevaPagina();
      return true;
    }
    return false;
  }

  texto(t: string, opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; x?: number; ancho?: number } = {}): void {
    const size = opts.size ?? FONT_SIZE;
    const font = opts.font ?? this.regular;
    const lineas = this.ajustar(t, opts.ancho ?? CONTENT_W, font, size);
    for (const l of lineas) {
      this.asegurarEspacio(size + 3);
      this.page.drawText(l, { x: opts.x ?? MARGIN, y: this.y - size, size, font, color: opts.color ?? COLOR_TEXT });
      this.y -= size + 3;
    }
  }

  espacio(h: number): void {
    this.y -= h;
  }

  private anchosColumnas(seccion: SeccionReporte): number[] {
    const pesos = seccion.columnas.map((c) => (c.tipo === "texto" ? (c.clave === "nombre" || c.clave === "folioFiscal" || c.clave === "concepto" ? 2.2 : 1.4) : 1));
    const total = pesos.reduce((a, b) => a + b, 0);
    return pesos.map((p) => (p / total) * CONTENT_W);
  }

  tabla(seccion: SeccionReporte): void {
    const anchos = this.anchosColumnas(seccion);
    const encabezado = () => {
      const lineas = seccion.columnas.map((c, i) => this.ajustar(c.titulo, anchos[i]! - PAD * 2, this.negrita));
      const alto = Math.min(MAX_LINES_PER_CELL, Math.max(...lineas.map((l) => l.length))) * LINE_H + PAD * 2;
      this.asegurarEspacio(alto + LINE_H * 2);
      this.page.drawRectangle({ x: MARGIN, y: this.y - alto, width: CONTENT_W, height: alto, color: COLOR_HEADER_BG });
      let x = MARGIN;
      seccion.columnas.forEach((c, i) => {
        const alinea = c.tipo === "texto" ? "izq" : "der";
        lineas[i]!.slice(0, MAX_LINES_PER_CELL).forEach((l, n) => {
          const w = this.ancho(l, this.negrita);
          this.page.drawText(l, { x: alinea === "der" ? x + anchos[i]! - PAD - w : x + PAD, y: this.y - PAD - (n + 1) * LINE_H + 3, size: FONT_SIZE, font: this.negrita, color: COLOR_TEXT });
        });
        x += anchos[i]!;
      });
      this.y -= alto;
    };

    const fila = (valores: Readonly<Record<string, CeldaReporte>>, negrita: boolean) => {
      const font = negrita ? this.negrita : this.regular;
      const textos = seccion.columnas.map((c) => formatearCelda(valores[c.clave] ?? null, c));
      const lineas = textos.map((t, i) => this.ajustar(t, anchos[i]! - PAD * 2, font).slice(0, MAX_LINES_PER_CELL));
      const alto = Math.max(...lineas.map((l) => l.length)) * LINE_H + PAD * 2;
      if (this.asegurarEspacio(alto)) encabezado();
      let x = MARGIN;
      seccion.columnas.forEach((c, i) => {
        lineas[i]!.forEach((l, n) => {
          const w = this.ancho(l, font);
          this.page.drawText(l, { x: c.tipo === "texto" ? x + PAD : x + anchos[i]! - PAD - w, y: this.y - PAD - (n + 1) * LINE_H + 3, size: FONT_SIZE, font, color: COLOR_TEXT });
        });
        x += anchos[i]!;
      });
      this.y -= alto;
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + CONTENT_W, y: this.y }, thickness: 0.4, color: COLOR_RULE });
    };

    encabezado();
    for (const f of seccion.filas) fila(f, false);
    if (seccion.totales) fila(seccion.totales, true);
  }

  /** Pie de página con numeración; se llama al final, cuando ya se conoce el total. */
  pie(reporte: ReportePdf): void {
    const total = this.paginas.length;
    this.paginas.forEach((p, i) => {
      const izq = this.limpiar(`${reporte.titulo} · ${reporte.contribuyente.nombre} · ${reporte.etiquetaPeriodo ?? `Período ${reporte.periodo}`}`);
      p.drawText(izq, { x: MARGIN, y: 20, size: 7.5, font: this.regular, color: COLOR_MUTED });
      const der = `Página ${i + 1} de ${total}`;
      p.drawText(der, { x: PAGE_W - MARGIN - this.ancho(der, this.regular, 7.5), y: 20, size: 7.5, font: this.regular, color: COLOR_MUTED });
    });
  }
}

/** Genera el PDF del reporte (bytes). */
export async function reporteAPdf(reporte: ReportePdf): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const [regular, negrita, cursiva] = await Promise.all([doc.embedFont(StandardFonts.Helvetica), doc.embedFont(StandardFonts.HelveticaBold), doc.embedFont(StandardFonts.HelveticaOblique)]);
  const e = new Escritor(doc, regular, negrita, cursiva);

  const fechaDoc = new Date(`${reporte.generadoEn}T12:00:00Z`);
  doc.setTitle(e.limpiar(`${reporte.titulo} ${reporte.periodo} - ${reporte.contribuyente.nombre}`));
  doc.setSubject(e.limpiar(`Reporte de cliente ${reporte.tipo}, ${reporte.etiquetaPeriodo?.toLowerCase() ?? `período ${reporte.periodo}`}`));
  doc.setProducer("Atiende - Despachos");
  doc.setCreator("Atiende - Despachos");
  doc.setCreationDate(fechaDoc);
  doc.setModificationDate(fechaDoc);

  e.texto(reporte.titulo, { size: 16, font: negrita });
  e.espacio(2);
  e.texto(`Contribuyente: ${reporte.contribuyente.nombre}`, { size: 10 });
  e.texto(`RFC: ${reporte.contribuyente.rfc ?? "sin datos (sin ficha de cartera)"}`, { size: 10 });
  e.texto(`${reporte.etiquetaPeriodo ?? `Período: ${reporte.periodo}`}    Generado el: ${reporte.generadoEn}`, { size: 10, color: COLOR_MUTED });
  if (reporte.sinDatos) {
    e.espacio(4);
    e.texto("Sin datos para el período indicado.", { size: 11, font: negrita });
  }

  for (const s of reporte.secciones) {
    e.espacio(12);
    e.asegurarEspacio(60);
    e.texto(s.titulo, { size: 11, font: negrita });
    e.espacio(3);
    if (s.sinDatosMotivo !== null) {
      e.texto("Sin datos", { font: negrita });
      e.texto(s.sinDatosMotivo, { font: cursiva, color: COLOR_MUTED });
    } else {
      e.tabla(s);
    }
  }

  if (reporte.notas.length > 0) {
    e.espacio(14);
    e.asegurarEspacio(50);
    e.texto("Notas", { size: 10, font: negrita });
    e.espacio(2);
    for (const n of reporte.notas) e.texto(`- ${n}`, { color: COLOR_MUTED });
  }

  e.pie(reporte);
  return doc.save();
}
