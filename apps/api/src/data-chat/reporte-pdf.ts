// Render PDF del reporte del Copiloto con pdf-lib (ya dependencia de apps/api): sin servicios externos, sin
// navegador, sin imagenes. Hoja A4 vertical, Helvetica estandar (WinAnsi: acentos y n del espanol si; cualquier otro
// caracter se sustituye por "?" en vez de lanzar). Las graficas son VECTORIALES y deterministas (barras, lineas y dona
// dibujadas con rectangulos, lineas y rutas SVG): salen de las tablas, nunca del modelo. Cada pagina lleva marca de agua
// con el nombre de la organizacion y un pie con fecha, periodo, alcance y "cifras reales".
//
// Determinista: fecha de creacion/modificacion = `generadoEn` (inyectada), no el reloj del proceso.
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";
import { formatCell } from "@atiende/agent-core/data-chat";
import type { MotivoSinNarrativa, ReporteContenido, ReporteGrafica, ReporteTabla } from "@atiende/agent-core/data-chat";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_H = 34;
/** Tope duro: un reporte nunca produce PDFs gigantes (4 tablas x 50 filas caben de sobra). */
export const REPORTE_PDF_MAX_PAGINAS = 40;

const TEXT = rgb(0.1, 0.11, 0.14);
const MUTED = rgb(0.4, 0.43, 0.48);
const RULE = rgb(0.84, 0.86, 0.9);
const HEADER_BG = rgb(0.92, 0.95, 1);
const BLUE = rgb(0.145, 0.388, 0.922);
const NOTE_BG = rgb(0.96, 0.97, 0.99);
const SERIES = [rgb(0.145, 0.388, 0.922), rgb(0.06, 0.64, 0.5), rgb(0.96, 0.62, 0.04), rgb(0.86, 0.21, 0.27), rgb(0.55, 0.36, 0.96), rgb(0.4, 0.45, 0.52)];

const MOTIVOS: Record<MotivoSinNarrativa, string> = {
  sin_ia: "la asistencia con IA no está activada para tu cuenta",
  interruptor: "la asistencia con IA está pausada por el momento",
  tope: "se alcanzó el tope de uso de la asistencia con IA de tu cuenta",
  proveedor: "el proveedor de IA no respondió a tiempo",
  tiempo: "no alcanzó el tiempo para redactarla",
  guardia: "la verificación de cifras no pudo respaldar el texto redactado",
};

const TIPO_ETIQUETA: Record<string, string> = { kpi: "KPI", tendencia: "Tendencia", anomalia: "Anomalía", riesgo: "Riesgo", recomendacion: "Recomendación" };

export interface ReportePdfInput {
  readonly contenido: ReporteContenido;
  /** Nombre de la organizacion (marca de agua y portada). */
  readonly organizacion: string;
  readonly vertical: string;
  readonly generadoEn: Date;
  readonly zonaHoraria: string;
}

function unicos(valores: readonly (string | undefined)[]): string[] {
  return [...new Set(valores.filter((v): v is string => Boolean(v && v.trim())))];
}

export function periodoDelReporte(tablas: readonly ReporteTabla[]): string {
  const p = unicos(tablas.map((t) => t.periodLabel));
  return p.length > 0 ? p.join("; ") : "No aplica";
}

export function alcanceDelReporte(tablas: readonly ReporteTabla[]): string {
  const a = unicos(tablas.map((t) => t.scopeLabel));
  return a.length > 0 ? a.join("; ") : "Tu alcance actual";
}

function fechaLegible(d: Date, zona: string): string {
  const opts = { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false } as const;
  try {
    return `${new Intl.DateTimeFormat("es-MX", { ...opts, timeZone: zona }).format(d)} (${zona})`;
  } catch {
    return `${new Intl.DateTimeFormat("es-MX", { ...opts, timeZone: "UTC" }).format(d)} (UTC)`;
  }
}

function compacto(kind: string, v: number): string {
  const abs = Math.abs(v);
  const n = abs >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : abs >= 10_000 ? `${(v / 1_000).toFixed(0)}k` : abs >= 1_000 ? `${(v / 1_000).toFixed(1)}k` : Number.isInteger(v) ? String(v) : abs >= 100 ? v.toFixed(0) : v.toFixed(1);
  return kind === "mxn" ? `$${n}` : kind === "percent" ? `${n}%` : n;
}

class Pdf {
  page!: PDFPage;
  y = 0;
  readonly paginas: PDFPage[] = [];
  private readonly permitidos: Set<number>;
  constructor(
    readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly negrita: PDFFont,
  ) {
    this.permitidos = new Set(regular.getCharacterSet());
    this.nuevaPagina();
  }

  nuevaPagina(): void {
    if (this.paginas.length >= REPORTE_PDF_MAX_PAGINAS) throw new Error("reporte_pdf_demasiadas_paginas");
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.paginas.push(this.page);
    this.y = PAGE_H - MARGIN;
  }

  limpiar(texto: string): string {
    let out = "";
    for (const ch of texto.replace(/[\r\n\t]+/g, " ")) out += this.permitidos.has(ch.codePointAt(0)!) ? ch : "?";
    return out;
  }

  ancho(t: string, font: PDFFont, size: number): number {
    return font.widthOfTextAtSize(t, size);
  }

  ajustar(texto: string, anchoMax: number, font: PDFFont, size: number): string[] {
    const lineas: string[] = [];
    let actual = "";
    for (const palabra of this.limpiar(texto).split(" ")) {
      if (!palabra) continue;
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
    }
    if (actual) lineas.push(actual);
    return lineas.length > 0 ? lineas : [""];
  }

  /** Salta de pagina si no caben `alto` puntos (sin romper el pie). */
  espacio(alto: number): void {
    if (this.y - alto < MARGIN + FOOTER_H) this.nuevaPagina();
  }

  texto(t: string, o: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; x?: number; ancho?: number; gap?: number } = {}): void {
    const size = o.size ?? 9;
    const font = o.font ?? this.regular;
    for (const l of this.ajustar(t, o.ancho ?? CONTENT_W, font, size)) {
      this.espacio(size + 4);
      this.page.drawText(l, { x: o.x ?? MARGIN, y: this.y - size, size, font, color: o.color ?? TEXT });
      this.y -= size + 3;
    }
    this.y -= o.gap ?? 0;
  }

  titulo(t: string): void {
    this.espacio(40);
    this.y -= 6;
    this.texto(t, { size: 12, font: this.negrita, color: BLUE, gap: 3 });
    this.page.drawLine({ start: { x: MARGIN, y: this.y + 2 }, end: { x: PAGE_W - MARGIN, y: this.y + 2 }, thickness: 0.6, color: RULE });
    this.y -= 6;
  }

  /** Recuadro de aviso con borde izquierdo azul. */
  nota(t: string): void {
    const lineas = this.ajustar(t, CONTENT_W - 20, this.regular, 9);
    const alto = lineas.length * 12 + 12;
    this.espacio(alto + 6);
    this.page.drawRectangle({ x: MARGIN, y: this.y - alto, width: CONTENT_W, height: alto, color: NOTE_BG });
    this.page.drawRectangle({ x: MARGIN, y: this.y - alto, width: 3, height: alto, color: BLUE });
    lineas.forEach((l, i) => this.page.drawText(l, { x: MARGIN + 12, y: this.y - 14 - i * 12, size: 9, font: this.regular, color: TEXT }));
    this.y -= alto + 8;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Graficas vectoriales.
// ---------------------------------------------------------------------------------------------------------------

const CHART_W = CONTENT_W;
const CHART_H = 170;
const MAX_PUNTOS = 15;

function columna(t: ReporteTabla, key: string): { kind: string; label: string } {
  const c = t.columns.find((x) => x.key === key);
  return { kind: c?.kind ?? "decimal", label: c?.label ?? key };
}

function datosGrafica(t: ReporteTabla, g: ReporteGrafica): { etiquetas: string[]; valores: number[]; ky: string } {
  const ky = columna(t, g.y).kind;
  const etiquetas: string[] = [];
  const valores: number[] = [];
  for (const row of t.rows.slice(0, MAX_PUNTOS)) {
    const v = row[g.y];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const x = row[g.x];
    etiquetas.push(typeof x === "number" ? formatCell(columna(t, g.x).kind as never, x) : (x ?? ""));
    valores.push(v);
  }
  return { etiquetas, valores, ky };
}

function dibujarEjes(p: Pdf, x0: number, yBase: number, w: number, h: number, min: number, max: number, ky: string): (v: number) => number {
  const span = max - min || 1;
  const yOf = (v: number): number => yBase + ((v - min) / span) * h;
  for (let i = 0; i <= 4; i += 1) {
    const v = min + (span * i) / 4;
    const yy = yOf(v);
    p.page.drawLine({ start: { x: x0, y: yy }, end: { x: x0 + w, y: yy }, thickness: 0.4, color: RULE });
    const label = p.limpiar(compacto(ky, v));
    p.page.drawText(label, { x: x0 - 4 - p.ancho(label, p.regular, 7), y: yy - 2.5, size: 7, font: p.regular, color: MUTED });
  }
  return yOf;
}

function etiquetasX(p: Pdf, etiquetas: string[], xs: number[], yBase: number, paso: number): void {
  etiquetas.forEach((e, i) => {
    if (i % paso !== 0) return;
    let l = p.limpiar(e);
    while (l.length > 1 && p.ancho(l, p.regular, 6.5) > 52) l = l.slice(0, -1);
    p.page.drawText(l, { x: xs[i]! - p.ancho(l, p.regular, 6.5) / 2, y: yBase - 11, size: 6.5, font: p.regular, color: MUTED });
  });
}

function graficaBarrasLineas(p: Pdf, t: ReporteTabla, g: ReporteGrafica): void {
  const { etiquetas, valores, ky } = datosGrafica(t, g);
  if (valores.length === 0) return;
  const left = 44;
  const x0 = MARGIN + left;
  const w = CHART_W - left - 8;
  const yBase = p.y - CHART_H + 8;
  const h = CHART_H - 28;
  const min = Math.min(0, ...valores);
  const max = Math.max(0, ...valores) || 1;
  const yOf = dibujarEjes(p, x0, yBase, w, h, min, max, ky);
  const n = valores.length;
  const slot = w / n;
  const xs = valores.map((_, i) => x0 + slot * (i + 0.5));
  const paso = Math.max(1, Math.ceil(n / 8));
  if (g.kind === "bar") {
    const bw = Math.min(40, slot * 0.62);
    valores.forEach((v, i) => {
      const alto = Math.max(Math.abs(yOf(v) - yOf(0)), 0.5);
      p.page.drawRectangle({ x: xs[i]! - bw / 2, y: Math.min(yOf(v), yOf(0)), width: bw, height: alto, color: BLUE });
      if (n <= 8) {
        const lab = p.limpiar(compacto(ky, v));
        p.page.drawText(lab, { x: xs[i]! - p.ancho(lab, p.regular, 6.5) / 2, y: (v >= 0 ? yOf(v) : yOf(0)) + 2, size: 6.5, font: p.regular, color: TEXT });
      }
    });
  } else {
    for (let i = 1; i < n; i += 1) p.page.drawLine({ start: { x: xs[i - 1]!, y: yOf(valores[i - 1]!) }, end: { x: xs[i]!, y: yOf(valores[i]!) }, thickness: 1.6, color: BLUE });
    valores.forEach((v, i) => p.page.drawCircle({ x: xs[i]!, y: yOf(v), size: 2.2, color: BLUE }));
  }
  etiquetasX(p, etiquetas, xs, yBase, paso);
}

function graficaDona(p: Pdf, t: ReporteTabla, g: ReporteGrafica): void {
  const { etiquetas, valores, ky } = datosGrafica(t, g);
  const positivos = valores.map((v) => Math.max(0, v));
  const total = positivos.reduce((a, b) => a + b, 0);
  if (total <= 0) return;
  const R = 62;
  const r = 34;
  const cx = MARGIN + R + 20;
  const cy = p.y - CHART_H / 2 - 4;
  let fase = 0;
  positivos.forEach((v, i) => {
    if (v <= 0) return;
    const sweep = (v / total) * Math.PI * 2;
    const color = SERIES[i % SERIES.length]!;
    if (sweep >= Math.PI * 2 - 1e-6) {
      p.page.drawCircle({ x: cx, y: cy, size: R, color });
    } else {
      const f0 = fase;
      const f1 = fase + sweep;
      const pt = (rad: number, f: number): string => `${(rad * Math.sin(f)).toFixed(3)} ${(-rad * Math.cos(f)).toFixed(3)}`;
      const large = sweep > Math.PI ? 1 : 0;
      const path = `M ${pt(R, f0)} A ${R} ${R} 0 ${large} 1 ${pt(R, f1)} L ${pt(r, f1)} A ${r} ${r} 0 ${large} 0 ${pt(r, f0)} Z`;
      p.page.drawSvgPath(path, { x: cx, y: cy, color });
    }
    fase += sweep;
  });
  p.page.drawCircle({ x: cx, y: cy, size: r, color: rgb(1, 1, 1) });
  // Leyenda: color, etiqueta, valor y participacion (calculada por codigo).
  let ly = cy + R - 6;
  positivos.forEach((v, i) => {
    if (v <= 0) return;
    p.page.drawRectangle({ x: MARGIN + 180, y: ly - 1, width: 8, height: 8, color: SERIES[i % SERIES.length]! });
    let l = p.limpiar(etiquetas[i] ?? "");
    while (l.length > 1 && p.ancho(l, p.regular, 8) > 170) l = l.slice(0, -1);
    p.page.drawText(l, { x: MARGIN + 194, y: ly, size: 8, font: p.regular, color: TEXT });
    const val = p.limpiar(`${compacto(ky, valores[i]!)} (${((v / total) * 100).toFixed(1)}%)`);
    p.page.drawText(val, { x: MARGIN + 380, y: ly, size: 8, font: p.negrita, color: TEXT });
    ly -= 16;
  });
}

function dibujarGrafica(p: Pdf, contenido: ReporteContenido, g: ReporteGrafica): void {
  const t = contenido.tablas.find((x) => x.tool === g.tool);
  if (!t) return;
  p.espacio(CHART_H + 34);
  p.texto(g.titulo, { size: 9.5, font: p.negrita, gap: 2 });
  p.texto(`${columna(t, g.y).label} por ${columna(t, g.x).label.toLowerCase()} · ${t.periodLabel ?? t.source}`, { size: 7.5, color: MUTED, gap: 4 });
  if (g.kind === "donut") graficaDona(p, t, g);
  else graficaBarrasLineas(p, t, g);
  p.y -= CHART_H + 8;
}

// ---------------------------------------------------------------------------------------------------------------
// Tablas.
// ---------------------------------------------------------------------------------------------------------------

function dibujarTabla(p: Pdf, t: ReporteTabla): void {
  const cols = t.columns;
  const size = cols.length > 6 ? 7 : 8;
  const lineH = size + 3;
  const pad = 3;
  const pesos = cols.map((c) => (c.kind === "text" ? 1.8 : 1));
  const suma = pesos.reduce((a, b) => a + b, 0);
  const anchos = pesos.map((w) => (w / suma) * CONTENT_W);

  p.espacio(70);
  p.texto(t.title, { size: 10.5, font: p.negrita, gap: 1 });
  p.texto([t.source, t.periodLabel, t.scopeLabel].filter(Boolean).join(" · "), { size: 7.5, color: MUTED, gap: 4 });

  const encabezado = (): void => {
    const lineas = cols.map((c, i) => p.ajustar(c.label, anchos[i]! - pad * 2, p.negrita, size).slice(0, 3));
    const alto = Math.max(...lineas.map((l) => l.length)) * lineH + pad * 2;
    p.espacio(alto + lineH * 2);
    p.page.drawRectangle({ x: MARGIN, y: p.y - alto, width: CONTENT_W, height: alto, color: HEADER_BG });
    let x = MARGIN;
    cols.forEach((c, i) => {
      lineas[i]!.forEach((l, n) => {
        const w = p.ancho(l, p.negrita, size);
        p.page.drawText(l, { x: c.kind === "text" ? x + pad : x + anchos[i]! - pad - w, y: p.y - pad - size - n * lineH, size, font: p.negrita, color: TEXT });
      });
      x += anchos[i]!;
    });
    p.y -= alto;
  };
  encabezado();

  for (const row of t.rows) {
    const celdas = cols.map((c, i) => p.ajustar(formatCell(c.kind, row[c.key] ?? null), anchos[i]! - pad * 2, p.regular, size).slice(0, 3));
    const alto = Math.max(...celdas.map((l) => l.length)) * lineH + pad * 2;
    if (p.y - alto < MARGIN + FOOTER_H) {
      p.nuevaPagina();
      encabezado();
    }
    let x = MARGIN;
    cols.forEach((c, i) => {
      celdas[i]!.forEach((l, n) => {
        const w = p.ancho(l, p.regular, size);
        p.page.drawText(l, { x: c.kind === "text" ? x + pad : x + anchos[i]! - pad - w, y: p.y - pad - size - n * lineH, size, font: p.regular, color: TEXT });
      });
      x += anchos[i]!;
    });
    p.page.drawLine({ start: { x: MARGIN, y: p.y - alto }, end: { x: MARGIN + CONTENT_W, y: p.y - alto }, thickness: 0.3, color: RULE });
    p.y -= alto;
  }
  if (t.truncated) p.texto(`Se muestran las primeras ${t.rows.length} filas; hay más en el sistema.`, { size: 7.5, color: MUTED });
  p.y -= 10;
}

// ---------------------------------------------------------------------------------------------------------------
// Documento.
// ---------------------------------------------------------------------------------------------------------------

export async function renderReportePdf(input: ReportePdfInput): Promise<Uint8Array> {
  const { contenido, organizacion, generadoEn, zonaHoraria } = input;
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold);
  const p = new Pdf(doc, regular, negrita);

  const periodo = periodoDelReporte(contenido.tablas);
  const alcance = alcanceDelReporte(contenido.tablas);
  const cuando = fechaLegible(generadoEn, zonaHoraria);
  const pieTexto = `Generado el ${cuando} · Periodo: ${periodo} · Alcance: ${alcance} · Cifras reales de tu sistema`;

  doc.setTitle(p.limpiar(contenido.titulo));
  doc.setSubject(p.limpiar(`Periodo: ${periodo} | Alcance: ${alcance} | Cifras reales`));
  doc.setAuthor("Atiende");
  doc.setProducer("Atiende");
  doc.setCreator("Atiende");
  doc.setCreationDate(generadoEn);
  doc.setModificationDate(generadoEn);

  // ---- portada compacta ----
  p.texto(organizacion, { size: 9, color: MUTED, gap: 2 });
  p.texto(contenido.titulo, { size: 18, font: negrita, gap: 4 });
  p.texto(`Generado el ${cuando}`, { size: 8.5, color: MUTED });
  p.texto(`Periodo: ${periodo}`, { size: 8.5, color: MUTED });
  p.texto(`Alcance: ${alcance}`, { size: 8.5, color: MUTED, gap: 6 });

  // ---- narrativa verificada, o la leyenda honesta ----
  if (contenido.narrativa) {
    p.titulo("Resumen");
    p.texto(contenido.narrativa.resumen, { size: 10, gap: 4 });
    for (const s of contenido.narrativa.secciones) {
      p.texto(s.titulo, { size: 10, font: negrita, gap: 1 });
      p.texto(s.texto, { size: 9.5, gap: 5 });
    }
    if (contenido.hallazgos.length > 0) {
      p.titulo("Hallazgos");
      for (const h of contenido.hallazgos) {
        p.texto(`${TIPO_ETIQUETA[h.tipo] ?? h.tipo}: ${h.texto}`, { size: 9.5, gap: 1 });
        const fuentes = h.fuentes.map((f) => `${contenido.tablas.find((t) => t.tool === f.tool)?.title ?? f.tool}, fila ${f.fila}`).join("; ");
        p.texto(`Fuente: ${fuentes}`, { size: 7.5, color: MUTED, gap: 4 });
      }
    }
  } else {
    const motivo = contenido.motivoSinNarrativa ? MOTIVOS[contenido.motivoSinNarrativa] : MOTIVOS.sin_ia;
    p.nota(`Narrativa no disponible: ${motivo}. Este reporte contiene solo las tablas y gráficas con cifras reales de tu sistema.`);
  }

  // ---- graficas ----
  if (contenido.graficas.length > 0) {
    p.titulo("Gráficas");
    for (const g of contenido.graficas) dibujarGrafica(p, contenido, g);
  }

  // ---- tablas ----
  p.titulo("Datos");
  for (const t of contenido.tablas) dibujarTabla(p, t);

  if (contenido.omitidas.length > 0) {
    p.titulo("Consultas no incluidas");
    for (const o of contenido.omitidas) p.texto(`${o.title}: ${o.motivo}`, { size: 9, gap: 2 });
  }

  // ---- marca de agua y pie en TODAS las paginas ----
  const total = p.paginas.length;
  const marca = p.limpiar(organizacion).slice(0, 40);
  p.paginas.forEach((page, i) => {
    const size = 46;
    const w = negrita.widthOfTextAtSize(marca, size);
    // Centrada y a 45 grados: el origen del texto rotado se desplaza para que el centro quede en el centro de la hoja.
    const ang = Math.PI / 4;
    page.drawText(marca, {
      x: PAGE_W / 2 - (w / 2) * Math.cos(ang),
      y: PAGE_H / 2 - (w / 2) * Math.sin(ang),
      size,
      font: negrita,
      color: rgb(0.5, 0.55, 0.65),
      opacity: 0.09,
      rotate: degrees(45),
    });
    page.drawLine({ start: { x: MARGIN, y: MARGIN + 22 }, end: { x: PAGE_W - MARGIN, y: MARGIN + 22 }, thickness: 0.5, color: RULE });
    const pie = p.ajustar(pieTexto, CONTENT_W - 60, regular, 6.5);
    pie.slice(0, 2).forEach((l, n) => page.drawText(l, { x: MARGIN, y: MARGIN + 13 - n * 8, size: 6.5, font: regular, color: MUTED }));
    const num = `Página ${i + 1} de ${total}`;
    page.drawText(num, { x: PAGE_W - MARGIN - regular.widthOfTextAtSize(num, 7), y: MARGIN + 13, size: 7, font: regular, color: MUTED });
  });

  // Sin object streams: los metadatos (titulo, periodo, alcance) quedan legibles en el archivo.
  return doc.save({ useObjectStreams: false });
}
