// Exportación a Excel (.xlsx, Office Open XML) de un `ReporteCliente`, SIN dependencias:
// un .xlsx es un ZIP de partes XML, así que este módulo escribe un ZIP mínimo (método
// "stored", sin compresión; CRC-32 por entrada) y las partes SpreadsheetML necesarias.
// Puro (sin I/O ni reloj): devuelve los bytes; la capa de API los sirve.
//
// Decisiones:
//  - Hoja 1 "Resumen": contribuyente, RFC, período, fecha de generación y notas de alcance.
//    Una hoja adicional por sección del reporte (nombre saneado, único, <= 31 caracteres).
//  - Texto como `inlineStr` (nunca fórmulas): un valor que empiece con "=", "+", "-" o "@"
//    NO se interpreta como fórmula (defensa contra inyección de fórmulas en Excel).
//  - Montos como número con formato `$#,##0.00` (se pueden sumar en Excel, no son texto).
//  - Una sección "sin datos" se escribe con su motivo, nunca vacía ni con ceros.
import type { CeldaReporte, ColumnaReporte, ReporteTabular, SeccionReporte } from "./types.ts";

// ---- CRC-32 (IEEE 802.3), tabla precalculada ----
const TABLA_CRC: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = TABLA_CRC[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface EntradaZip {
  readonly nombre: string;
  readonly datos: Uint8Array;
}

const ENC = new TextEncoder();

/** ZIP mínimo (stored). Fecha DOS fija (2026-01-01) para que la salida sea determinista. */
export function crearZipStored(entradas: readonly EntradaZip[]): Uint8Array {
  const DOS_FECHA = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const DOS_HORA = 0;
  const locales: Uint8Array[] = [];
  const centrales: Uint8Array[] = [];
  let offset = 0;

  for (const e of entradas) {
    const nombre = ENC.encode(e.nombre);
    const crc = crc32(e.datos);
    const local = new Uint8Array(30 + nombre.length + e.datos.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // versión mínima
    lv.setUint16(6, 0x0800, true); // bit 11: nombres UTF-8
    lv.setUint16(8, 0, true); // método 0 = stored
    lv.setUint16(10, DOS_HORA, true);
    lv.setUint16(12, DOS_FECHA, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.datos.length, true);
    lv.setUint32(22, e.datos.length, true);
    lv.setUint16(26, nombre.length, true);
    lv.setUint16(28, 0, true);
    local.set(nombre, 30);
    local.set(e.datos, 30 + nombre.length);
    locales.push(local);

    const central = new Uint8Array(46 + nombre.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_HORA, true);
    cv.setUint16(14, DOS_FECHA, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.datos.length, true);
    cv.setUint32(24, e.datos.length, true);
    cv.setUint16(28, nombre.length, true);
    cv.setUint32(42, offset, true);
    central.set(nombre, 46);
    centrales.push(central);
    offset += local.length;
  }

  const tamCentral = centrales.reduce((a, c) => a + c.length, 0);
  const fin = new Uint8Array(22);
  const fv = new DataView(fin.buffer);
  fv.setUint32(0, 0x06054b50, true);
  fv.setUint16(8, entradas.length, true);
  fv.setUint16(10, entradas.length, true);
  fv.setUint32(12, tamCentral, true);
  fv.setUint32(16, offset, true);

  const out = new Uint8Array(offset + tamCentral + 22);
  let p = 0;
  for (const parte of [...locales, ...centrales, fin]) {
    out.set(parte, p);
    p += parte.length;
  }
  return out;
}

// ---- SpreadsheetML ----
const ESTILO = { normal: 0, encabezado: 1, moneda: 2, porcentaje: 3, titulo: 4, entero: 5, negrita: 6, monedaNegrita: 7 } as const;

/** Caracteres válidos en XML 1.0 (tab, LF, CR y desde U+0020, salvo U+FFFE/U+FFFF); el resto se descarta. */
function esCaracterXmlValido(cp: number): boolean {
  return cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp !== 0xfffe && cp !== 0xffff);
}

function escXml(s: string): string {
  let limpio = "";
  for (const ch of s) if (esCaracterXmlValido(ch.codePointAt(0)!)) limpio += ch;
  return limpio.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function nombreColumna(idx: number): string {
  let n = idx;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function celdaTexto(ref: string, texto: string, estilo: number): string {
  return `<c r="${ref}" t="inlineStr" s="${estilo}"><is><t xml:space="preserve">${escXml(texto)}</t></is></c>`;
}

function celdaNumero(ref: string, valor: number, estilo: number): string {
  return `<c r="${ref}" s="${estilo}"><v>${Number.isFinite(valor) ? String(valor) : "0"}</v></c>`;
}

function celda(ref: string, valor: CeldaReporte, col: ColumnaReporte, negrita: boolean): string {
  if (valor === null) return "";
  if (typeof valor === "number") {
    if (col.tipo === "moneda") return celdaNumero(ref, valor, negrita ? ESTILO.monedaNegrita : ESTILO.moneda);
    if (col.tipo === "porcentaje") return celdaNumero(ref, valor / 100, ESTILO.porcentaje);
    return celdaNumero(ref, valor, negrita ? ESTILO.negrita : ESTILO.entero);
  }
  return celdaTexto(ref, valor, negrita ? ESTILO.negrita : ESTILO.normal);
}

function fila(numero: number, celdas: readonly string[]): string {
  return `<row r="${numero}">${celdas.join("")}</row>`;
}

function hojaXml(filas: readonly string[], anchos: readonly number[]): string {
  const cols = anchos.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${filas.join("")}</sheetData></worksheet>`
  );
}

function hojaSeccion(seccion: SeccionReporte): string {
  const filas: string[] = [];
  let n = 1;
  filas.push(fila(n, [celdaTexto(`A${n}`, seccion.titulo, ESTILO.titulo)]));
  n += 2;
  if (seccion.sinDatosMotivo !== null) {
    filas.push(fila(n, [celdaTexto(`A${n}`, "Sin datos", ESTILO.negrita)]));
    n += 1;
    filas.push(fila(n, [celdaTexto(`A${n}`, seccion.sinDatosMotivo, ESTILO.normal)]));
  } else {
    filas.push(fila(n, seccion.columnas.map((c, i) => celdaTexto(`${nombreColumna(i)}${n}`, c.titulo, ESTILO.encabezado))));
    n += 1;
    for (const f of seccion.filas) {
      const fn = n;
      filas.push(fila(fn, seccion.columnas.map((c, i) => celda(`${nombreColumna(i)}${fn}`, f[c.clave] ?? null, c, false))));
      n += 1;
    }
    if (seccion.totales) {
      const tn = n;
      filas.push(fila(tn, seccion.columnas.map((c, i) => celda(`${nombreColumna(i)}${tn}`, seccion.totales![c.clave] ?? null, c, true))));
    }
  }
  const anchos = seccion.columnas.map((c) => (c.tipo === "texto" ? 34 : 18));
  return hojaXml(filas, anchos.length > 0 ? anchos : [40]);
}

function hojaResumen(reporte: ReporteTabular): string {
  const filas: string[] = [];
  let n = 1;
  const par = (k: string, v: string) => {
    filas.push(fila(n, [celdaTexto(`A${n}`, k, ESTILO.negrita), celdaTexto(`B${n}`, v, ESTILO.normal)]));
    n += 1;
  };
  filas.push(fila(n, [celdaTexto(`A${n}`, reporte.titulo, ESTILO.titulo)]));
  n += 2;
  par("Contribuyente", reporte.contribuyente.nombre);
  par("RFC", reporte.contribuyente.rfc ?? "Sin datos (sin ficha de cartera)");
  par("Período", reporte.periodo);
  par("Generado el", reporte.generadoEn);
  if (reporte.sinDatos) par("Estado", "Sin datos para el período");
  n += 1;
  filas.push(fila(n, [celdaTexto(`A${n}`, "Notas", ESTILO.negrita)]));
  n += 1;
  for (const nota of reporte.notas) {
    filas.push(fila(n, [celdaTexto(`A${n}`, nota, ESTILO.normal)]));
    n += 1;
  }
  return hojaXml(filas, [22, 60]);
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>` +
  `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>` +
  `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7EEF7"/></patternFill></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="8">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` + // 0 normal
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` + // 1 encabezado
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` + // 2 moneda
  `<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` + // 3 porcentaje
  `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` + // 4 título
  `<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` + // 5 entero
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` + // 6 negrita
  `<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>` + // 7 moneda negrita
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

/** Nombre de hoja válido en Excel: sin `[]:*?/\`, <= 31 caracteres, único (sin distinguir mayúsculas). */
export function nombreHojaSeguro(titulo: string, usados: Set<string>): string {
  const base = titulo.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Hoja";
  let nombre = base;
  let i = 2;
  while (usados.has(nombre.toLowerCase())) {
    const sufijo = ` (${i})`;
    nombre = base.slice(0, 31 - sufijo.length) + sufijo;
    i += 1;
  }
  usados.add(nombre.toLowerCase());
  return nombre;
}

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Genera el .xlsx del reporte (bytes). */
export function reporteAXlsx(reporte: ReporteTabular): Uint8Array {
  const usados = new Set<string>();
  const hojas: { nombre: string; xml: string }[] = [{ nombre: nombreHojaSeguro("Resumen", usados), xml: hojaResumen(reporte) }];
  for (const s of reporte.secciones) hojas.push({ nombre: nombreHojaSeguro(s.titulo, usados), xml: hojaSeccion(s) });

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    hojas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    `</Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
    hojas.map((h, i) => `<sheet name="${escXml(h.nombre)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    `</sheets></workbook>`;
  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  return crearZipStored([
    { nombre: "[Content_Types].xml", datos: ENC.encode(contentTypes) },
    { nombre: "_rels/.rels", datos: ENC.encode(rels) },
    { nombre: "xl/workbook.xml", datos: ENC.encode(workbook) },
    { nombre: "xl/_rels/workbook.xml.rels", datos: ENC.encode(workbookRels) },
    { nombre: "xl/styles.xml", datos: ENC.encode(STYLES_XML) },
    ...hojas.map((h, i) => ({ nombre: `xl/worksheets/sheet${i + 1}.xml`, datos: ENC.encode(h.xml) })),
  ]);
}
