// CFO-06 · «Reporte del CFO» en PDF (A4 vertical) con pdf-lib, ya dependencia de apps/api: sin servicios externos, sin navegador, sin imágenes.
// Portada con el aviso de no sustitución, resumen ejecutivo (la narrativa DETERMINISTA de CFO-04, con las cifras citadas), «Lo más importante»,
// tarjetas KPI, gráficas vectoriales (tendencia, barras por sucursal, dona de mix de canal y cascada bruta -> neta), estado de resultados,
// comparativo de sucursales, detalle por sucursal (hasta 7; con más va solo en el Excel) y notas y supuestos.
//
// Se escribió aparte de `data-chat/reporte-pdf.ts` a propósito: ese render está atado a `ReporteContenido` (tablas, narrativa del modelo, marca de agua)
// y reutilizarlo habría obligado a inventar esos campos; aquí solo se toman sus constantes de diseño y el enfoque de gráficas vectoriales.
//
// Reglas: Helvetica estándar (WinAnsi: acentos y ñ sí; cualquier otro carácter se sustituye por «?» en vez de lanzar). Tope de 40 páginas (el
// documento lanza `CfoPdfDemasiadasPaginas` en vez de producir un PDF gigante). Determinista: `generadoEn` inyectado, no el reloj del proceso.
// Pie en CADA hoja: «Página i de n», fecha, alcance y «cifras de la base; estimadas y capturadas rotuladas».
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";
import { AVISO_CFO, formatoEntero, formatoMinutos, formatoPct, formatoPesos } from "@atiende/domain-restaurantes/cfo";
import type { Cifra, ColumnaPyl, KpiTarjeta, LineaId } from "@atiende/domain-restaurantes/cfo";
import { cabeceraDe } from "./cfo-exportar-xlsx.ts";
import type { AlcanceExportacion, VistasCfo } from "./cfo-exportar-xlsx.ts";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_H = 34;
/** Tope duro de páginas. */
export const CFO_PDF_MAX_PAGINAS = 40;
/** Con más sucursales que esto, el detalle por sucursal va solo en el Excel. */
export const CFO_PDF_MAX_SUCURSALES_DETALLE = 7;

export class CfoPdfDemasiadasPaginas extends Error {
  constructor() {
    super("cfo_pdf_demasiadas_paginas");
    this.name = "CfoPdfDemasiadasPaginas";
  }
}

const TEXT = rgb(0.1, 0.11, 0.14);
const MUTED = rgb(0.4, 0.43, 0.48);
const RULE = rgb(0.84, 0.86, 0.9);
const HEADER_BG = rgb(0.92, 0.95, 1);
const BLUE = rgb(0.145, 0.388, 0.922);
const NOTE_BG = rgb(0.96, 0.97, 0.99);
const CARD_BG = rgb(0.97, 0.975, 0.99);
const VERDE = rgb(0.06, 0.64, 0.5);
const AMBAR = rgb(0.96, 0.62, 0.04);
const ROJO = rgb(0.86, 0.21, 0.27);
const SERIES = [BLUE, VERDE, AMBAR, ROJO, rgb(0.55, 0.36, 0.96), rgb(0.4, 0.45, 0.52)];

const AVISO_NO_SUSTITUCION =
  "Este reporte organiza los datos operativos de su restaurante para que tome decisiones: no sustituye a su contabilidad ni a sus estados financieros dictaminados, ni da asesoría fiscal o financiera.";

const ETIQUETA_LINEA: Readonly<Record<LineaId, string>> = {
  ventas_brutas: "Ventas brutas (lista)",
  descuentos_promocion: "Descuentos por promoción",
  compensaciones: "Compensaciones",
  ventas_netas: "Ventas netas con IVA",
  iva_estimado: "IVA estimado",
  ventas_netas_sin_iva: "Ventas netas sin IVA",
  costo_ventas: "Costo de ventas",
  utilidad_bruta: "Utilidad bruta",
  costo_agente: "Costo del agente",
  comision_terminal: "Comisiones de terminal",
  nomina: "Nómina",
  renta: "Renta",
  servicios: "Servicios",
  otros: "Otros",
  ebitda: "EBITDA operativo",
};
const ORDEN_LINEAS = Object.keys(ETIQUETA_LINEA) as LineaId[];
const LINEAS_NEGRITA = new Set<LineaId>(["ventas_netas", "ventas_netas_sin_iva", "utilidad_bruta", "ebitda"]);

function fechaUtc(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Marca de confianza para cifras que no son medidas: * estimado, ° capturado. */
function marca(c: Cifra): string {
  return c.confianza === "estimado" ? "*" : c.confianza === "capturado" ? "°" : "";
}

function pesos(c: Cifra): string {
  return c.valor === null ? "—" : `${formatoPesos(c.valor)}${marca(c)}`;
}

function valorKpi(k: KpiTarjeta): string {
  const v = k.valor.valor;
  if (v === null) return "—";
  const t = k.tipo === "centavos" ? formatoPesos(v) : k.tipo === "pct" ? formatoPct(v) : k.tipo === "minutos" ? formatoMinutos(v) : formatoEntero(v);
  return `${t}${marca(k.valor)}`;
}

function variacionKpi(k: KpiTarjeta): string {
  const v = k.variacion.valor;
  if (v === null || v === undefined) return "sin comparativo";
  const unidad = k.variacion.tipo === "pct" ? "%" : k.variacion.tipo === "pp" ? "pp" : "min";
  return v === 0 ? `igual (0 ${unidad})` : `${v > 0 ? "sube" : "baja"} ${Math.abs(v)} ${unidad}`;
}

function compactoPesos(centavos: number): string {
  const v = centavos / 100;
  const abs = Math.abs(v);
  const n = abs >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : abs >= 10_000 ? `${(v / 1_000).toFixed(0)}k` : abs >= 1_000 ? `${(v / 1_000).toFixed(1)}k` : abs >= 100 ? v.toFixed(0) : v.toFixed(1);
  return `$${n}`;
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
    if (this.paginas.length >= CFO_PDF_MAX_PAGINAS) throw new CfoPdfDemasiadasPaginas();
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

  /** Recorta a una línea con «...» si no cabe. */
  recortar(texto: string, max: number, font: PDFFont, size: number): string {
    let l = this.limpiar(texto);
    if (this.ancho(l, font, size) <= max) return l;
    while (l.length > 1 && this.ancho(`${l}...`, font, size) > max) l = l.slice(0, -1);
    return `${l}...`;
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

  /** Salta de página si no caben `alto` puntos (sin pisar el pie). */
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

  titulo(t: string, nuevaHoja = false): void {
    if (nuevaHoja) this.nuevaPagina();
    this.espacio(46);
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

// ---------------------------------------------------------------------------------------------------------------------------
// Tablas
// ---------------------------------------------------------------------------------------------------------------------------

interface ColTabla {
  readonly titulo: string;
  /** Peso relativo del ancho. */
  readonly peso: number;
  readonly numerica?: boolean;
}

interface FilaTabla {
  readonly celdas: readonly string[];
  readonly negrita?: boolean;
}

function tabla(p: Pdf, cols: readonly ColTabla[], filas: readonly FilaTabla[], size = 8): void {
  const pad = 3;
  const lineH = size + 3;
  const suma = cols.reduce((a, c) => a + c.peso, 0);
  const anchos = cols.map((c) => (c.peso / suma) * CONTENT_W);
  const encabezado = (): void => {
    const lineas = cols.map((c, i) => p.ajustar(c.titulo, anchos[i]! - pad * 2, p.negrita, size).slice(0, 3));
    const alto = Math.max(...lineas.map((l) => l.length)) * lineH + pad * 2;
    p.espacio(alto + lineH * 2);
    p.page.drawRectangle({ x: MARGIN, y: p.y - alto, width: CONTENT_W, height: alto, color: HEADER_BG });
    let x = MARGIN;
    cols.forEach((c, i) => {
      lineas[i]!.forEach((l, n) => {
        const w = p.ancho(l, p.negrita, size);
        p.page.drawText(l, { x: c.numerica ? x + anchos[i]! - pad - w : x + pad, y: p.y - pad - size - n * lineH, size, font: p.negrita, color: TEXT });
      });
      x += anchos[i]!;
    });
    p.y -= alto;
  };
  encabezado();
  for (const f of filas) {
    const font = f.negrita ? p.negrita : p.regular;
    const celdas = cols.map((_, i) => p.ajustar(f.celdas[i] ?? "", anchos[i]! - pad * 2, font, size).slice(0, 2));
    const alto = Math.max(...celdas.map((l) => l.length)) * lineH + pad * 2;
    if (p.y - alto < MARGIN + FOOTER_H) {
      p.nuevaPagina();
      encabezado();
    }
    let x = MARGIN;
    cols.forEach((c, i) => {
      celdas[i]!.forEach((l, n) => {
        const w = p.ancho(l, font, size);
        p.page.drawText(l, { x: c.numerica ? x + anchos[i]! - pad - w : x + pad, y: p.y - pad - size - n * lineH, size, font, color: TEXT });
      });
      x += anchos[i]!;
    });
    p.page.drawLine({ start: { x: MARGIN, y: p.y - alto }, end: { x: MARGIN + CONTENT_W, y: p.y - alto }, thickness: 0.3, color: RULE });
    p.y -= alto;
  }
  p.y -= 8;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Gráficas vectoriales (salen de las cifras de la vista, nunca de un modelo)
// ---------------------------------------------------------------------------------------------------------------------------

const CHART_H = 150;

function ejes(p: Pdf, x0: number, yBase: number, w: number, h: number, min: number, max: number): (v: number) => number {
  const span = max - min || 1;
  const yOf = (v: number): number => yBase + ((v - min) / span) * h;
  for (let i = 0; i <= 4; i += 1) {
    const v = min + (span * i) / 4;
    const yy = yOf(v);
    p.page.drawLine({ start: { x: x0, y: yy }, end: { x: x0 + w, y: yy }, thickness: 0.4, color: RULE });
    const label = p.limpiar(compactoPesos(v));
    p.page.drawText(label, { x: x0 - 4 - p.ancho(label, p.regular, 7), y: yy - 2.5, size: 7, font: p.regular, color: MUTED });
  }
  return yOf;
}

function etiquetasX(p: Pdf, etiquetas: readonly string[], xs: readonly number[], yBase: number, paso: number, anchoMax = 52): void {
  etiquetas.forEach((e, i) => {
    if (i % paso !== 0) return;
    const l = p.recortar(e, anchoMax, p.regular, 6.5);
    p.page.drawText(l, { x: xs[i]! - p.ancho(l, p.regular, 6.5) / 2, y: yBase - 11, size: 6.5, font: p.regular, color: MUTED });
  });
}

function tituloGrafica(p: Pdf, titulo: string, sub: string): void {
  p.espacio(CHART_H + 40);
  p.texto(titulo, { size: 9.5, font: p.negrita, gap: 1 });
  p.texto(sub, { size: 7.5, color: MUTED, gap: 4 });
}

function graficaTendencia(p: Pdf, puntos: ReadonlyArray<{ clave: string; netaCentavos: number }>): void {
  tituloGrafica(p, "Tendencia de ventas netas", "Ventas netas con IVA por periodo, en pesos");
  if (puntos.length === 0) {
    p.texto("Sin datos de ventas en el periodo.", { size: 8.5, color: MUTED, gap: 6 });
    return;
  }
  // Tope de 60 puntos: se toman posiciones equidistantes (determinista).
  const idx = puntos.length <= 60 ? puntos.map((_, i) => i) : Array.from({ length: 60 }, (_, i) => Math.round((i * (puntos.length - 1)) / 59));
  const sel = idx.map((i) => puntos[i]!);
  const left = 44;
  const x0 = MARGIN + left;
  const w = CONTENT_W - left - 8;
  const yBase = p.y - CHART_H + 8;
  const h = CHART_H - 28;
  const valores = sel.map((s) => s.netaCentavos);
  const min = Math.min(0, ...valores);
  const max = Math.max(0, ...valores) || 1;
  const yOf = ejes(p, x0, yBase, w, h, min, max);
  const n = sel.length;
  const xs = sel.map((_, i) => (n === 1 ? x0 + w / 2 : x0 + (w * i) / (n - 1)));
  for (let i = 1; i < n; i += 1) p.page.drawLine({ start: { x: xs[i - 1]!, y: yOf(valores[i - 1]!) }, end: { x: xs[i]!, y: yOf(valores[i]!) }, thickness: 1.6, color: BLUE });
  if (n <= 31) valores.forEach((v, i) => p.page.drawCircle({ x: xs[i]!, y: yOf(v), size: 2, color: BLUE }));
  etiquetasX(p, sel.map((s) => s.clave.slice(5)), xs, yBase, Math.max(1, Math.ceil(n / 8)));
  p.y -= CHART_H + 8;
}

function graficaBarras(p: Pdf, titulo: string, sub: string, items: ReadonlyArray<{ etiqueta: string; centavos: number }>): void {
  tituloGrafica(p, titulo, sub);
  if (items.length === 0) {
    p.texto("Sin datos para graficar.", { size: 8.5, color: MUTED, gap: 6 });
    return;
  }
  const left = 44;
  const x0 = MARGIN + left;
  const w = CONTENT_W - left - 8;
  const yBase = p.y - CHART_H + 8;
  const h = CHART_H - 28;
  const valores = items.map((i) => i.centavos);
  const min = Math.min(0, ...valores);
  const max = Math.max(0, ...valores) || 1;
  const yOf = ejes(p, x0, yBase, w, h, min, max);
  const n = items.length;
  const slot = w / n;
  const xs = items.map((_, i) => x0 + slot * (i + 0.5));
  const bw = Math.min(40, slot * 0.62);
  valores.forEach((v, i) => {
    p.page.drawRectangle({ x: xs[i]! - bw / 2, y: Math.min(yOf(v), yOf(0)), width: bw, height: Math.max(Math.abs(yOf(v) - yOf(0)), 0.5), color: BLUE });
    const lab = p.limpiar(compactoPesos(v));
    p.page.drawText(lab, { x: xs[i]! - p.ancho(lab, p.regular, 6.5) / 2, y: (v >= 0 ? yOf(v) : yOf(0)) + 2, size: 6.5, font: p.regular, color: TEXT });
  });
  etiquetasX(p, items.map((i) => i.etiqueta), xs, yBase, 1, Math.max(24, slot - 2));
  p.y -= CHART_H + 8;
}

function graficaDona(p: Pdf, titulo: string, sub: string, items: ReadonlyArray<{ etiqueta: string; centavos: number }>): void {
  tituloGrafica(p, titulo, sub);
  const positivos = items.map((i) => Math.max(0, i.centavos));
  const total = positivos.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    p.texto("Sin ventas por canal en el periodo.", { size: 8.5, color: MUTED, gap: 6 });
    return;
  }
  const R = 58;
  const r = 32;
  const cx = MARGIN + R + 20;
  const cy = p.y - CHART_H / 2 - 2;
  let fase = 0;
  positivos.forEach((v, i) => {
    if (v <= 0) return;
    const sweep = (v / total) * Math.PI * 2;
    const color = SERIES[i % SERIES.length]!;
    if (sweep >= Math.PI * 2 - 1e-6) p.page.drawCircle({ x: cx, y: cy, size: R, color });
    else {
      const f0 = fase;
      const f1 = fase + sweep;
      const pt = (rad: number, f: number): string => `${(rad * Math.sin(f)).toFixed(3)} ${(-rad * Math.cos(f)).toFixed(3)}`;
      const large = sweep > Math.PI ? 1 : 0;
      p.page.drawSvgPath(`M ${pt(R, f0)} A ${R} ${R} 0 ${large} 1 ${pt(R, f1)} L ${pt(r, f1)} A ${r} ${r} 0 ${large} 0 ${pt(r, f0)} Z`, { x: cx, y: cy, color });
    }
    fase += sweep;
  });
  p.page.drawCircle({ x: cx, y: cy, size: r, color: rgb(1, 1, 1) });
  let ly = cy + R - 6;
  positivos.forEach((v, i) => {
    if (v <= 0) return;
    p.page.drawRectangle({ x: MARGIN + 180, y: ly - 1, width: 8, height: 8, color: SERIES[i % SERIES.length]! });
    p.page.drawText(p.recortar(items[i]!.etiqueta, 170, p.regular, 8), { x: MARGIN + 194, y: ly, size: 8, font: p.regular, color: TEXT });
    const val = p.limpiar(`${compactoPesos(items[i]!.centavos)} (${((v / total) * 100).toFixed(1)}%)`);
    p.page.drawText(val, { x: MARGIN + 380, y: ly, size: 8, font: p.negrita, color: TEXT });
    ly -= 16;
  });
  p.y -= CHART_H + 8;
}

/** Cascada: cada paso es un total (barra desde 0) o un descuento (barra flotante que baja). */
function graficaCascada(p: Pdf, pasos: ReadonlyArray<{ etiqueta: string; centavos: number | null; tipo: "total" | "resta" }>): void {
  tituloGrafica(p, "Cascada: ventas brutas a netas sin IVA", "Pesos; las barras que bajan son descuentos, compensaciones o IVA estimado");
  const validos = pasos.filter((s) => s.centavos !== null);
  if (validos.length === 0) {
    p.texto("Sin datos de ventas en el periodo.", { size: 8.5, color: MUTED, gap: 6 });
    return;
  }
  const left = 44;
  const x0 = MARGIN + left;
  const w = CONTENT_W - left - 8;
  const yBase = p.y - CHART_H + 8;
  const h = CHART_H - 28;
  const max = Math.max(...validos.map((s) => s.centavos!), 1);
  const yOf = ejes(p, x0, yBase, w, h, 0, max);
  const n = pasos.length;
  const slot = w / n;
  const bw = Math.min(46, slot * 0.62);
  let nivel = 0;
  pasos.forEach((s, i) => {
    const cx = x0 + slot * (i + 0.5);
    if (s.centavos === null) {
      p.page.drawText("—", { x: cx - 3, y: yOf(0) + 2, size: 8, font: p.regular, color: MUTED });
    } else if (s.tipo === "total") {
      nivel = s.centavos;
      p.page.drawRectangle({ x: cx - bw / 2, y: yOf(0), width: bw, height: Math.max(yOf(s.centavos) - yOf(0), 0.5), color: BLUE });
      const lab = p.limpiar(compactoPesos(s.centavos));
      p.page.drawText(lab, { x: cx - p.ancho(lab, p.regular, 6.5) / 2, y: yOf(s.centavos) + 2, size: 6.5, font: p.regular, color: TEXT });
    } else {
      const baja = Math.min(s.centavos, nivel);
      const nuevo = nivel - baja;
      p.page.drawRectangle({ x: cx - bw / 2, y: yOf(nuevo), width: bw, height: Math.max(yOf(nivel) - yOf(nuevo), 0.5), color: ROJO });
      const lab = p.limpiar(`menos ${compactoPesos(s.centavos)}`);
      p.page.drawText(lab, { x: cx - p.ancho(lab, p.regular, 6.5) / 2, y: yOf(nivel) + 2, size: 6.5, font: p.regular, color: TEXT });
      nivel = nuevo;
    }
    const l = p.recortar(s.etiqueta, slot - 2, p.regular, 6.5);
    p.page.drawText(l, { x: cx - p.ancho(l, p.regular, 6.5) / 2, y: yBase - 11, size: 6.5, font: p.regular, color: MUTED });
  });
  p.y -= CHART_H + 8;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Secciones
// ---------------------------------------------------------------------------------------------------------------------------

function semaforoColor(s: KpiTarjeta["semaforo"]): ReturnType<typeof rgb> {
  return s === "verde" ? VERDE : s === "ambar" ? AMBAR : s === "rojo" ? ROJO : RULE;
}

function tarjetasKpi(p: Pdf, kpis: readonly KpiTarjeta[]): void {
  const cols = 3;
  const gap = 8;
  const w = (CONTENT_W - gap * (cols - 1)) / cols;
  const h = 50;
  for (let i = 0; i < kpis.length; i += cols) {
    p.espacio(h + gap);
    kpis.slice(i, i + cols).forEach((k, j) => {
      const x = MARGIN + j * (w + gap);
      p.page.drawRectangle({ x, y: p.y - h, width: w, height: h, color: CARD_BG, borderColor: RULE, borderWidth: 0.5 });
      p.page.drawRectangle({ x, y: p.y - h, width: 3, height: h, color: semaforoColor(k.semaforo) });
      p.page.drawText(p.recortar(k.etiqueta, w - 18, p.regular, 7.5), { x: x + 10, y: p.y - 13, size: 7.5, font: p.regular, color: MUTED });
      p.page.drawText(p.recortar(valorKpi(k), w - 18, p.negrita, 14), { x: x + 10, y: p.y - 30, size: 14, font: p.negrita, color: TEXT });
      p.page.drawText(p.recortar(variacionKpi(k), w - 18, p.regular, 7), { x: x + 10, y: p.y - 43, size: 7, font: p.regular, color: MUTED });
    });
    p.y -= h + gap;
  }
}

function filasEstadoResultados(cols: readonly ColumnaPyl[]): FilaTabla[] {
  return ORDEN_LINEAS.map((id) => ({
    celdas: [ETIQUETA_LINEA[id], ...cols.map((c) => {
      const l = c.lineas.find((x) => x.id === id);
      return l ? pesos(l.cifra) : "—";
    })],
    negrita: LINEAS_NEGRITA.has(id),
  }));
}

function seccionEstadoResultados(p: Pdf, vistas: VistasCfo): void {
  const er = vistas.estadoResultados;
  if (!er) return;
  p.titulo("Estado de resultados operativo");
  p.texto(`Periodo ${er.estadoResultados.rango.desde} a ${er.estadoResultados.rango.hasta}. Montos en pesos MXN. * estimado, ° capturado, — sin dato (nunca es cero).`, { size: 7.5, color: MUTED, gap: 4 });
  const todas = er.estadoResultados.acumulado.columnas;
  const total = todas.find((c) => c.clave === "total");
  const sucursales = todas.filter((c) => c.clave === "sucursal");
  const detalle = sucursales.length <= CFO_PDF_MAX_SUCURSALES_DETALLE;
  const cols = detalle ? todas : total ? [total] : todas;
  const size = cols.length > 6 ? 6.5 : 7.5;
  tabla(
    p,
    [{ titulo: "Concepto", peso: cols.length > 6 ? 2.4 : 2.6 }, ...cols.map((c) => ({ titulo: c.clave === "total" ? "Total" : c.clave === "no_asignado" ? "No asignado" : c.nombre, peso: 1.4, numerica: true }))],
    filasEstadoResultados(cols),
    size,
  );
  if (!detalle) p.texto(`La organización tiene ${sucursales.length} sucursales: el estado de resultados por sucursal va solo en el Excel.`, { size: 8, color: MUTED, gap: 4 });
  if (total && total.incompleto.length > 0) p.nota(`EBITDA incompleto: faltan ${total.incompleto.map((id) => ETIQUETA_LINEA[id].toLowerCase()).join(", ")}. Se muestra el margen de contribución.`);
  if (total) {
    const r = total.ratios;
    const f = (c: Cifra): string => (c.valor === null ? "—" : `${formatoPct(c.valor)}${marca(c)}`);
    p.texto(`Margen bruto ${f(r.margenBrutoPct)} · Food cost ${f(r.foodCostPct)} · Prime cost ${f(r.primeCostPct)} · Costo del agente ${f(r.costoAgentePct)} · Margen de contribución ${f(r.margenContribucionPct)}`, { size: 8, gap: 4 });
  }
}

function seccionSucursales(p: Pdf, vistas: VistasCfo): void {
  const s = vistas.sucursales;
  if (!s) return;
  p.titulo("Comparativo de sucursales");
  tabla(
    p,
    [
      { titulo: "Sucursal", peso: 2.4 },
      { titulo: "Pedidos", peso: 1, numerica: true },
      { titulo: "Ventas netas", peso: 1.5, numerica: true },
      { titulo: "Particip.", peso: 1, numerica: true },
      { titulo: "Ticket", peso: 1.1, numerica: true },
      { titulo: "Desc. %", peso: 1, numerica: true },
      { titulo: "Cancel. %", peso: 1, numerica: true },
      { titulo: "Entrega p90", peso: 1.1, numerica: true },
    ],
    [
      ...s.tabla.map((f) => ({
        celdas: [
          f.nombre,
          formatoEntero(f.pedidos),
          formatoPesos(f.netaCentavos),
          f.participacionPct.valor === null ? "—" : formatoPct(f.participacionPct.valor),
          pesos(f.ticket),
          f.descuentoPct.valor === null ? "—" : formatoPct(f.descuentoPct.valor),
          f.cancelacionPct.valor === null ? "—" : formatoPct(f.cancelacionPct.valor),
          f.entregaP90Min.valor === null ? "—" : formatoMinutos(f.entregaP90Min.valor),
        ],
      })),
      {
        celdas: ["Total", formatoEntero(s.total.pedidos), formatoPesos(s.total.netaCentavos), "—", pesos(s.total.ticket), s.total.descuentoPct.valor === null ? "—" : formatoPct(s.total.descuentoPct.valor), s.total.cancelacionPct.valor === null ? "—" : formatoPct(s.total.cancelacionPct.valor), "—"],
        negrita: true,
      },
    ],
    7.5,
  );
  for (const o of s.outliers.slice(0, 6)) p.texto(`Fuera de patrón: ${o.nombre}, ${o.metrica} (${o.motivo}).`, { size: 8, color: MUTED });
}

function seccionDetalleSucursales(p: Pdf, vistas: VistasCfo): void {
  const cab = cabeceraDe(vistas);
  if (!cab || cab.sucursales.length === 0) return;
  if (cab.sucursales.length > CFO_PDF_MAX_SUCURSALES_DETALLE) {
    p.titulo("Detalle por sucursal");
    p.nota(`La organización tiene ${cab.sucursales.length} sucursales. Este reporte trae el comparativo; el detalle de cada sucursal (indicadores y estado de resultados) va en el Excel, una hoja por sucursal.`);
    return;
  }
  for (const s of cab.sucursales) {
    p.titulo(`Sucursal: ${s.nombre}${s.activa === false ? " (inactiva)" : ""}`, true);
    const kpis = vistas.resumen?.kpis.porSucursal.find((x) => x.propertyId === s.propertyId);
    if (kpis) tarjetasKpi(p, kpis.kpis.slice(0, 9));
    const col = vistas.estadoResultados?.estadoResultados.acumulado.columnas.find((c) => c.clave === "sucursal" && c.propertyId === s.propertyId);
    if (col) {
      p.texto("Estado de resultados de la sucursal", { size: 9.5, font: p.negrita, gap: 2 });
      tabla(p, [{ titulo: "Concepto", peso: 3 }, { titulo: "Periodo", peso: 1.6, numerica: true }], filasEstadoResultados([col]), 8);
      if (col.incompleto.length > 0) p.texto(`EBITDA incompleto: faltan ${col.incompleto.map((id) => ETIQUETA_LINEA[id].toLowerCase()).join(", ")}.`, { size: 8, color: MUTED });
    }
  }
}

function seccionNotas(p: Pdf, vistas: VistasCfo): void {
  const cab = cabeceraDe(vistas);
  p.titulo("Notas y supuestos", true);
  const punto = (t: string): void => p.texto(`- ${t}`, { size: 8.5, gap: 2 });
  punto("IVA: el IVA es una ESTIMACIÓN con la tasa configurada en el CFO; no proviene de facturas (CFDI).");
  punto("Costos mensuales (nómina, renta, servicios, insumos): los captura el dueño; cuando el periodo no cubre el mes completo se PRORRATEAN por días y la cifra sale como estimada.");
  punto("Costo de ventas y EBITDA: solo se muestran cuando hay dato de todas las líneas requeridas; si falta captura, el reporte lo dice y no inventa un cero.");
  punto("Clientes: los clientes únicos NO se suman entre sucursales; el renglón del conjunto cuenta cada cliente una sola vez.");
  const defs = vistas.clientes ? Object.values(vistas.clientes.definiciones) : [];
  if (defs.length > 0) for (const d of defs) punto(d);
  else punto("Cliente frecuente: N o más pedidos en X días (N y X se configuran en el CFO).");
  if (vistas.resumen?.multiSucursal.texto) punto(vistas.resumen.multiSucursal.texto);
  if (cab) {
    p.y -= 4;
    p.texto("Fuentes y confianza de los datos", { size: 10, font: p.negrita, gap: 2 });
    for (const f of cab.fuentes) punto(`${f.nombre}: ${f.confianza}; cobertura ${f.cobertura.desde ?? "—"} a ${f.cobertura.hasta ?? "—"}${f.disponible ? "" : "; NO disponible en esta base"}.`);
    const avisos = [...new Set(Object.values(vistas).flatMap((x) => (x ? (x as { avisos: readonly string[] }).avisos : [])))];
    if (avisos.length > 0) {
      p.y -= 4;
      p.texto("Avisos", { size: 10, font: p.negrita, gap: 2 });
      for (const a of avisos) punto(a);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Documento
// ---------------------------------------------------------------------------------------------------------------------------

/** Construye el PDF del CFO. Lanza `CfoPdfDemasiadasPaginas` si el contenido pasaría de 40 páginas. */
export async function construirReporteCfoPdf(vistas: VistasCfo, alcance: AlcanceExportacion, generadoEn: Date): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold);
  const p = new Pdf(doc, regular, negrita);
  const cab = cabeceraDe(vistas);

  doc.setTitle(p.limpiar(`Reporte del CFO ${alcance.desde} a ${alcance.hasta}`));
  doc.setSubject(p.limpiar(`Periodo: ${alcance.desde} a ${alcance.hasta} | Alcance: ${alcance.alcance.etiqueta} | Cifras de la base`));
  doc.setAuthor("Atiende");
  doc.setProducer("Atiende");
  doc.setCreator("Atiende");
  doc.setCreationDate(generadoEn);
  doc.setModificationDate(generadoEn);

  // ---- portada ----
  p.y -= 90;
  p.texto(alcance.organizacion, { size: 11, color: MUTED, gap: 6 });
  p.texto("Reporte del CFO", { size: 28, font: negrita, gap: 8 });
  p.texto(`Periodo: ${alcance.desde} a ${alcance.hasta}`, { size: 12, gap: 2 });
  p.texto(`Alcance: ${alcance.alcance.etiqueta}`, { size: 12, gap: 2 });
  if (cab && cab.sucursales.length > 0) p.texto(`Sucursales: ${cab.sucursales.map((s) => s.nombre).join(", ")}`, { size: 9.5, color: MUTED, gap: 2 });
  p.texto(`Generado: ${fechaUtc(generadoEn)}`, { size: 9.5, color: MUTED, gap: 24 });
  p.nota(AVISO_NO_SUSTITUCION);
  p.nota(cab?.avisoLegal ?? AVISO_CFO);
  p.texto("Leyenda: * cifra estimada (supuesto o prorrateo) · ° cifra capturada por el dueño · — sin dato (nunca se muestra como cero).", { size: 8, color: MUTED });

  // ---- resumen ejecutivo ----
  if (vistas.resumen) {
    const r = vistas.resumen;
    p.titulo("Resumen ejecutivo", true);
    p.texto(r.narrativa.texto || "No hay datos suficientes en el periodo para narrar un resumen.", { size: 10, gap: 6 });
    p.titulo("Lo más importante");
    if (r.hallazgos.length === 0) p.texto("Sin hallazgos prioritarios en el periodo.", { size: 9, color: MUTED });
    r.hallazgos.slice(0, 10).forEach((h, i) => {
      p.texto(`${i + 1}. ${h.titulo}: ${h.cifraTexto}`, { size: 9.5, font: negrita, gap: 1 });
      p.texto(`${h.comparacion} ${h.porQueImporta}`, { size: 8.5, gap: 1 });
      p.texto(`Qué hacer: ${h.accion.texto}${h.impactoCentavos === null ? "" : ` · En juego: ${formatoPesos(h.impactoCentavos)}`} · Urgencia ${h.urgencia}`, { size: 8, color: MUTED, gap: 5 });
    });
    p.titulo("Indicadores");
    tarjetasKpi(p, r.kpis.total.kpis);
  }

  // ---- gráficas ----
  if (vistas.ventas) {
    const v = vistas.ventas;
    p.titulo("Ventas", true);
    graficaTendencia(p, v.ventas.total.serie);
    graficaBarras(p, "Ventas netas por sucursal", "Pesos, periodo completo", v.ventas.porSucursal.map((s) => ({ etiqueta: s.nombre, centavos: s.sumas.netaCentavos })));
    graficaDona(p, "Mix de canal", "Participación en ventas netas por canal y origen", v.porCanal.map((c) => ({ etiqueta: `${c.canal} · ${c.source}`, centavos: c.netaCentavos })));
    const c = v.ventas.total.cascada;
    graficaCascada(p, [
      { etiqueta: "Bruta", centavos: c.brutaCentavos.valor, tipo: "total" },
      { etiqueta: "Promoción", centavos: c.descuentoPromocionCentavos.valor, tipo: "resta" },
      { etiqueta: "Compensac.", centavos: c.compensacionesCentavos.valor, tipo: "resta" },
      { etiqueta: "Neta", centavos: c.netaCentavos.valor, tipo: "total" },
      { etiqueta: "IVA est.", centavos: c.ivaEstimadoCentavos.valor, tipo: "resta" },
      { etiqueta: "Neta sin IVA", centavos: c.netaSinIvaCentavos.valor, tipo: "total" },
    ]);
  }

  seccionEstadoResultados(p, vistas);
  seccionSucursales(p, vistas);
  seccionDetalleSucursales(p, vistas);
  seccionNotas(p, vistas);

  // ---- pie en TODAS las hojas ----
  const total = p.paginas.length;
  const pie1 = `Generado ${fechaUtc(generadoEn)} · Alcance: ${alcance.alcance.etiqueta} · Periodo ${alcance.desde} a ${alcance.hasta}`;
  const pie2 = "Cifras de la base; estimadas y capturadas rotuladas.";
  p.paginas.forEach((page, i) => {
    page.drawLine({ start: { x: MARGIN, y: MARGIN + 22 }, end: { x: PAGE_W - MARGIN, y: MARGIN + 22 }, thickness: 0.5, color: RULE });
    page.drawText(p.recortar(pie1, CONTENT_W - 80, regular, 6.5), { x: MARGIN, y: MARGIN + 13, size: 6.5, font: regular, color: MUTED });
    page.drawText(p.limpiar(pie2), { x: MARGIN, y: MARGIN + 5, size: 6.5, font: regular, color: MUTED });
    const num = `Página ${i + 1} de ${total}`;
    page.drawText(num, { x: PAGE_W - MARGIN - regular.widthOfTextAtSize(num, 7), y: MARGIN + 13, size: 7, font: regular, color: MUTED });
  });

  return doc.save({ useObjectStreams: false });
}
