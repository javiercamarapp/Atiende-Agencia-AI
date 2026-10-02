// Render del PDF del reporte: bytes validos, pie/periodo/alcance/"cifras reales", marca de agua, graficas vectoriales,
// leyenda honesta sin narrativa, paginacion de tablas largas y caracteres fuera de WinAnsi (nunca lanza).
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { ReporteContenido, ReporteTabla } from "@atiende/agent-core/data-chat";
import { renderReportePdf } from "../src/data-chat/reporte-pdf.ts";
import { paginasDelPdf, textoDelPdf } from "./support/pdf-text.ts";

const TABLA: ReporteTabla = {
  tool: "ventas_por_dia",
  title: "Ventas por día",
  source: "Pedidos (sin cancelados)",
  periodLabel: "últimos 30 días",
  scopeLabel: "todas tus sucursales",
  columns: [
    { key: "dia", label: "Día", kind: "text" },
    { key: "ventas", label: "Ventas", kind: "mxn" },
    { key: "pedidos", label: "Pedidos", kind: "integer" },
  ],
  rows: [
    { dia: "2026-09-28", ventas: 1500.5, pedidos: 12 },
    { dia: "2026-09-29", ventas: 980, pedidos: 8 },
    { dia: "2026-09-30", ventas: 1200, pedidos: 10 },
  ],
  truncated: false,
  chart: { kind: "bar", x: "dia", y: "ventas" },
};

function contenido(over: Partial<ReporteContenido> = {}): ReporteContenido {
  return {
    titulo: "Reporte: Ventas por día",
    tablas: [TABLA],
    omitidas: [],
    hallazgos: [{ tipo: "kpi", texto: "El 28 se vendieron 1500.5 pesos en 12 pedidos.", fuentes: [{ tool: "ventas_por_dia", fila: 1 }] }],
    narrativa: { resumen: "Se vendieron 1500.5 pesos el 28 de septiembre.", secciones: [{ titulo: "Ventas", texto: "El mejor día fue el 28." }] },
    graficas: [{ kind: "bar", tool: "ventas_por_dia", x: "dia", y: "ventas", titulo: "Ventas por día" }],
    financiero: true,
    uso: { llmCalls: 2, costUsd: 0, reintento: false },
    ...over,
  };
}

const base = { organizacion: "Taquería Don Beto", vertical: "restaurantes", generadoEn: new Date("2026-10-02T13:30:00.000Z"), zonaHoraria: "America/Merida" };

describe("renderReportePdf", () => {
  it("produce un PDF valido con pie (fecha, periodo, alcance, cifras reales), titulo, narrativa y marca de agua", async () => {
    const bytes = await renderReportePdf({ ...base, contenido: contenido() });
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    const texto = textoDelPdf(bytes);
    expect(texto).toContain("Periodo: últimos 30 días");
    expect(texto).toContain("Alcance: todas tus sucursales");
    expect(texto).toContain("Cifras reales de tu sistema");
    expect(texto).toContain("Generado el 2 de octubre de 2026");
    expect(texto).toContain("Taquería Don Beto");
    expect(texto).toContain("Se vendieron 1500.5 pesos");
    expect(texto).toContain("Fuente: Ventas por día, fila 1");
    expect(texto).not.toContain("Narrativa no disponible");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toBe("Reporte: Ventas por día");
  });

  it("sin narrativa dice honestamente por que y conserva tablas y graficas", async () => {
    const bytes = await renderReportePdf({ ...base, contenido: contenido({ narrativa: null, hallazgos: [], motivoSinNarrativa: "guardia" }) });
    const texto = textoDelPdf(bytes);
    expect(texto).toContain("Narrativa no disponible: la verificación de cifras");
    expect(texto).toContain("contiene solo las tablas");
    expect(texto).toContain("Cifras reales de tu sistema");
    expect(texto).not.toContain("Hallazgos");
  });

  it("es determinista: mismo contenido y misma fecha dan los mismos bytes", async () => {
    const a = await renderReportePdf({ ...base, contenido: contenido() });
    const b = await renderReportePdf({ ...base, contenido: contenido() });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("dibuja barras, lineas y dona sin lanzar (incluida una dona de un solo segmento y valores negativos)", async () => {
    const donaTabla: ReporteTabla = { ...TABLA, tool: "dona", title: "Composición", rows: TABLA.rows.slice(0, 3) };
    const unico: ReporteTabla = { ...TABLA, tool: "uno", title: "Uno", rows: [{ dia: "Único", ventas: 500, pedidos: 1 }] };
    const neg: ReporteTabla = { ...TABLA, tool: "neg", title: "Neg", rows: [{ dia: "a", ventas: -200, pedidos: 1 }, { dia: "b", ventas: 300, pedidos: 2 }] };
    const c = contenido({
      tablas: [TABLA, donaTabla, unico, neg],
      graficas: [
        { kind: "bar", tool: "ventas_por_dia", x: "dia", y: "ventas", titulo: "Barras" },
        { kind: "line", tool: "ventas_por_dia", x: "dia", y: "pedidos", titulo: "Línea" },
        { kind: "donut", tool: "dona", x: "dia", y: "ventas", titulo: "Dona" },
        { kind: "donut", tool: "uno", x: "dia", y: "ventas", titulo: "Dona única" },
        { kind: "bar", tool: "neg", x: "dia", y: "ventas", titulo: "Negativos" },
      ],
    });
    const bytes = await renderReportePdf({ ...base, contenido: c });
    expect(bytes.byteLength).toBeGreaterThan(1500);
    const texto = textoDelPdf(bytes);
    expect(texto).toContain("Barras");
    expect(texto).toContain("Dona única");
  });

  it("pagina las tablas largas con el encabezado repetido y el pie en cada pagina", async () => {
    const filas = Array.from({ length: 50 }, (_, i) => ({ dia: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`, ventas: 100 + i, pedidos: i }));
    const c = contenido({ tablas: [{ ...TABLA, rows: filas, truncated: true }, { ...TABLA, tool: "t2", title: "Segunda", rows: filas }], graficas: [] });
    const bytes = await renderReportePdf({ ...base, contenido: c });
    const n = paginasDelPdf(bytes);
    expect(n).toBeGreaterThan(2);
    const texto = textoDelPdf(bytes);
    expect(texto.match(/Cifras reales de tu sistema/g)!.length).toBeGreaterThanOrEqual(n);
    expect(texto).toContain(`Página ${n} de ${n}`);
    expect(texto).toContain("Se muestran las primeras 50 filas");
  });

  it("caracteres fuera de WinAnsi (emoji, CJK) se sustituyen por ? en vez de lanzar", async () => {
    const c = contenido({ tablas: [{ ...TABLA, rows: [{ dia: "Taquería 🌮 東京", ventas: 10, pedidos: 1 }] }], graficas: [] });
    const bytes = await renderReportePdf({ ...base, organizacion: "東京 Tacos", contenido: c });
    expect(Buffer.from(bytes.slice(0, 4)).toString("latin1")).toBe("%PDF");
  });

  it("lista las consultas omitidas con su motivo", async () => {
    const c = contenido({ omitidas: [{ tool: "x", title: "Otra consulta", motivo: "Sin datos en el periodo." }] });
    expect(textoDelPdf(await renderReportePdf({ ...base, contenido: c }))).toContain("Otra consulta: Sin datos en el periodo.");
  });
});
