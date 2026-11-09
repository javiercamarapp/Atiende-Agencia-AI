// Exportaciones del CFO de la plataforma: libro de Excel (economia por cliente, comparativos, serie de MRR, cohortes y supuestos) y
// resumen mensual estilo inversionista en PDF (KPIs, serie de MRR, puente, margen por vertical, alertas y supuestos).
//
// Reglas: las cifras son las del cockpit (mismo armado que la pantalla); una cifra sin dato va VACIA en Excel y «—» en el PDF, nunca 0.
// El PDF de inversionistas NO lleva nombres de clientes (solo agregados y concentracion %). Excel reusa `reporteAXlsx` de
// @atiende/domain-despachos (texto como inlineStr: nunca se interpreta como formula). PDF con pdf-lib y Helvetica (WinAnsi: un caracter
// fuera del juego se sustituye por «?»). Determinista: `generadoEn` es un parametro.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont, PDFPage } from "pdf-lib";
import { reporteAXlsx } from "@atiende/domain-despachos";
import type { ColumnaReporte, ReporteTabular, SeccionReporte } from "@atiende/domain-despachos";
import type { cockpit } from "@atiende/billing";
import type { Cockpit } from "./cockpit.ts";

const ETIQUETA_BANDERA: Readonly<Record<cockpit.BanderaCliente, string>> = {
  no_rentable: "No rentable",
  margen_bajo: "Margen bajo",
  sobre_el_tope: "Sobre lo incluido",
  cerca_del_tope: "Cerca del tope",
  anomalia_uso: "Uso anómalo",
  pico_costo: "Pico de costo",
  pago_fallido: "Pago fallido",
};

const col = (clave: string, titulo: string, tipo: ColumnaReporte["tipo"] = "texto"): ColumnaReporte => ({ clave, titulo, tipo });
const dec1 = (v: number | null) => (v === null ? null : v.toLocaleString("es-MX", { maximumFractionDigits: 1 }));

export function libroCockpit(c: Cockpit, generadoEn: Date): Uint8Array {
  const secciones: SeccionReporte[] = [];
  secciones.push({
    titulo: "Economía por cliente",
    columnas: [
      col("cliente", "Cliente"), col("vertical", "Vertical"), col("plan", "Plan"), col("sucursales", "Sucursales", "entero"), col("mrr", "MRR", "moneda"),
      col("ingreso", "Ingreso del mes", "moneda"), col("llamadas", "Llamadas", "entero"), col("minutos", "Minutos de voz", "entero"), col("duracion", "Min por llamada"),
      col("conv", "Conversaciones WA", "entero"), col("pedidos", "Pedidos", "entero"), col("costo", "Costo directo", "moneda"), col("infra", "Infra prorrateada", "moneda"),
      col("contrib", "Contribución", "moneda"), col("contribPct", "Contribución %", "porcentaje"), col("bruto", "Margen bruto", "moneda"), col("brutoPct", "Margen bruto %", "porcentaje"),
      col("proy", "Margen proyectado", "moneda"), col("proyPct", "Margen proyectado %", "porcentaje"), col("poolVoz", "Pool voz %", "porcentaje"), col("poolWa", "Pool WA %", "porcentaje"),
      col("estado", "Estado"), col("avisos", "Avisos"),
    ],
    filas: c.economia.map((f) => ({
      cliente: f.nombre, vertical: f.vertical, plan: f.planNombre, sucursales: f.sucursales, mrr: f.mrrMxn, ingreso: f.ingresoMxn,
      llamadas: f.uso.llamadas, minutos: f.uso.minutosVoz === null ? null : Math.round(f.uso.minutosVoz), duracion: dec1(f.uso.duracionPromedioMin),
      conv: f.uso.conversacionesWa, pedidos: f.uso.pedidos, costo: f.costoDirectoMxn, infra: f.infraMxn, contrib: f.contribucionMxn, contribPct: f.contribucionPct,
      bruto: f.margenBrutoMxn, brutoPct: f.margenBrutoPct, proy: f.proyeccion.margenMxn, proyPct: f.proyeccion.margenPct, poolVoz: f.poolVoz?.pct ?? null, poolWa: f.poolWa?.pct ?? null,
      estado: f.banderas.map((b) => ETIQUETA_BANDERA[b]).join(", ") || null, avisos: f.avisos.join(" ") || null,
    })),
    totales: null,
    sinDatosMotivo: c.economia.length === 0 ? "No hay organizaciones (las demo no cuentan)." : null,
  });
  const agregado = (titulo: string, filas: Cockpit["agregados"]["porVertical"]): SeccionReporte => ({
    titulo,
    columnas: [col("clave", "Grupo"), col("clientes", "Clientes", "entero"), col("ingreso", "Ingreso", "moneda"), col("costo", "Costo directo", "moneda"), col("contribPct", "Contribución %", "porcentaje"), col("brutoPct", "Margen bruto %", "porcentaje"), col("llamadas", "Llamadas", "entero"), col("duracion", "Min por llamada"), col("conv", "Conversaciones WA", "entero"), col("pedidos", "Pedidos", "entero")],
    filas: filas.map((a) => ({ clave: a.clave, clientes: a.clientes, ingreso: a.ingresoMxn, costo: a.costoDirectoMxn, contribPct: a.contribucionPct, brutoPct: a.margenBrutoPct, llamadas: a.llamadas, duracion: dec1(a.duracionPromedioMin), conv: a.conversacionesWa, pedidos: a.pedidos })),
    totales: null,
    sinDatosMotivo: filas.length === 0 ? "Sin datos." : null,
  });
  secciones.push(agregado("Por vertical", c.agregados.porVertical), agregado("Por plan", c.agregados.porPlan));
  secciones.push({
    titulo: "MRR mensual",
    columnas: [col("mes", "Mes"), col("mrr", "MRR", "moneda"), col("clientes", "Clientes", "entero"), col("arpa", "ARPA", "moneda"), col("nuevo", "Nuevo", "moneda"), col("exp", "Expansión", "moneda"), col("con", "Contracción", "moneda"), col("churn", "Churn", "moneda"), col("nrr", "NRR %", "porcentaje"), col("grr", "GRR %", "porcentaje"), col("logos", "Churn de logos %", "porcentaje")],
    filas: c.saas.serie.map((p) => ({ mes: p.mes, mrr: p.mrrMxn, clientes: p.clientes, arpa: p.arpaMxn, nuevo: p.nuevoMxn, exp: p.expansionMxn, con: p.contraccionMxn, churn: p.churnMxn, nrr: p.nrrPct, grr: p.grrPct, logos: p.churnLogosPct })),
    totales: null,
    sinDatosMotivo: null,
  });
  const maxMeses = Math.max(0, ...c.saas.cohortes.map((x) => x.meses.length));
  secciones.push({
    titulo: "Cohortes",
    columnas: [col("cohorte", "Cohorte"), col("clientes", "Clientes", "entero"), ...Array.from({ length: maxMeses }, (_, i) => col(`m${i}`, `M${i} logos / MRR %`))],
    filas: c.saas.cohortes.map((co) => ({ cohorte: co.cohorte, clientes: co.clientesIniciales, ...Object.fromEntries(co.meses.map((m, i) => [`m${i}`, `${dec1(m.logosPct)} / ${m.mrrPct === null ? "—" : dec1(m.mrrPct)}`])) })),
    totales: null,
    sinDatosMotivo: c.saas.cohortes.length === 0 ? "Aún no hay fotos mensuales de MRR." : null,
  });
  const s = c.supuestos;
  const sup = (nombre: string, v: { valor: number; fuente: string; origen: string } | null, unidad: string) => ({ supuesto: nombre, valor: v === null ? "sin dato" : `${v.valor} ${unidad}`, origen: v?.origen ?? null, fuente: v?.fuente ?? null });
  secciones.push({
    titulo: "Supuestos",
    columnas: [col("supuesto", "Supuesto"), col("valor", "Valor"), col("origen", "Origen"), col("fuente", "Fuente")],
    filas: [
      ...Object.entries(s.vozUsdMinuto).map(([p, v]) => sup(`Voz (${p})`, v, "USD/min")),
      ...Object.entries(s.telefoniaUsdMinuto).map(([p, v]) => sup(`Telefonía (${p})`, v, "USD/min")),
      sup("LLM por conversación de WhatsApp", s.llmUsdConversacionWa, "USD"),
      sup("Meta por conversación de WhatsApp", s.whatsappUsdConversacion, "USD"),
      sup("Umbral de margen", s.umbralMargenPct, "%"),
      sup("Aviso de pool", s.umbralPoolPct, "%"),
      sup("Pico de costo", s.umbralPicoCostoPct, "%"),
      sup("Movimiento del dólar", s.umbralFxPct, "%"),
      sup("Tope de vida del LTV", s.ltvMesesTope, "meses"),
      { supuesto: "Tipo de cambio", valor: c.tipoCambio ? `${c.tipoCambio.mxnPorUsd} MXN/USD` : "sin dato", origen: c.tipoCambio?.fecha ?? null, fuente: c.tipoCambio?.fuente ?? null },
    ],
    totales: null,
    sinDatosMotivo: null,
  });
  const reporte: ReporteTabular = {
    tipo: "cfo_plataforma",
    titulo: `CFO de la plataforma — ${c.mes}`,
    periodo: c.mes,
    generadoEn: generadoEn.toISOString().slice(0, 10),
    contribuyente: { nombre: "Plataforma Atiende", rfc: null },
    secciones,
    notas: [
      "Ingreso = MRR del plan asignado más el excedente estimado del plan medido; no es lo cobrado por Stripe.",
      "Costo por categoría: medido si hay eventos del mes; si no, modelado con el costo unitario de la hoja Supuestos. Una celda vacía es «sin dato», nunca cero.",
      ...(c.enCurso ? [`Mes en curso: ${c.diasTranscurridos} de ${c.diasDelMes} días; la proyección extrapola el uso.`] : []),
      ...c.faltantes,
    ],
    sinDatos: c.economia.length === 0,
  };
  return reporteAXlsx(reporte);
}

// ───────────────────────────── PDF de inversionistas ─────────────────────────────

const W = 595.28;
const H = 841.89;
const M = 44;
const TEXTO = rgb(0.1, 0.11, 0.14);
const TENUE = rgb(0.4, 0.43, 0.48);
const AZUL = rgb(0.145, 0.388, 0.922);
const CIELO = rgb(0.22, 0.65, 0.91);
const LINEA = rgb(0.84, 0.86, 0.9);
const FONDO = rgb(0.95, 0.97, 1);
export const PDF_CONTENT_TYPE = "application/pdf";

const SIN = "—";
const pesos = (v: number | null | undefined) => (v === null || v === undefined ? SIN : `$${Math.round(v).toLocaleString("en-US")}`);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? SIN : `${v.toFixed(1)} %`);
const num1 = (v: number | null | undefined) => (v === null || v === undefined ? SIN : v.toFixed(1));

class Hoja {
  page: PDFPage;
  y: number;
  private readonly permitidos: Set<number>;
  constructor(
    private readonly doc: PDFDocument,
    readonly reg: PDFFont,
    readonly neg: PDFFont,
  ) {
    this.permitidos = new Set(reg.getCharacterSet());
    this.page = doc.addPage([W, H]);
    this.y = H - M;
  }
  limpiar(t: string): string {
    let out = "";
    for (const ch of t.replace(/[\r\n\t]+/gu, " ")) out += this.permitidos.has(ch.codePointAt(0)!) ? ch : "?";
    return out;
  }
  espacio(alto: number): void {
    if (this.y - alto < M) {
      this.page = this.doc.addPage([W, H]);
      this.y = H - M;
    }
  }
  texto(t: string, x: number, size: number, font = this.reg, color = TEXTO): void {
    this.page.drawText(this.limpiar(t), { x, y: this.y, size, font, color });
  }
  /** Parrafo con salto de linea por ancho. */
  parrafo(t: string, size = 9, color = TENUE): void {
    const palabras = this.limpiar(t).split(" ");
    let linea = "";
    for (const p of palabras) {
      const prueba = linea ? `${linea} ${p}` : p;
      if (this.reg.widthOfTextAtSize(prueba, size) > W - 2 * M && linea) {
        this.espacio(size + 4);
        this.texto(linea, M, size, this.reg, color);
        this.y -= size + 4;
        linea = p;
      } else linea = prueba;
    }
    if (linea) {
      this.espacio(size + 4);
      this.texto(linea, M, size, this.reg, color);
      this.y -= size + 4;
    }
  }
  titulo(t: string): void {
    this.espacio(30);
    this.y -= 8;
    this.texto(t, M, 12, this.neg, AZUL);
    this.y -= 6;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: W - M, y: this.y }, thickness: 0.6, color: LINEA });
    this.y -= 14;
  }
  tabla(encabezados: readonly string[], filas: readonly (readonly string[])[], anchos: readonly number[]): void {
    const fila = (celdas: readonly string[], font: PDFFont, fondo: boolean) => {
      this.espacio(16);
      if (fondo) this.page.drawRectangle({ x: M, y: this.y - 4, width: W - 2 * M, height: 15, color: FONDO });
      let x = M + 4;
      celdas.forEach((c, i) => {
        const ancho = anchos[i] ?? 60;
        let t = this.limpiar(c);
        while (t.length > 1 && font.widthOfTextAtSize(t, 8.5) > ancho - 6) t = t.slice(0, -1);
        const derecha = i > 0;
        this.page.drawText(t, { x: derecha ? x + ancho - 6 - font.widthOfTextAtSize(t, 8.5) : x, y: this.y, size: 8.5, font, color: TEXTO });
        x += ancho;
      });
      this.y -= 15;
    };
    fila(encabezados, this.neg, true);
    for (const f of filas) fila(f, this.reg, false);
    this.y -= 4;
  }
  /** Barras horizontales (azul -> cielo) para una serie corta. */
  barras(serie: readonly { etiqueta: string; valor: number | null }[], formato: (v: number) => string): void {
    const max = Math.max(1, ...serie.map((s) => Math.abs(s.valor ?? 0)));
    const ancho = W - 2 * M - 150;
    serie.forEach((s, i) => {
      this.espacio(14);
      this.texto(s.etiqueta, M, 8.5, this.reg, TENUE);
      if (s.valor !== null) {
        const w = Math.max(1, (Math.abs(s.valor) / max) * ancho);
        this.page.drawRectangle({ x: M + 70, y: this.y - 2, width: w, height: 9, color: i === serie.length - 1 ? AZUL : CIELO });
        this.texto(formato(s.valor), M + 76 + w, 8.5);
      } else this.texto(SIN, M + 76, 8.5, this.reg, TENUE);
      this.y -= 14;
    });
  }
}

export async function informeInversionistas(c: Cockpit, generadoEn: Date): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Resumen mensual ${c.mes}`);
  doc.setCreationDate(generadoEn);
  doc.setModificationDate(generadoEn);
  doc.setProducer("Atiende");
  doc.setCreator("Atiende");
  const h = new Hoja(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  const s = c.saas;
  const u = s.serie.at(-1);

  h.texto("Resumen mensual para inversionistas", M, 18, h.neg, AZUL);
  h.y -= 20;
  h.texto(`${c.mes}${c.enCurso ? ` (mes en curso: ${c.diasTranscurridos} de ${c.diasDelMes} días; cifras de uso proyectadas)` : ""} · generado ${generadoEn.toISOString().slice(0, 16).replace("T", " ")} UTC`, M, 9, h.reg, TENUE);
  h.y -= 18;

  h.titulo("Indicadores");
  const kpis: Array<[string, string]> = [
    ["MRR", pesos(s.mrrMxn)],
    ["ARR", pesos(s.arrMxn)],
    ["Clientes que aportan", String(s.clientes)],
    ["ARPA", pesos(s.arpaMxn)],
    ["NRR / GRR", `${pct(u?.nrrPct)} / ${pct(u?.grrPct)}`],
    ["Churn de logos", pct(u?.churnLogosPct)],
    ["Margen bruto / contribución", `${pct(s.margen.margenBrutoPct)} / ${pct(s.margen.contribucionPct)}`],
    ["LTV", s.ltv.disponible ? `${pesos(s.ltv.ltvMxn)} (${num1(s.ltv.vidaMeses)} meses${s.ltv.vidaTopada ? ", tope" : ""})` : SIN],
    ["CAC / payback", s.cac.disponible ? `${pesos(s.cac.cacMxn)} / ${num1(s.cac.paybackMeses)} meses` : SIN],
    ["Resultado del mes / runway", s.burn.disponible ? `${pesos(s.burn.resultadoMxn)} / ${s.burn.runwayMeses === null ? SIN : `${num1(s.burn.runwayMeses)} meses`}` : SIN],
    ["Cliente más grande / top 5", `${pct(s.concentracion.top1Pct)} / ${pct(s.concentracion.top5Pct)}`],
    ["Costo en USD / ingreso", s.fx.disponible ? `${pct(s.fx.exposicionPct)} a ${s.fx.mxnPorUsd} MXN/USD` : SIN],
  ];
  for (let i = 0; i < kpis.length; i += 2) {
    h.espacio(30);
    for (const [j, k] of [kpis[i], kpis[i + 1]].entries()) {
      if (!k) continue;
      const x = M + j * ((W - 2 * M) / 2);
      h.page.drawText(h.limpiar(k[0]), { x, y: h.y, size: 8, font: h.reg, color: TENUE });
      h.page.drawText(h.limpiar(k[1]), { x, y: h.y - 13, size: 12, font: h.neg, color: TEXTO });
    }
    h.y -= 32;
  }

  h.titulo("MRR por mes");
  h.barras(s.serie.map((p) => ({ etiqueta: p.mes, valor: p.mrrMxn })), (v) => pesos(v));

  h.titulo("Puente de MRR");
  h.tabla(["Mes", "Nuevo", "Expansión", "Contracción", "Churn", "NRR"], s.serie.filter((p) => p.nuevoMxn !== null).map((p) => [p.mes, pesos(p.nuevoMxn), pesos(p.expansionMxn), pesos(p.contraccionMxn), pesos(p.churnMxn), pct(p.nrrPct)]), [80, 80, 80, 90, 80, 97]);

  h.titulo("Margen por vertical");
  h.tabla(["Vertical", "Clientes", "Ingreso", "Costo directo", "Margen", "Min/llamada"], c.agregados.porVertical.map((a) => [a.clave, String(a.clientes), pesos(a.ingresoMxn), pesos(a.costoDirectoMxn), pct(a.margenBrutoPct ?? a.contribucionPct), num1(a.duracionPromedioMin)]), [100, 60, 90, 90, 80, 87]);

  const alertas = [...c.alertas.cfo, ...c.alertas.cockpit];
  if (alertas.length > 0) {
    h.titulo("Riesgos del mes");
    for (const a of alertas) h.parrafo(`• ${a.titulo}${a.organizaciones.length > 0 ? `: ${a.organizaciones.length} clientes` : ""}`, 9, TEXTO);
  }

  h.titulo("Supuestos y alcance");
  h.parrafo("Ingreso = MRR del plan asignado más el excedente estimado de los planes medidos; no es lo cobrado. Costo = medido cuando hay eventos del proveedor; si no, modelado con el costo unitario medido o capturado. Las cifras sin fuente se muestran como «—».");
  if (c.tipoCambio) h.parrafo(`Tipo de cambio: ${c.tipoCambio.mxnPorUsd} MXN/USD${c.tipoCambio.fecha ? ` del ${c.tipoCambio.fecha}` : ""}${c.tipoCambio.fuente ? ` (${c.tipoCambio.fuente})` : ""}.`);
  if (s.ltv.disponible) h.parrafo(`LTV = ARPA × margen ${pct(s.ltv.margenBrutoPct)} × ${num1(s.ltv.vidaMeses)} meses de vida${s.ltv.vidaTopada ? " (tope: aún no hay churn medido)" : ` (churn mensual ${pct(s.ltv.churnMensualPct)})`}.`);
  for (const f of c.faltantes) h.parrafo(`Pendiente: ${f}`);
  h.parrafo("Documento interno generado por la plataforma a partir de sus datos operativos; no es un estado financiero auditado.");
  return doc.save({ useObjectStreams: false });
}
