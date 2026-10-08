// CFO-06 · Libro de Excel (.xlsx real, sin dependencias) del CFO de restaurantes: portada, resumen, estado de resultados, ventas por día,
// sucursales, clientes, platillos, operación, SoftRestaurant y UNA HOJA POR SUCURSAL (estado de resultados + KPIs de esa sucursal).
//
// Reglas:
//  - Reusa `crearZipStored` y `nombreHojaSeguro` de `@atiende/domain-despachos` (no se copian); las partes SpreadsheetML son propias.
//  - Texto SIEMPRE como `inlineStr` y, además, un texto de origen que empiece con = + - @ (o tab / retorno) se neutraliza con un apóstrofo
//    visible: nunca se escribe una fórmula desde un texto de origen (nombre de platillo, de sucursal, colonia...).
//  - Fórmulas vivas SOLO donde las generamos nosotros (subtotales y columna Total del estado de resultados), con el valor cacheado en `<v>` para que
//    se vea bien sin recalcular. Si la fórmula no reproduce la cifra de la vista (p. ej. un renglón «captura pendiente»), se escribe el valor, no la fórmula.
//  - Las cifras `null` (sin dato) se escriben como el texto «—», NUNCA como 0. `estimado` y `capturado` llevan fondo suave (leyenda en la portada).
//  - Determinista: la fecha de generación es un parámetro; mismos datos + mismo `generadoEn` = mismos bytes.
//  - Sin PII: las vistas del CFO no traen datos personales de clientes (el contrato de CFO-05 lo garantiza).
import { crearZipStored, nombreHojaSeguro, XLSX_CONTENT_TYPE } from "@atiende/domain-despachos";
import { AVISO_CFO } from "@atiende/domain-restaurantes/cfo";
import type {
  AlcanceApi,
  Cifra,
  ClientesVista,
  ColumnaPyl,
  CuadreSrVista,
  EstadoResultadosVista,
  KpiTarjeta,
  LineaId,
  OperacionVista,
  ProductosVista,
  ResumenVista,
  SucursalesVista,
  VentasVista,
  VistaCfoBase,
} from "@atiende/domain-restaurantes/cfo";

export { XLSX_CONTENT_TYPE };

export type VistaExportarCfo = "completo" | "resumen" | "estado-resultados" | "sucursales";
export const VISTAS_EXPORTAR_CFO: readonly VistaExportarCfo[] = ["completo", "resumen", "estado-resultados", "sucursales"];

/** Las vistas ya armadas por el servicio del CFO. Una vista en `null` no genera su hoja. */
export interface VistasCfo {
  readonly resumen: ResumenVista | null;
  readonly ventas: VentasVista | null;
  readonly sucursales: SucursalesVista | null;
  readonly estadoResultados: EstadoResultadosVista | null;
  readonly clientes: ClientesVista | null;
  readonly productos: ProductosVista | null;
  readonly operacion: OperacionVista | null;
  readonly cuadreSr: CuadreSrVista | null;
}

export interface AlcanceExportacion {
  /** Nombre (o identificador corto) de la organización para la portada. */
  readonly organizacion: string;
  readonly vista: VistaExportarCfo;
  readonly desde: string;
  readonly hasta: string;
  readonly alcance: AlcanceApi;
}

const ENC = new TextEncoder();

/** Cualquier vista disponible (todas llevan la misma cabecera). */
export function cabeceraDe(v: VistasCfo): VistaCfoBase | null {
  return v.resumen ?? v.estadoResultados ?? v.sucursales ?? v.ventas ?? v.clientes ?? v.productos ?? v.operacion ?? v.cuadreSr ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Texto, XML y estilos
// ---------------------------------------------------------------------------------------------------------------------------

function xmlValido(cp: number): boolean {
  return cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || cp >= 0x10000;
}

function escXml(s: string): string {
  let limpio = "";
  for (const ch of s) if (xmlValido(ch.codePointAt(0)!)) limpio += ch;
  return limpio.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Neutraliza un texto de origen: si empieza con = + - @ (o tab/retorno) se antepone un apóstrofo, así ninguna hoja de cálculo lo toma por fórmula. */
export function textoSeguro(t: string): string {
  return /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
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

type Formato = "general" | "moneda" | "pct" | "entero" | "dec1" | "fecha";
type Relleno = "ninguno" | "encabezado" | "estimado" | "capturado";
interface EstiloDef {
  readonly fmt: Formato;
  readonly bold?: boolean;
  readonly titulo?: boolean;
  readonly relleno?: Relleno;
  readonly wrap?: boolean;
  readonly derecha?: boolean;
}

const NUMFMT_ID: Record<Formato, number> = { general: 0, moneda: 164, pct: 165, entero: 3, dec1: 166, fecha: 167 };
const RELLENO_ID: Record<Relleno, number> = { ninguno: 0, encabezado: 2, estimado: 3, capturado: 4 };

/** Registro de estilos: cada combinación usada recibe un índice estable (orden de primer uso = determinista). */
class Estilos {
  private readonly lista: EstiloDef[] = [{ fmt: "general" }];
  private readonly indice = new Map<string, number>([["general||||||", 0]]);

  id(d: EstiloDef): number {
    const k = `${d.fmt}|${d.bold ? 1 : ""}|${d.titulo ? 1 : ""}|${d.relleno ?? ""}|${d.wrap ? 1 : ""}|${d.derecha ? 1 : ""}|`;
    const previo = this.indice.get(k);
    if (previo !== undefined) return previo;
    this.lista.push(d);
    this.indice.set(k, this.lista.length - 1);
    return this.lista.length - 1;
  }

  xml(): string {
    const xfs = this.lista
      .map((d) => {
        const fontId = d.titulo ? 2 : d.bold ? 1 : 0;
        const fillId = RELLENO_ID[d.relleno ?? "ninguno"];
        const numFmtId = NUMFMT_ID[d.fmt];
        const align = d.wrap || d.derecha ? `<alignment${d.wrap ? ` wrapText="1" vertical="top"` : ""}${d.derecha ? ` horizontal="right"` : ""}/>` : "";
        return `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"${align ? ` applyAlignment="1">${align}</xf>` : "/>"}`;
      })
      .join("");
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<numFmts count="4"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="0.0"/><numFmt numFmtId="167" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/></numFmts>` +
      `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>` +
      `<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
      `<fill><patternFill patternType="solid"><fgColor rgb="FFE7EEF7"/></patternFill></fill>` +
      `<fill><patternFill patternType="solid"><fgColor rgb="FFFFF4CC"/></patternFill></fill>` +
      `<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBFA"/></patternFill></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${this.lista.length}">${xfs}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Hoja
// ---------------------------------------------------------------------------------------------------------------------------

type TipoCifra = "moneda" | "pct" | "entero" | "dec1";

class Hoja {
  private readonly filas = new Map<number, Map<number, string>>();
  private readonly anchos: number[] = [];
  /** Fila siguiente libre (1-based). */
  r = 1;
  constructor(
    readonly nombre: string,
    private readonly est: Estilos,
  ) {}

  ancho(cols: readonly number[]): this {
    cols.forEach((w, i) => (this.anchos[i] = w));
    return this;
  }

  private poner(fila: number, col: number, xml: string): void {
    let f = this.filas.get(fila);
    if (!f) this.filas.set(fila, (f = new Map()));
    f.set(col, xml);
  }

  ref(fila: number, col: number): string {
    return `${nombreColumna(col)}${fila}`;
  }

  texto(fila: number, col: number, t: string, d: Omit<EstiloDef, "fmt"> = {}): void {
    this.poner(fila, col, `<c r="${this.ref(fila, col)}" t="inlineStr" s="${this.est.id({ fmt: "general", ...d })}"><is><t xml:space="preserve">${escXml(textoSeguro(t))}</t></is></c>`);
  }

  numero(fila: number, col: number, v: number, fmt: Formato, d: Omit<EstiloDef, "fmt"> = {}): void {
    this.poner(fila, col, `<c r="${this.ref(fila, col)}" s="${this.est.id({ fmt, ...d })}"><v>${Number.isFinite(v) ? String(v) : "0"}</v></c>`);
  }

  formula(fila: number, col: number, f: string, cache: number, fmt: Formato, d: Omit<EstiloDef, "fmt"> = {}): void {
    this.poner(fila, col, `<c r="${this.ref(fila, col)}" s="${this.est.id({ fmt, ...d })}"><f>${escXml(f)}</f><v>${Number.isFinite(cache) ? String(cache) : "0"}</v></c>`);
  }

  /** Una cifra con procedencia: `null` -> «—»; estimado/capturado con fondo suave. */
  cifra(fila: number, col: number, c: Cifra, tipo: TipoCifra, bold = false): void {
    if (c.valor === null || c.valor === undefined) {
      this.texto(fila, col, "—", { bold, derecha: true });
      return;
    }
    const relleno: Relleno = c.confianza === "estimado" ? "estimado" : c.confianza === "capturado" ? "capturado" : "ninguno";
    this.numero(fila, col, valorExcel(c.valor, tipo), formatoDe(tipo), { bold, relleno });
  }

  /** Un número crudo (o null -> «—»). */
  valor(fila: number, col: number, v: number | null, tipo: TipoCifra, bold = false): void {
    if (v === null || !Number.isFinite(v)) this.texto(fila, col, "—", { bold, derecha: true });
    else this.numero(fila, col, valorExcel(v, tipo), formatoDe(tipo), { bold });
  }

  encabezados(fila: number, titulos: readonly string[]): void {
    titulos.forEach((t, i) => this.texto(fila, i, t, { bold: true, relleno: "encabezado" }));
  }

  titulo(t: string): void {
    this.texto(this.r, 0, t, { titulo: true });
    this.r += 2;
  }

  subtitulo(t: string): void {
    this.texto(this.r, 0, t, { bold: true });
    this.r += 1;
  }

  subtituloEn(fila: number, t: string): void {
    this.texto(fila, 0, t, { bold: true });
  }

  /** Una línea de texto largo. */
  parrafo(t: string): void {
    this.texto(this.r, 0, t);
    this.r += 1;
  }

  par(k: string, v: string): void {
    this.texto(this.r, 0, k, { bold: true });
    this.texto(this.r, 1, v);
    this.r += 1;
  }

  xml(): string {
    const cols = this.anchos.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
    const filas = [...this.filas.keys()]
      .sort((a, b) => a - b)
      .map((n) => {
        const f = this.filas.get(n)!;
        return `<row r="${n}">${[...f.keys()].sort((a, b) => a - b).map((c) => f.get(c)).join("")}</row>`;
      })
      .join("");
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${filas}</sheetData></worksheet>`
    );
  }
}

function formatoDe(t: TipoCifra): Formato {
  return t;
}

/** Centavos -> pesos; % (30.5) -> fracción (0.305); entero y minutos tal cual. */
function valorExcel(v: number, tipo: TipoCifra): number {
  if (tipo === "moneda") return v / 100;
  if (tipo === "pct") return v / 100;
  return v;
}

function tipoKpi(t: KpiTarjeta["tipo"]): TipoCifra {
  return t === "centavos" ? "moneda" : t === "pct" ? "pct" : t === "minutos" ? "dec1" : "entero";
}

// ---------------------------------------------------------------------------------------------------------------------------
// Estado de resultados
// ---------------------------------------------------------------------------------------------------------------------------

const ORDEN_LINEAS: readonly LineaId[] = ["ventas_brutas", "descuentos_promocion", "compensaciones", "ventas_netas", "iva_estimado", "ventas_netas_sin_iva", "costo_ventas", "utilidad_bruta", "costo_agente", "comision_terminal", "nomina", "renta", "servicios", "otros", "ebitda"];

const ETIQUETA_LINEA: Readonly<Record<LineaId, string>> = {
  ventas_brutas: "Ventas brutas (lista)",
  descuentos_promocion: "Descuentos por promoción",
  compensaciones: "Compensaciones",
  ventas_netas: "Ventas netas con IVA",
  iva_estimado: "IVA estimado",
  ventas_netas_sin_iva: "Ventas netas sin IVA",
  costo_ventas: "Costo de ventas (food cost)",
  utilidad_bruta: "Utilidad bruta",
  costo_agente: "Costo del agente",
  comision_terminal: "Comisiones de terminal",
  nomina: "Nómina",
  renta: "Renta",
  servicios: "Servicios",
  otros: "Otros",
  ebitda: "EBITDA operativo",
};

/** Líneas que son resultado de una resta de otras (subtotales): `[destino, +minuendo, -sustraendos...]`. */
const RESTAS: ReadonlyArray<readonly [LineaId, LineaId, ...LineaId[]]> = [
  ["ventas_netas", "ventas_brutas", "descuentos_promocion", "compensaciones"],
  ["ventas_netas_sin_iva", "ventas_netas", "iva_estimado"],
  ["utilidad_bruta", "ventas_netas_sin_iva", "costo_ventas"],
  ["ebitda", "ventas_netas_sin_iva", "costo_ventas", "costo_agente", "comision_terminal", "nomina", "renta", "servicios", "otros"],
];

function lineaDe(col: ColumnaPyl, id: LineaId): Cifra {
  const l = col.lineas.find((x) => x.id === id);
  return l ? l.cifra : { valor: null, confianza: "sin_dato", fuente: "ausente" };
}

/**
 * Escribe las columnas del estado de resultados a partir de la columna `col0` de la hoja. `totalSumaDesde`/`totalSumaHasta` (índices de
 * columna) marcan el rango que suma la columna Total (o `null` si no hay Total en esta tabla). Devuelve el mapa línea -> fila.
 */
function escribirEstadoResultados(h: Hoja, columnas: readonly ColumnaPyl[], filaEncabezado: number, col0: number, etiquetaCol: (c: ColumnaPyl) => string): Map<LineaId, number> {
  const filaDe = new Map<LineaId, number>();
  h.texto(filaEncabezado, 0, "Concepto", { bold: true, relleno: "encabezado" });
  columnas.forEach((c, i) => h.texto(filaEncabezado, col0 + i, etiquetaCol(c), { bold: true, relleno: "encabezado", derecha: true }));
  ORDEN_LINEAS.forEach((id, i) => filaDe.set(id, filaEncabezado + 1 + i));
  const idxSumables = columnas.map((c, i) => (c.clave === "total" ? -1 : i)).filter((i) => i >= 0);
  const desde = idxSumables.length > 0 ? Math.min(...idxSumables) : -1;
  const hasta = idxSumables.length > 0 ? Math.max(...idxSumables) : -1;

  for (const id of ORDEN_LINEAS) {
    const fila = filaDe.get(id)!;
    const resalta = id === "ventas_netas" || id === "ventas_netas_sin_iva" || id === "utilidad_bruta" || id === "ebitda";
    h.texto(fila, 0, ETIQUETA_LINEA[id], { bold: resalta });
    columnas.forEach((col, i) => {
      const c = lineaDe(col, id);
      const celda = col0 + i;
      const val = c.valor;
      if (val === null) return h.cifra(fila, celda, c, "moneda", resalta);
      const relleno: Relleno = c.confianza === "estimado" ? "estimado" : c.confianza === "capturado" ? "capturado" : "ninguno";
      const est = { bold: resalta, relleno } as const;
      // (1) Columna Total: SUM de las columnas de sucursal y «No asignado» cuando reproduce la cifra de la vista.
      if (col.clave === "total" && desde >= 0) {
        const suma = columnas.reduce((a, cc, j) => (j >= desde && j <= hasta && cc.clave !== "total" ? a + (lineaDe(cc, id).valor ?? 0) : a), 0);
        if (suma === val) return h.formula(fila, celda, `SUM(${h.ref(fila, col0 + desde)}:${h.ref(fila, col0 + hasta)})`, val / 100, "moneda", est);
      }
      // (2) Subtotal: resta de las líneas de la misma columna cuando la resta reproduce la cifra (todas las piezas con dato).
      const resta = RESTAS.find((r) => r[0] === id);
      if (resta) {
        const [, mas, ...menos] = resta;
        const piezas = [mas, ...menos].map((p) => lineaDe(col, p).valor);
        const usadas = piezas.filter((p): p is number => p !== null);
        const calc = usadas.length === 0 ? null : (piezas[0] ?? 0) - menos.reduce((a, p) => a + (lineaDe(col, p).valor ?? 0), 0);
        // Compensaciones sin dato (SoftRestaurant las incluye en los descuentos) cuentan como vacías: la celda es texto «—» y Excel la ignora en la resta.
        if (piezas[0] !== null && calc === val) {
          const f = `${h.ref(filaDe.get(mas)!, celda)}${menos.map((p) => `-${h.ref(filaDe.get(p)!, celda)}`).join("")}`;
          return h.formula(fila, celda, f, val / 100, "moneda", est);
        }
      }
      h.cifra(fila, celda, c, "moneda", resalta);
    });
  }
  return filaDe;
}

function escribirRatiosYMemo(h: Hoja, fila0: number, col: ColumnaPyl): number {
  let r = fila0;
  h.subtituloEn(r, "Razones");
  r += 1;
  const ratios: Array<[string, Cifra]> = [
    ["Margen bruto %", col.ratios.margenBrutoPct],
    ["Food cost %", col.ratios.foodCostPct],
    ["Prime cost %", col.ratios.primeCostPct],
    ["Costo del agente %", col.ratios.costoAgentePct],
    ["Margen de contribución %", col.ratios.margenContribucionPct],
  ];
  for (const [k, c] of ratios) {
    h.texto(r, 0, k);
    h.cifra(r, 1, c, "pct");
    r += 1;
  }
  h.texto(r, 0, "Punto de equilibrio");
  h.cifra(r, 1, col.ratios.puntoEquilibrio, "moneda");
  r += 2;
  h.subtituloEn(r, "Memo");
  r += 1;
  const memo: Array<[string, Cifra]> = [
    ["Cortesías a precio de lista", col.memo.cortesias],
    ["Cancelaciones ($)", col.memo.cancelaciones],
    ["No recogidos ($)", col.memo.noRecogidos],
    ["Propinas con tarjeta (fuera de ingresos)", col.memo.propinasTarjeta],
  ];
  for (const [k, c] of memo) {
    h.texto(r, 0, k);
    h.cifra(r, 1, c, "moneda");
    r += 1;
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Variación de un KPI en texto (sin signos al inicio: nada que una hoja de cálculo pueda tomar por fórmula)
// ---------------------------------------------------------------------------------------------------------------------------

function textoVariacion(k: KpiTarjeta): string {
  const v = k.variacion.valor;
  if (v === null || v === undefined) return "—";
  const unidad = k.variacion.tipo === "pct" ? "%" : k.variacion.tipo === "pp" ? "pp" : "min";
  if (v === 0) return `igual (0 ${unidad})`;
  return `${v > 0 ? "sube" : "baja"} ${Math.abs(v)} ${unidad}`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Hojas
// ---------------------------------------------------------------------------------------------------------------------------

const LEYENDA_CONFIANZA = [
  "Sin fondo: cifra medida o importada de la base de datos.",
  "Fondo amarillo suave: cifra ESTIMADA (supuesto o prorrateo, p. ej. IVA estimado).",
  "Fondo azul suave: cifra CAPTURADA por el dueño (costos, nómina, renta...).",
  "«—»: sin dato. Nunca se rellena con 0.",
];

function fechaSerial(d: Date): number {
  return d.getTime() / 86_400_000 + 25_569;
}

function hojaPortada(est: Estilos, usados: Set<string>, v: VistasCfo, a: AlcanceExportacion, generadoEn: Date): Hoja {
  const h = new Hoja(nombreHojaSeguro("Portada", usados), est).ancho([34, 90]);
  const cab = cabeceraDe(v);
  h.titulo("Reporte del CFO");
  h.par("Organización", a.organizacion);
  h.par("Periodo", `${a.desde} a ${a.hasta}`);
  h.par("Alcance", a.alcance.etiqueta);
  h.par("Sucursales", cab && cab.sucursales.length > 0 ? cab.sucursales.map((s) => s.nombre + (s.activa === false ? " (inactiva)" : "")).join(", ") : "—");
  h.par("Contenido", a.vista === "completo" ? "Completo" : a.vista === "resumen" ? "Resumen" : a.vista === "estado-resultados" ? "Estado de resultados" : "Sucursales");
  h.texto(h.r, 0, "Generado (UTC)", { bold: true });
  h.numero(h.r, 1, fechaSerial(generadoEn), "fecha");
  h.r += 2;
  h.subtitulo("Aviso");
  h.parrafo("Este reporte organiza los datos operativos de su restaurante para que tome decisiones: no sustituye a su contabilidad ni a sus estados financieros dictaminados, ni da asesoría fiscal o financiera.");
  h.parrafo(cab?.avisoLegal ?? AVISO_CFO);
  h.r += 1;
  h.subtitulo("Leyenda de confianza");
  h.texto(h.r, 0, "Estimado", { relleno: "estimado" });
  h.texto(h.r, 1, LEYENDA_CONFIANZA[1]!);
  h.r += 1;
  h.texto(h.r, 0, "Capturado", { relleno: "capturado" });
  h.texto(h.r, 1, LEYENDA_CONFIANZA[2]!);
  h.r += 1;
  h.texto(h.r, 0, "Medido / importado");
  h.texto(h.r, 1, LEYENDA_CONFIANZA[0]!);
  h.r += 1;
  h.texto(h.r, 0, "Sin dato");
  h.texto(h.r, 1, LEYENDA_CONFIANZA[3]!);
  h.r += 2;
  if (cab) {
    const avisos = [...new Set([...cab.avisos, ...Object.values(v).flatMap((x) => (x && "avisos" in x ? (x as VistaCfoBase).avisos : []))])];
    if (avisos.length > 0) {
      h.subtitulo("Avisos de la base");
      for (const t of avisos) h.parrafo(t);
      h.r += 1;
    }
    if (cab.fuentes.length > 0) {
      h.subtitulo("Fuentes de datos");
      h.encabezados(h.r, ["Fuente", "Confianza · cobertura"]);
      h.r += 1;
      for (const f of cab.fuentes) {
        h.texto(h.r, 0, f.nombre);
        h.texto(h.r, 1, `${f.confianza} · ${f.cobertura.desde ?? "—"} a ${f.cobertura.hasta ?? "—"}${f.disponible ? "" : " · no disponible"}`);
        h.r += 1;
      }
    }
  }
  return h;
}

function hojaResumen(est: Estilos, usados: Set<string>, r: ResumenVista): Hoja {
  const h = new Hoja(nombreHojaSeguro("Resumen", usados), est);
  const suc = r.kpis.porSucursal;
  h.ancho([34, 18, 22, 24, 24, 24, 24, ...suc.map(() => 18)].slice(0, Math.max(8, 3 + suc.length)));
  h.titulo("Resumen");
  h.subtitulo("Resumen narrado");
  h.parrafo(r.narrativa.texto || "Sin datos suficientes para narrar el periodo.");
  h.r += 1;
  h.subtitulo("Indicadores");
  h.encabezados(h.r, ["Indicador", "Total", "Variación vs comparativo", ...suc.map((s) => s.nombre)]);
  h.r += 1;
  for (const k of r.kpis.total.kpis) {
    h.texto(h.r, 0, k.etiqueta);
    h.cifra(h.r, 1, k.valor, tipoKpi(k.tipo));
    h.texto(h.r, 2, textoVariacion(k));
    suc.forEach((s, i) => {
      const kp = s.kpis.find((x) => x.id === k.id);
      if (kp) h.cifra(h.r, 3 + i, kp.valor, tipoKpi(kp.tipo));
      else h.texto(h.r, 3 + i, "—", { derecha: true });
    });
    h.r += 1;
  }
  h.r += 1;
  h.subtitulo("Lo más importante");
  h.encabezados(h.r, ["Hallazgo", "Cifra", "Impacto estimado", "Sucursal", "Comparación", "Por qué importa", "Acción", "Urgencia"]);
  h.r += 1;
  if (r.hallazgos.length === 0) {
    h.parrafo("Sin hallazgos en el periodo.");
  }
  for (const x of r.hallazgos.slice(0, 10)) {
    h.texto(h.r, 0, x.titulo);
    h.texto(h.r, 1, x.cifraTexto);
    h.valor(h.r, 2, x.impactoCentavos, "moneda");
    h.texto(h.r, 3, x.sucursal ?? "Organización");
    h.texto(h.r, 4, x.comparacion);
    h.texto(h.r, 5, x.porQueImporta);
    h.texto(h.r, 6, x.accion.texto);
    h.texto(h.r, 7, x.urgencia);
    h.r += 1;
  }
  if (r.multiSucursal.texto) {
    h.r += 1;
    h.parrafo(r.multiSucursal.texto);
  }
  return h;
}

function hojaEstadoResultados(est: Estilos, usados: Set<string>, e: EstadoResultadosVista): Hoja {
  const h = new Hoja(nombreHojaSeguro("Estado de resultados", usados), est);
  const cols = e.estadoResultados.acumulado.columnas;
  h.ancho([38, ...cols.map(() => 20)]);
  h.titulo("Estado de resultados operativo");
  h.parrafo(`Periodo ${e.estadoResultados.rango.desde} a ${e.estadoResultados.rango.hasta} · montos en pesos MXN. El Total es la suma de las sucursales y «No asignado».`);
  h.r += 1;
  const fila = h.r;
  escribirEstadoResultados(h, cols, fila, 1, (c) => (c.clave === "total" ? "Total" : c.clave === "no_asignado" ? "No asignado" : c.nombre));
  h.r = fila + 1 + ORDEN_LINEAS.length + 1;
  const total = cols.find((c) => c.clave === "total");
  if (total) {
    if (total.incompleto.length > 0) {
      h.parrafo(`EBITDA incompleto: faltan ${total.incompleto.map((id) => ETIQUETA_LINEA[id].toLowerCase()).join(", ")}. Se muestra el margen de contribución.`);
    }
    for (const n of total.notas) h.parrafo(n);
    h.r += 1;
    h.r = escribirRatiosYMemo(h, h.r, total);
  }
  if (e.avisos.length > 0) {
    h.r += 1;
    for (const t of e.avisos) h.parrafo(t);
  }
  return h;
}

function hojaVentas(est: Estilos, usados: Set<string>, v: VentasVista): Hoja {
  const h = new Hoja(nombreHojaSeguro("Ventas por día", usados), est).ancho([18, 12, 18, 18, 18]);
  h.titulo("Ventas por día");
  h.encabezados(h.r, ["Periodo", "Pedidos", "Ventas brutas", "Ventas netas", "Ticket promedio"]);
  h.r += 1;
  for (const p of v.ventas.total.serie) {
    h.texto(h.r, 0, p.clave);
    h.numero(h.r, 1, p.pedidos, "entero");
    h.numero(h.r, 2, p.brutaCentavos / 100, "moneda");
    h.numero(h.r, 3, p.netaCentavos / 100, "moneda");
    h.valor(h.r, 4, p.ticketCentavos, "moneda");
    h.r += 1;
  }
  h.r += 1;
  h.subtitulo("Por canal");
  h.encabezados(h.r, ["Canal", "Origen", "Pedidos", "Ventas netas", "% de pedidos", "% de ventas"]);
  h.r += 1;
  for (const c of v.porCanal) {
    h.texto(h.r, 0, c.canal);
    h.texto(h.r, 1, c.source);
    h.numero(h.r, 2, c.pedidos, "entero");
    h.numero(h.r, 3, c.netaCentavos / 100, "moneda");
    h.valor(h.r, 4, c.mixPedidosPct, "pct");
    h.valor(h.r, 5, c.mixVentasPct, "pct");
    h.r += 1;
  }
  return h;
}

function hojaSucursales(est: Estilos, usados: Set<string>, s: SucursalesVista): Hoja {
  const h = new Hoja(nombreHojaSeguro("Sucursales", usados), est).ancho([28, 12, 18, 14, 16, 14, 14, 16, 16, 18]);
  h.titulo("Comparativo de sucursales");
  h.encabezados(h.r, ["Sucursal", "Pedidos", "Ventas netas", "Participación", "Ticket", "Descuento %", "Cancelación %", "Entrega prom. (min)", "Entrega p90 (min)", "Costo del agente por pedido"]);
  h.r += 1;
  for (const f of s.tabla) {
    h.texto(h.r, 0, f.nombre);
    h.numero(h.r, 1, f.pedidos, "entero");
    h.numero(h.r, 2, f.netaCentavos / 100, "moneda");
    h.cifra(h.r, 3, f.participacionPct, "pct");
    h.cifra(h.r, 4, f.ticket, "moneda");
    h.cifra(h.r, 5, f.descuentoPct, "pct");
    h.cifra(h.r, 6, f.cancelacionPct, "pct");
    h.cifra(h.r, 7, f.entregaPromedioMin, "dec1");
    h.cifra(h.r, 8, f.entregaP90Min, "dec1");
    h.cifra(h.r, 9, f.costoPorPedidoAgente, "moneda");
    h.r += 1;
  }
  const t = s.total;
  h.texto(h.r, 0, "Total", { bold: true });
  h.numero(h.r, 1, t.pedidos, "entero", { bold: true });
  h.numero(h.r, 2, t.netaCentavos / 100, "moneda", { bold: true });
  h.texto(h.r, 3, "—", { derecha: true });
  h.cifra(h.r, 4, t.ticket, "moneda", true);
  h.cifra(h.r, 5, t.descuentoPct, "pct", true);
  h.cifra(h.r, 6, t.cancelacionPct, "pct", true);
  h.r += 1;
  if (s.noAsignado) {
    h.texto(h.r, 0, "No asignado (costo del agente de la organización)");
    h.cifra(h.r, 9, s.noAsignado.costoAgenteCentavos, "moneda");
    h.r += 1;
  }
  if (s.outliers.length > 0) {
    h.r += 1;
    h.subtitulo("Sucursales fuera de patrón");
    h.encabezados(h.r, ["Sucursal", "Métrica", "Valor", "Mediana", "z", "Motivo"]);
    h.r += 1;
    for (const o of s.outliers) {
      h.texto(h.r, 0, o.nombre);
      h.texto(h.r, 1, o.metrica);
      h.numero(h.r, 2, o.valor, "dec1");
      h.numero(h.r, 3, o.mediana, "dec1");
      h.valor(h.r, 4, o.z, "dec1");
      h.texto(h.r, 5, o.motivo);
      h.r += 1;
    }
  }
  return h;
}

function hojaClientes(est: Estilos, usados: Set<string>, c: ClientesVista): Hoja {
  const h = new Hoja(nombreHojaSeguro("Clientes", usados), est).ancho([28, 14, 12, 12, 12, 12, 12, 14, 14, 16, 18]);
  h.titulo("Clientes");
  h.parrafo("Los clientes únicos NO se suman entre sucursales: el renglón «Conjunto» cuenta cada cliente una sola vez.");
  h.encabezados(h.r, ["Sucursal", "Con pedido", "Nuevos", "Recurrentes", "Activos", "Dormidos", "Perdidos", "Frecuentes", "% frecuentes", "Churn", "Concentración top 10 %"]);
  h.r += 1;
  const fila = (nombre: string, x: ClientesVista["porSucursal"][number] | NonNullable<ClientesVista["total"]>, negrita = false): void => {
    h.texto(h.r, 0, nombre, { bold: negrita });
    h.numero(h.r, 1, x.resumen.clientesConPedido, "entero", { bold: negrita });
    h.numero(h.r, 2, x.resumen.nuevos, "entero", { bold: negrita });
    h.numero(h.r, 3, x.resumen.recurrentes, "entero", { bold: negrita });
    h.numero(h.r, 4, x.segmentos.activos, "entero", { bold: negrita });
    h.numero(h.r, 5, x.segmentos.dormidos, "entero", { bold: negrita });
    h.numero(h.r, 6, x.segmentos.perdidos, "entero", { bold: negrita });
    h.numero(h.r, 7, x.segmentos.frecuentes, "entero", { bold: negrita });
    h.cifra(h.r, 8, x.segmentos.frecuentesPct, "pct", negrita);
    h.cifra(h.r, 9, x.churn, "pct", negrita);
    h.cifra(h.r, 10, x.concentracion, "pct", negrita);
    h.r += 1;
  };
  for (const s of c.porSucursal) fila(s.nombre, s);
  if (c.total) fila("Conjunto (clientes únicos)", c.total, true);
  else h.parrafo("Sin renglón del conjunto: la base no devolvió el total de clientes únicos.");
  if (c.multiSucursal.texto) h.parrafo(c.multiSucursal.texto);
  const defs = Object.entries(c.definiciones);
  if (defs.length > 0) {
    h.r += 1;
    h.subtitulo("Definiciones");
    for (const [k, t] of defs) h.par(k, t);
  }
  return h;
}

function hojaPlatillos(est: Estilos, usados: Set<string>, p: ProductosVista): Hoja {
  const h = new Hoja(nombreHojaSeguro("Platillos", usados), est).ancho([34, 22, 12, 18, 12, 14]);
  h.titulo("Platillos");
  const tabla = (titulo: string, filas: ProductosVista["ranking"]["masVendidos"]): void => {
    h.subtitulo(titulo);
    h.encabezados(h.r, ["Platillo", "Categoría", "Unidades", "Ingreso", "Pedidos", "% del ingreso"]);
    h.r += 1;
    for (const f of filas.slice(0, 50)) {
      h.texto(h.r, 0, f.nombre);
      h.texto(h.r, 1, f.categoria);
      h.numero(h.r, 2, f.unidades, "entero");
      h.numero(h.r, 3, f.ingresoCentavos / 100, "moneda");
      h.numero(h.r, 4, f.pedidos, "entero");
      h.valor(h.r, 5, f.participacionIngresoPct, "pct");
      h.r += 1;
    }
    h.r += 1;
  };
  tabla("Más vendidos", p.ranking.masVendidos);
  tabla("Menos vendidos", p.ranking.menosVendidos);
  h.subtitulo("Mix por categoría");
  h.encabezados(h.r, ["Categoría", "Unidades", "Ingreso", "% del ingreso"]);
  h.r += 1;
  for (const m of p.mixCategoria) {
    h.texto(h.r, 0, m.categoria);
    h.numero(h.r, 1, m.unidades, "entero");
    h.numero(h.r, 2, m.ingresoCentavos / 100, "moneda");
    h.valor(h.r, 3, m.participacionPct, "pct");
    h.r += 1;
  }
  h.r += 1;
  if (p.canasta.length > 0) {
    h.subtitulo("Canasta: pares más frecuentes");
    h.encabezados(h.r, ["Platillo A", "Platillo B", "Pedidos juntos", "Soporte", "Lift"]);
    h.r += 1;
    for (const c of p.canasta.slice(0, 30)) {
      h.texto(h.r, 0, c.nombreA);
      h.texto(h.r, 1, c.nombreB);
      h.numero(h.r, 2, c.pedidosJuntos, "entero");
      h.valor(h.r, 3, c.soportePct, "pct");
      h.valor(h.r, 4, c.lift, "dec1");
      h.r += 1;
    }
    h.r += 1;
  }
  if (p.agotados.length > 0) {
    h.subtitulo("Agotados");
    h.encabezados(h.r, ["Platillo", "Agotado hasta", "Unidades (28 días)", "Venta en riesgo por día"]);
    h.r += 1;
    for (const a of p.agotados) {
      h.texto(h.r, 0, a.nombre);
      h.texto(h.r, 1, a.agotadoHasta ?? "Indefinido");
      h.numero(h.r, 2, a.unidades28d, "entero");
      h.cifra(h.r, 3, a.ventaEnRiesgoPorDia, "moneda");
      h.r += 1;
    }
  }
  return h;
}

function hojaOperacion(est: Estilos, usados: Set<string>, o: OperacionVista): Hoja {
  const h = new Hoja(nombreHojaSeguro("Operación", usados), est).ancho([30, 14, 16, 16, 16, 16]);
  h.titulo("Operación y agente");
  h.subtitulo("Tiempos de entrega");
  h.encabezados(h.r, ["Sucursal", "Entregados", "Promedio (min)", "Mediana (min)", "p90 (min)", "% tarde"]);
  h.r += 1;
  for (const e of o.entregas) {
    h.texto(h.r, 0, e.conjunto ? `${e.nombre} (conjunto)` : e.nombre);
    h.numero(h.r, 1, e.entregados, "entero");
    h.cifra(h.r, 2, e.promedioMin, "dec1");
    h.cifra(h.r, 3, e.p50Min, "dec1");
    h.cifra(h.r, 4, e.p90Min, "dec1");
    h.cifra(h.r, 5, e.tardePct, "pct");
    h.r += 1;
  }
  h.r += 1;
  h.subtitulo("Costo del agente");
  h.encabezados(h.r, ["Sucursal", "Total", "Voz", "Telefonía", "Meta", "Por pedido"]);
  h.r += 1;
  const costo = (nombre: string, c: OperacionVista["costoAgente"]["total"], negrita = false): void => {
    h.texto(h.r, 0, nombre, { bold: negrita });
    h.cifra(h.r, 1, c.total, "moneda", negrita);
    h.cifra(h.r, 2, c.voz, "moneda", negrita);
    h.cifra(h.r, 3, c.telefonia, "moneda", negrita);
    h.cifra(h.r, 4, c.meta, "moneda", negrita);
    h.cifra(h.r, 5, c.porPedido, "moneda", negrita);
    h.r += 1;
  };
  for (const s of o.costoAgente.porSucursal) costo(s.nombre, s);
  costo("Total", o.costoAgente.total, true);
  h.r += 1;
  h.subtitulo("Embudo del agente (total)");
  const emb = o.embudo.total;
  h.encabezados(h.r, ["Canal", "Conversaciones / llamadas", "Con pedido", "Escaladas", "Tasa de cierre"]);
  h.r += 1;
  h.texto(h.r, 0, "WhatsApp");
  h.numero(h.r, 1, emb.whatsapp.conversaciones, "entero");
  h.numero(h.r, 2, emb.whatsapp.conPedido, "entero");
  h.numero(h.r, 3, emb.whatsapp.conHandoff, "entero");
  h.cifra(h.r, 4, emb.whatsapp.tasaCierre, "pct");
  h.r += 1;
  h.texto(h.r, 0, "Voz");
  h.numero(h.r, 1, emb.voz.llamadas, "entero");
  h.numero(h.r, 2, emb.voz.pedidoCreado, "entero");
  h.numero(h.r, 3, emb.voz.escalado, "entero");
  h.cifra(h.r, 4, emb.voz.tasaCierre, "pct");
  h.r += 2;
  h.subtitulo("Comandas enviadas a SoftRestaurant");
  h.par("Modo", o.comandas.modo);
  h.texto(h.r, 0, "Tasa de captura", { bold: true });
  h.cifra(h.r, 1, o.comandas.tasaCaptura, "pct");
  h.r += 1;
  h.texto(h.r, 0, "Minutos hasta captura", { bold: true });
  h.cifra(h.r, 1, o.comandas.minutosACaptura, "dec1");
  h.r += 1;
  return h;
}

function hojaSoftRestaurant(est: Estilos, usados: Set<string>, c: CuadreSrVista): Hoja {
  const h = new Hoja(nombreHojaSeguro("SoftRestaurant", usados), est).ancho([28, 14, 20, 14, 20, 14, 18, 14, 12]);
  h.titulo("SoftRestaurant: cuadre diario de domicilio");
  if (c.filas.length === 0) {
    h.parrafo("Sin datos de mostrador de SoftRestaurant: sube el reporte de ventas por tipo de servicio o el listado de cuentas.");
    return h;
  }
  h.encabezados(h.r, ["Sucursal", "Día", "Domicilio nuestro", "Pedidos nuestros", "Domicilio SR", "Tickets SR", "Diferencia", "Diferencia %", "Semáforo"]);
  h.r += 1;
  for (const f of c.filas.slice(0, 5000)) {
    h.texto(h.r, 0, f.nombre);
    h.texto(h.r, 1, f.diaNegocio);
    h.numero(h.r, 2, f.nuestroDomicilioCentavos / 100, "moneda");
    h.numero(h.r, 3, f.nuestroPedidos, "entero");
    h.valor(h.r, 4, f.srDomicilioCentavos, "moneda");
    h.valor(h.r, 5, f.srTickets, "entero");
    h.valor(h.r, 6, f.diferenciaCentavos, "moneda");
    h.valor(h.r, 7, f.diferenciaPct, "pct");
    h.texto(h.r, 8, f.semaforo);
    h.r += 1;
  }
  return h;
}

function hojaSucursal(est: Estilos, usados: Set<string>, nombre: string, propertyId: string, v: VistasCfo): Hoja {
  const h = new Hoja(nombreHojaSeguro(`Suc ${nombre}`, usados), est).ancho([38, 22, 22]);
  h.titulo(`Sucursal: ${nombre}`);
  const kpis = v.resumen?.kpis.porSucursal.find((s) => s.propertyId === propertyId);
  if (kpis) {
    h.subtitulo("Indicadores");
    h.encabezados(h.r, ["Indicador", "Valor", "Variación vs comparativo"]);
    h.r += 1;
    for (const k of kpis.kpis) {
      h.texto(h.r, 0, k.etiqueta);
      h.cifra(h.r, 1, k.valor, tipoKpi(k.tipo));
      h.texto(h.r, 2, textoVariacion(k));
      h.r += 1;
    }
    h.r += 1;
  }
  const col = v.estadoResultados?.estadoResultados.acumulado.columnas.find((c) => c.clave === "sucursal" && c.propertyId === propertyId);
  if (col) {
    h.subtitulo("Estado de resultados");
    const fila = h.r;
    escribirEstadoResultados(h, [col], fila, 1, () => "Periodo");
    h.r = fila + 1 + ORDEN_LINEAS.length + 1;
    if (col.incompleto.length > 0) h.parrafo(`EBITDA incompleto: faltan ${col.incompleto.map((id) => ETIQUETA_LINEA[id].toLowerCase()).join(", ")}.`);
    h.r += 1;
    h.r = escribirRatiosYMemo(h, h.r, col);
  }
  return h;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Libro
// ---------------------------------------------------------------------------------------------------------------------------

/** Construye el .xlsx del CFO. Determinista: mismos datos y mismo `generadoEn` producen los mismos bytes. */
export function construirLibroCfo(vistas: VistasCfo, alcance: AlcanceExportacion, generadoEn: Date): Uint8Array {
  const est = new Estilos();
  const usados = new Set<string>();
  const hojas: Hoja[] = [hojaPortada(est, usados, vistas, alcance, generadoEn)];
  // El resumen se carga también para los KPIs de cada sucursal, pero su hoja solo va en las vistas «completo» y «resumen».
  if (vistas.resumen && (alcance.vista === "completo" || alcance.vista === "resumen")) hojas.push(hojaResumen(est, usados, vistas.resumen));
  if (vistas.estadoResultados) hojas.push(hojaEstadoResultados(est, usados, vistas.estadoResultados));
  if (vistas.ventas) hojas.push(hojaVentas(est, usados, vistas.ventas));
  if (vistas.sucursales) hojas.push(hojaSucursales(est, usados, vistas.sucursales));
  if (vistas.clientes) hojas.push(hojaClientes(est, usados, vistas.clientes));
  if (vistas.productos) hojas.push(hojaPlatillos(est, usados, vistas.productos));
  if (vistas.operacion) hojas.push(hojaOperacion(est, usados, vistas.operacion));
  if (vistas.cuadreSr) hojas.push(hojaSoftRestaurant(est, usados, vistas.cuadreSr));
  // Una hoja por sucursal (la del alcance): estado de resultados + KPIs propios.
  const cab = cabeceraDe(vistas);
  if (cab && alcance.vista !== "resumen" && (vistas.estadoResultados || vistas.resumen)) {
    for (const s of cab.sucursales) hojas.push(hojaSucursal(est, usados, s.nombre, s.propertyId, vistas));
  }

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

  // Las hojas se serializan ANTES de los estilos: `xml()` de cada hoja ya registró todos sus estilos al escribirse, pero se serializa aquí por claridad.
  const hojasXml = hojas.map((h) => h.xml());
  return crearZipStored([
    { nombre: "[Content_Types].xml", datos: ENC.encode(contentTypes) },
    { nombre: "_rels/.rels", datos: ENC.encode(rels) },
    { nombre: "xl/workbook.xml", datos: ENC.encode(workbook) },
    { nombre: "xl/_rels/workbook.xml.rels", datos: ENC.encode(workbookRels) },
    { nombre: "xl/styles.xml", datos: ENC.encode(est.xml()) },
    ...hojasXml.map((x, i) => ({ nombre: `xl/worksheets/sheet${i + 1}.xml`, datos: ENC.encode(x) })),
  ]);
}
