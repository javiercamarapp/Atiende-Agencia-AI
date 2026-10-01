// Rn-03 -- exportación del reporte: CSV (abre directo en Excel: UTF-8 con BOM, CRLF) y un
// PDF simple de una tabla. Sin dependencias nuevas, sin IO.
import type { AgrupacionReporte, GrupoReporte, ResultadoReporte } from "./tipos.ts";

const ETIQUETA_GRUPO: Record<AgrupacionReporte, string> = { unidad: "Unidad", propietario: "Propietario", canal: "Canal", mes: "Mes" };

export function formatearCentavos(centavos: number): string {
  const signo = centavos < 0 ? "-" : "";
  const abs = Math.abs(centavos);
  return `${signo}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatearBasisPoints(bp: number | null): string {
  return bp === null ? "" : formatearCentavos(bp);
}

export function gruposDe(reporte: ResultadoReporte, agrupar: AgrupacionReporte): readonly GrupoReporte[] {
  switch (agrupar) {
    case "unidad":
      return reporte.porUnidad;
    case "propietario":
      return reporte.porPropietario;
    case "canal":
      return reporte.porCanal;
    case "mes":
      return reporte.porMes;
  }
}

export const ENCABEZADOS_TABLA = ["Llegadas", "Noches ocupadas", "Noches disponibles", "Ocupacion %", "Ingreso bruto", "Comision canal", "Comision gestor", "Gastos", "Impuestos", "Neto", "ADR"] as const;

function celdasMetricas(m: GrupoReporte | ResultadoReporte["totales"]): string[] {
  return [
    String(m.llegadas),
    String(m.nochesOcupadas),
    m.nochesDisponibles === null ? "" : String(m.nochesDisponibles),
    formatearBasisPoints(m.ocupacionBasisPoints),
    formatearCentavos(m.ingresoBrutoCentavos),
    formatearCentavos(m.comisionCanalCentavos),
    formatearCentavos(m.comisionGestorCentavos),
    formatearCentavos(m.gastosCentavos),
    formatearCentavos(m.impuestosCentavos),
    formatearCentavos(m.netoCentavos),
    formatearCentavos(m.adrCentavos),
  ];
}

/** Filas de la tabla exportada: encabezado, un renglón por grupo y un renglón TOTAL. */
export function tablaReporte(reporte: ResultadoReporte, agrupar: AgrupacionReporte): string[][] {
  const filas: string[][] = [[ETIQUETA_GRUPO[agrupar], ...ENCABEZADOS_TABLA]];
  for (const g of gruposDe(reporte, agrupar)) filas.push([g.etiqueta, ...celdasMetricas(g)]);
  filas.push(["TOTAL", ...celdasMetricas(reporte.totales)]);
  return filas;
}

/** Neutraliza inyección de fórmulas en Excel/Sheets: una celda de TEXTO que empieza con
 * = + - @ tab o CR se antepone con apóstrofo. Las celdas numéricas (montos) no pasan por aquí. */
export function celdaTextoSegura(valor: string): string {
  return /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
}

function celdaCsv(valor: string): string {
  return /[",\r\n]/.test(valor) ? `"${valor.replaceAll('"', '""')}"` : valor;
}

export function reporteACsv(reporte: ResultadoReporte, agrupar: AgrupacionReporte): string {
  const filas = tablaReporte(reporte, agrupar);
  const lineas = filas.map((fila, i) => fila.map((celda, j) => celdaCsv(i > 0 && j === 0 ? celdaTextoSegura(celda) : celda)).join(","));
  const meta = [`Reporte de ocupacion e ingresos`, `Periodo,${reporte.periodo.inicio} a ${reporte.periodo.fin} (fin exclusivo)`, `Moneda,${reporte.moneda}`, `Montos,en unidades de moneda (centavos / 100)`];
  return `﻿${[...meta, "", ...lineas].join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// PDF mínimo (PDF 1.4, Courier, A4 horizontal). Solo Latin-1: lo demás sale como '?'.
// ---------------------------------------------------------------------------
const PAGINA_ANCHO = 842;
const PAGINA_ALTO = 595;
const MARGEN = 36;
const TAM_FUENTE = 8;
const INTERLINEADO = 11;

function aLatin1(texto: string): string {
  let out = "";
  for (const ch of texto) {
    const code = ch.codePointAt(0)!;
    out += code >= 32 && code <= 255 ? ch : "?";
  }
  return out;
}

function escaparPdf(texto: string): string {
  return aLatin1(texto).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

export function tablaATextoPlano(filas: string[][]): string[] {
  const anchos = filas[0]!.map((_, c) => Math.max(...filas.map((f) => aLatin1(f[c] ?? "").length)));
  anchos[0] = Math.min(anchos[0]!, 28);
  return filas.map((f) => f.map((celda, c) => {
    const t = aLatin1(celda).slice(0, anchos[c]);
    return c === 0 ? t.padEnd(anchos[c]!) : t.padStart(anchos[c]!);
  }).join("  "));
}

export function reporteAPdf(reporte: ResultadoReporte, agrupar: AgrupacionReporte): Uint8Array {
  const encabezado = [
    "Reporte de ocupacion e ingresos",
    `Periodo: ${reporte.periodo.inicio} a ${reporte.periodo.fin} (fin exclusivo)   Moneda: ${reporte.moneda}   Agrupado por: ${ETIQUETA_GRUPO[agrupar]}`,
    "Montos en unidades de moneda. Una reserva que cruza meses se prorratea por noche.",
    "",
  ];
  const cuerpo = tablaATextoPlano(tablaReporte(reporte, agrupar));
  const adv = reporte.advertencias;
  const pie = [
    "",
    `Advertencias: sin movimiento financiero=${adv.reservasSinMovimientoFinanciero}; moneda distinta=${adv.reservasMonedaDistinta}; noches solapadas omitidas=${adv.nochesSolapadasOmitidas}; duplicadas omitidas=${adv.reservasDuplicadasOmitidas}`,
  ];
  const lineas = [...encabezado, ...cuerpo, ...pie];
  const porPagina = Math.floor((PAGINA_ALTO - 2 * MARGEN) / INTERLINEADO);
  const paginas: string[][] = [];
  for (let i = 0; i < lineas.length; i += porPagina) paginas.push(lineas.slice(i, i + porPagina));
  if (paginas.length === 0) paginas.push([]);

  // Objetos: 1 catálogo, 2 páginas, 3 fuente, luego (página, contenido) por cada página.
  const objetos: string[] = [];
  const kids: number[] = [];
  paginas.forEach((pag, i) => {
    const idPagina = 4 + i * 2;
    const idContenido = idPagina + 1;
    kids.push(idPagina);
    const texto = pag.map((l, n) => `BT /F1 ${TAM_FUENTE} Tf ${MARGEN} ${PAGINA_ALTO - MARGEN - n * INTERLINEADO} Td (${escaparPdf(l)}) Tj ET`).join("\n");
    objetos[idPagina] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGINA_ANCHO} ${PAGINA_ALTO}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${idContenido} 0 R >>`;
    objetos[idContenido] = `<< /Length ${texto.length} >>\nstream\n${texto}\nendstream`;
  });
  objetos[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objetos[2] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  objetos[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>";

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objetos.length; id++) {
    offsets[id] = pdf.length; // todo el contenido es Latin-1 (1 byte por carácter)
    pdf += `${id} 0 obj\n${objetos[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objetos.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objetos.length; id++) pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objetos.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
