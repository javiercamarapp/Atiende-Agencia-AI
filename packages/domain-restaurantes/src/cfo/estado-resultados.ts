// CFO-04 · estado de resultados operativo (diseño §4.3 y regla SR §3.8).
//
// Por sucursal, «No asignado» y Total, para cada periodo (día / semana / mes) y para el rango completo.
//
// REGLAS:
//  - Líneas faltantes = «captura pendiente» (`faltaCaptura: true`, valor null). NUNCA 0.
//  - EBITDA solo si NINGUNA línea requerida falta; si falta alguna: `incompleto: ["nomina", ...]` y se muestra el margen de contribución (parcial).
//  - Food cost: monto capturado de `insumos` del mes; si no, `food_cost_objetivo_pct` × neta sin IVA (estimado); si no, pendiente.
//  - Comisión de terminal: monto capturado; si no, `config.comisionTerminalPct` × ventas con tarjeta (estimado); si no, pendiente.
//  - Costos mensuales en un periodo que NO cubre el mes completo: prorrateo proporcional a los días del mes, rotulado «estimado (prorrateo)».
//  - REGLA SR: si SoftRestaurant cubre el periodo en TODAS las sucursales del alcance, el titular es «Ventas del negocio (SoftRestaurant)» =
//    Σ SR, con desglose domicilio / presencial. Si no, el titular es «Ventas por el agente». NUNCA se suma agente + SR: el agente va como
//    memo («del cual el agente tomó $X»), porque el domicilio y el recoger del agente ya están dentro de SR.
//  - El costo de IA de texto es de la ORGANIZACIÓN: solo aparece en el renglón «No asignado». Un admin acotado no recibe ese renglón.
//  - Costo de Meta por mensaje: «no medido» (nunca $0) mientras no haya eventos.
import {
  comisionTerminal as formulaComision,
  costoAgente as formulaCostoAgente,
  ivaEstimado,
  margenContribucion,
  pctSobreVentas,
  puntoEquilibrio,
  sumaAnulable,
  sumarAgente,
  sumarVentas,
  type CostoAgente,
  type MargenContribucion,
  type SumasAgente,
  type SumasVentas,
} from "./formulas.ts";
import type {
  AlcanceSucursales,
  CfoConfig,
  Cifra,
  ConceptoCosto,
  FilaAgenteDiario,
  FilaCortesias,
  FilaCostoCaptura,
  FilaSrResumen,
  FilaVentasDiarias,
  SucursalCfo,
  TipoServicioSr,
} from "./tipos.ts";
import { cifra, combinarConfianza, diasDelMes, expandirDias, lunesDe, mesDe, mulDiv, redondear, sinDato, suma, sumarDiasFecha } from "./util.ts";

export type Granularidad = "dia" | "semana" | "mes";

export type LineaId =
  | "ventas_brutas"
  | "descuentos_promocion"
  | "compensaciones"
  | "ventas_netas"
  | "iva_estimado"
  | "ventas_netas_sin_iva"
  | "costo_ventas"
  | "utilidad_bruta"
  | "costo_agente"
  | "comision_terminal"
  | "nomina"
  | "renta"
  | "servicios"
  | "otros"
  | "ebitda";

/** Líneas que deben tener dato para mostrar el EBITDA. */
export const LINEAS_REQUERIDAS_EBITDA: readonly LineaId[] = ["ventas_netas_sin_iva", "costo_ventas", "costo_agente", "comision_terminal", "nomina", "renta", "servicios", "otros"];

export const AVISO_CFO =
  "Este tablero organiza tus datos operativos para que tomes decisiones. No sustituye a tu contabilidad, ni a tus estados financieros dictaminados, ni da asesoría fiscal o financiera. Las cifras marcadas como estimadas o capturadas dependen de supuestos o de datos que tú ingresaste.";

export interface LineaPyl {
  readonly id: LineaId;
  readonly etiqueta: string;
  readonly cifra: Cifra;
  /** true = «captura pendiente»: el dueño aún no captura este costo. */
  readonly faltaCaptura: boolean;
  /** Solo en el Total: sucursales a las que les falta captura. */
  readonly faltantes: readonly string[];
  /** «estimado (prorrateo)» cuando el periodo no cubre el mes completo. */
  readonly estimadoPorProrrateo: boolean;
  readonly nota: string | null;
}

export interface DesgloseSr {
  readonly domicilioSR: number;
  /** comedor + para llevar + rápido. */
  readonly presencial: number;
  readonly otro: number;
  readonly comedor: number;
  readonly paraLlevar: number;
  readonly rapido: number;
}

export interface TitularVentas {
  readonly etiqueta: string;
  readonly origen: "softrestaurant" | "agente";
  readonly cifra: Cifra;
  /** Solo con SR. */
  readonly desglose: DesgloseSr | null;
  /** Con SR: lo que el agente tomó, SOLO informativo (ya está dentro de SR). Nunca se suma. */
  readonly ventasAgenteMemo: Cifra | null;
  readonly nota: string | null;
  /** Con SR y `coberturaSrMinima` < 1: cuántos días del periodo trae SR. null = cobertura completa o sin SR. El titular NO es comparable con el memo del agente. */
  readonly coberturaParcialSr: { readonly diasConDato: number; readonly diasPeriodo: number } | null;
}

export interface MemoPyl {
  readonly cortesias: Cifra;
  readonly cancelaciones: Cifra;
  readonly noRecogidos: Cifra;
  readonly propinasTarjeta: Cifra;
  /** Pedidos de web / panel (no son «del agente»); ya están en el estado de resultados sin SR. */
  readonly ventasOtrosOrigenes: Cifra;
  /** bruta − descuentos − neta (agente). Debe ser 0: si no, hay un descuadre de la cascada. */
  readonly descuadreCascadaCentavos: number | null;
}

export interface RatiosPyl {
  readonly margenBrutoPct: Cifra;
  readonly foodCostPct: Cifra;
  readonly primeCostPct: Cifra;
  readonly costoAgentePct: Cifra;
  readonly margenContribucionPct: Cifra;
  readonly puntoEquilibrio: Cifra;
}

export interface ColumnaPyl {
  readonly clave: "sucursal" | "no_asignado" | "total";
  readonly propertyId: string | null;
  readonly nombre: string;
  readonly titular: TitularVentas;
  readonly lineas: readonly LineaPyl[];
  readonly margenContribucion: MargenContribucion;
  readonly ebitda: Cifra;
  /** Líneas faltantes que impiden el EBITDA. [] = EBITDA completo. */
  readonly incompleto: readonly LineaId[];
  readonly memo: MemoPyl;
  readonly ratios: RatiosPyl;
  readonly costoAgente: CostoAgente | null;
  readonly notas: readonly string[];
}

export interface PeriodoPyl {
  readonly clave: string;
  readonly desde: string;
  readonly hasta: string;
  readonly usaSr: boolean;
  readonly columnas: readonly ColumnaPyl[];
}

export interface EstadoResultados {
  readonly granularidad: Granularidad;
  readonly rango: { readonly desde: string; readonly hasta: string };
  readonly periodos: readonly PeriodoPyl[];
  readonly acumulado: PeriodoPyl;
  readonly avisoLegal: string;
}

export interface EntradaEstadoResultados {
  readonly ventas: readonly FilaVentasDiarias[];
  readonly cortesias: readonly FilaCortesias[];
  readonly costosAgente: readonly FilaAgenteDiario[];
  readonly costosCapturados: readonly FilaCostoCaptura[];
  readonly config: CfoConfig;
  readonly srResumen?: readonly FilaSrResumen[];
  readonly granularidad: Granularidad;
  readonly rango: { readonly desde: string; readonly hasta: string };
  readonly alcance: AlcanceSucursales;
  readonly sucursales?: readonly SucursalCfo[];
  /** Fracción de los días del periodo que SR debe cubrir para usarlo como titular. Default 1 (todos los días). */
  readonly coberturaSrMinima?: number;
}

const ETIQUETAS: Readonly<Record<LineaId, string>> = {
  ventas_brutas: "Ventas brutas (lista)",
  descuentos_promocion: "Descuentos por promoción",
  compensaciones: "Compensaciones (códigos GRACIAS-)",
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

const CONCEPTOS_OTROS: readonly ConceptoCosto[] = ["otros", "marketing", "mantenimiento"];

// ---- Periodos ----------------------------------------------------------------------------------------------------------------------------

export function dividirEnPeriodos(desde: string, hasta: string, g: Granularidad): Array<{ clave: string; desde: string; hasta: string }> {
  const dias = expandirDias(desde, hasta);
  if (dias.length === 0) return [];
  const out: Array<{ clave: string; desde: string; hasta: string }> = [];
  if (g === "dia") return dias.map((d) => ({ clave: d, desde: d, hasta: d }));
  const claveDe = (d: string): string => (g === "mes" ? mesDe(d) : lunesDe(d));
  let ini = dias[0]!;
  let cur = claveDe(ini);
  for (let i = 1; i < dias.length; i++) {
    const d = dias[i]!;
    const k = claveDe(d);
    if (k !== cur) {
      out.push({ clave: cur, desde: ini, hasta: sumarDiasFecha(d, -1) });
      ini = d;
      cur = k;
    }
  }
  out.push({ clave: cur, desde: ini, hasta: dias[dias.length - 1]! });
  return out;
}

/** Cuántos días del periodo caen en cada mes (`YYYY-MM`). */
function diasPorMes(desde: string, hasta: string): Array<{ mes: string; dias: number }> {
  const m = new Map<string, number>();
  for (const d of expandirDias(desde, hasta)) m.set(mesDe(d), (m.get(mesDe(d)) ?? 0) + 1);
  return [...m.entries()].map(([mes, dias]) => ({ mes, dias }));
}

// ---- Contexto indexado -------------------------------------------------------------------------------------------------------------------

interface Contexto {
  readonly entrada: EntradaEstadoResultados;
  readonly ids: readonly string[];
  readonly verNoAsignado: boolean;
  readonly nombres: ReadonlyMap<string, string>;
  readonly ventasPor: ReadonlyMap<string, readonly FilaVentasDiarias[]>;
  readonly cortesiasPor: ReadonlyMap<string, readonly FilaCortesias[]>;
  readonly agentePor: ReadonlyMap<string, readonly FilaAgenteDiario[]>;
  readonly srPor: ReadonlyMap<string, readonly FilaSrResumen[]>;
  readonly capturaPor: ReadonlyMap<string, FilaCostoCaptura>;
  readonly coberturaMin: number;
}

function indexar<T>(filas: readonly T[], clave: (f: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const f of filas) {
    const k = clave(f);
    const l = m.get(k);
    if (l) l.push(f);
    else m.set(k, [f]);
  }
  return m;
}

function claveCaptura(prop: string | null, mes: string, concepto: ConceptoCosto): string {
  return `${prop ?? "*"}|${mes}|${concepto}`;
}

function construirContexto(e: EntradaEstadoResultados): Contexto {
  const ids = [...e.alcance.propertyIds];
  const conjunto = new Set(ids);
  const verNoAsignado = e.alcance.organizacionCompleta && e.alcance.todas;
  const enAlcance = <T extends { propertyId: string | null }>(f: T): boolean => (f.propertyId === null ? verNoAsignado : conjunto.has(f.propertyId));
  const clave = (f: { propertyId: string | null; diaNegocio: string }): string => `${f.propertyId ?? "*"}|${f.diaNegocio}`;
  const captura = new Map<string, FilaCostoCaptura>();
  for (const c of e.costosCapturados) {
    if (!enAlcance(c)) continue;
    captura.set(claveCaptura(c.propertyId, c.mes.slice(0, 7), c.concepto), c);
  }
  return {
    entrada: e,
    ids,
    verNoAsignado,
    nombres: new Map((e.sucursales ?? []).map((s) => [s.propertyId, s.nombre])),
    ventasPor: indexar(e.ventas.filter(enAlcance), clave),
    cortesiasPor: indexar(e.cortesias.filter(enAlcance), clave),
    agentePor: indexar(e.costosAgente.filter(enAlcance), clave),
    srPor: indexar((e.srResumen ?? []).filter(enAlcance), clave),
    capturaPor: captura,
    coberturaMin: e.coberturaSrMinima ?? 1,
  };
}

function filasDe<T>(m: ReadonlyMap<string, readonly T[]>, prop: string | null, dias: readonly string[]): T[] {
  const out: T[] = [];
  for (const d of dias) {
    const l = m.get(`${prop ?? "*"}|${d}`);
    if (l) out.push(...l);
  }
  return out;
}

// ---- SR ----------------------------------------------------------------------------------------------------------------------------------

interface NumerosSr {
  readonly filas: number;
  readonly diasConDato: number;
  readonly tickets: number;
  readonly brutaCentavos: number;
  readonly descuentoCentavos: number;
  readonly canceladoCentavos: number;
  readonly propinaCentavos: number;
  /** Solo la propina de renglones con forma de pago de tarjeta; null si el archivo no trae forma de pago. */
  readonly propinaTarjetaCentavos: number | null;
  readonly netaCentavos: number;
  /** Σ del IVA que trae el archivo; null si algún renglón no lo trae. */
  readonly ivaCentavos: number | null;
  readonly netaTarjetaCentavos: number | null;
  readonly porServicio: Readonly<Record<TipoServicioSr, number>>;
}

export function esFormaPagoTarjeta(forma: string | null): boolean {
  if (!forma) return false;
  const f = forma.toLowerCase();
  return f.includes("tarjeta") || f.includes("credito") || f.includes("crédito") || f.includes("debito") || f.includes("débito");
}

function numerosSr(filas: readonly FilaSrResumen[]): NumerosSr {
  const porServicio: Record<TipoServicioSr, number> = { comedor: 0, para_llevar: 0, domicilio: 0, rapido: 0, otro: 0 };
  let ivaTodos = filas.length > 0;
  let iva = 0;
  let tarjeta = 0;
  let propTarjeta = 0;
  // Tarjeta solo se conoce si TODOS los renglones traen forma de pago (084 las separa por renglón): con una mezcla, sumar solo los que la traen subestimaría la comisión.
  let hayForma = filas.length > 0;
  for (const f of filas) {
    porServicio[f.tipoServicio] += f.netaCentavos;
    if (f.ivaCentavos == null) ivaTodos = false;
    else iva += f.ivaCentavos;
    if (f.formaPago == null) hayForma = false;
    if (esFormaPagoTarjeta(f.formaPago)) { tarjeta += f.netaCentavos; propTarjeta += f.propinaCentavos; }
  }
  return {
    filas: filas.length,
    diasConDato: new Set(filas.map((f) => f.diaNegocio)).size,
    tickets: suma(filas.map((f) => f.tickets)),
    brutaCentavos: suma(filas.map((f) => f.brutaCentavos)),
    descuentoCentavos: suma(filas.map((f) => f.descuentoCentavos)),
    canceladoCentavos: suma(filas.map((f) => f.canceladoCentavos)),
    propinaCentavos: suma(filas.map((f) => f.propinaCentavos)),
    propinaTarjetaCentavos: hayForma ? propTarjeta : null,
    netaCentavos: suma(filas.map((f) => f.netaCentavos)),
    ivaCentavos: ivaTodos ? iva : null,
    netaTarjetaCentavos: hayForma ? tarjeta : null,
    porServicio,
  };
}

// ---- Costos capturados -------------------------------------------------------------------------------------------------------------------

interface ResultadoCosto {
  readonly valor: number | null;
  readonly confianza: "capturado" | "estimado" | "sin_dato";
  readonly falta: boolean;
  readonly prorrateo: boolean;
  /** true = la sucursal no tiene captura propia pero la organización sí (el monto vive en «No asignado»). */
  readonly cubiertoPorOrg: boolean;
}

function prorratear(monto: number, diasPeriodo: number, mes: string): { valor: number; prorrateo: boolean } {
  const n = diasDelMes(mes);
  return diasPeriodo >= n ? { valor: monto, prorrateo: false } : { valor: mulDiv(monto, diasPeriodo, n), prorrateo: true };
}

/** Costo de un concepto de monto mensual (nómina, renta, servicios, otros) para una columna y un periodo. */
function costoMensual(ctx: Contexto, prop: string | null, conceptos: readonly ConceptoCosto[], desde: string, hasta: string): ResultadoCosto {
  let total = 0;
  let alguno = false;
  let falta = false;
  let prorrateo = false;
  let porOrg = false;
  for (const { mes, dias } of diasPorMes(desde, hasta)) {
    let cubierto = false;
    for (const c of conceptos) {
      const fila = ctx.capturaPor.get(claveCaptura(prop, mes, c));
      if (fila?.montoCentavos != null) {
        const p = prorratear(fila.montoCentavos, dias, mes);
        total += p.valor;
        prorrateo ||= p.prorrateo;
        alguno = true;
        cubierto = true;
      }
    }
    if (!cubierto && prop !== null) {
      // ¿lo capturó la organización (No asignado)? Entonces la sucursal no está "pendiente": está cubierto a nivel organización.
      const org = conceptos.some((c) => ctx.capturaPor.get(claveCaptura(null, mes, c))?.montoCentavos != null);
      if (org) porOrg = true;
      else falta = true;
    }
  }
  return { valor: alguno ? total : null, confianza: alguno ? (prorrateo ? "estimado" : "capturado") : "sin_dato", falta, prorrateo, cubiertoPorOrg: porOrg && !falta };
}

// ---- Números por columna -----------------------------------------------------------------------------------------------------------------

interface NumerosColumna {
  readonly propertyId: string | null;
  readonly ventas: SumasVentas;
  readonly cortesiasCentavos: number;
  readonly agente: SumasAgente;
  readonly sr: NumerosSr | null;
  readonly diasPeriodo: number;
}

function numerosDeColumna(ctx: Contexto, prop: string | null, dias: readonly string[]): NumerosColumna {
  const sr = prop === null ? null : numerosSr(filasDe(ctx.srPor, prop, dias));
  return {
    propertyId: prop,
    ventas: sumarVentas(prop === null ? [] : filasDe(ctx.ventasPor, prop, dias)),
    cortesiasCentavos: suma(filasDe(ctx.cortesiasPor, prop, dias).map((c) => c.valorListaCentavos)),
    agente: sumarAgente(filasDe(ctx.agentePor, prop, dias)),
    sr: sr && sr.filas > 0 ? sr : null,
    diasPeriodo: dias.length,
  };
}

function cubreSr(n: NumerosColumna, ctx: Contexto): boolean {
  return n.sr !== null && n.sr.diasConDato >= Math.ceil(ctx.coberturaMin * n.diasPeriodo);
}

// ---- Líneas ------------------------------------------------------------------------------------------------------------------------------

function linea(id: LineaId, c: Cifra, extra: Partial<Pick<LineaPyl, "faltaCaptura" | "faltantes" | "estimadoPorProrrateo" | "nota">> = {}): LineaPyl {
  return { id, etiqueta: ETIQUETAS[id], cifra: c, faltaCaptura: extra.faltaCaptura ?? false, faltantes: extra.faltantes ?? [], estimadoPorProrrateo: extra.estimadoPorProrrateo ?? false, nota: extra.nota ?? null };
}

function lineaCosto(id: LineaId, r: ResultadoCosto, fuente: string, nota?: string): LineaPyl {
  if (r.valor == null) {
    return linea(id, sinDato(r.cubiertoPorOrg ? `${fuente} (capturado a nivel organización)` : `${fuente} (captura pendiente)`), {
      faltaCaptura: r.falta,
      nota: r.cubiertoPorOrg ? "Capturado a nivel organización (ver «No asignado»)" : (nota ?? null),
    });
  }
  return linea(id, cifra(r.valor, r.confianza === "sin_dato" ? "capturado" : r.confianza, r.prorrateo ? `${fuente} (estimado: prorrateo)` : fuente), {
    faltaCaptura: r.falta,
    estimadoPorProrrateo: r.prorrateo,
    nota: r.prorrateo ? "estimado (prorrateo)" : (nota ?? null),
  });
}

interface ParcialColumna {
  readonly lineas: Map<LineaId, LineaPyl>;
  readonly netaCentavos: number | null;
  readonly netaSinIvaCentavos: number | null;
  readonly netaTarjetaCentavos: number | null;
}

function costoVentas(ctx: Contexto, prop: string, desde: string, hasta: string, netaPorMes: (mes: string) => number | null): ResultadoCosto {
  const { config } = ctx.entrada;
  let total = 0;
  let alguno = false;
  let falta = false;
  let prorrateo = false;
  let estimado = false;
  let porOrg = false;
  for (const { mes, dias } of diasPorMes(desde, hasta)) {
    const insumos = ctx.capturaPor.get(claveCaptura(prop, mes, "insumos"));
    if (insumos?.montoCentavos != null) {
      const p = prorratear(insumos.montoCentavos, dias, mes);
      total += p.valor;
      prorrateo ||= p.prorrateo;
      alguno = true;
      continue;
    }
    const pctFila = ctx.capturaPor.get(claveCaptura(prop, mes, "food_cost_objetivo_pct")) ?? ctx.capturaPor.get(claveCaptura(null, mes, "food_cost_objetivo_pct"));
    if (pctFila?.pct != null) {
      const neta = netaPorMes(mes);
      if (neta != null) {
        const sinIva = neta - (ivaEstimado(neta, config.ivaPct).valor ?? 0);
        total += mulDiv(sinIva, redondear(pctFila.pct * 100), 10000);
        alguno = true;
        estimado = true;
        continue;
      }
    }
    if (ctx.capturaPor.get(claveCaptura(null, mes, "insumos"))?.montoCentavos != null) { porOrg = true; continue; } // cubierto a nivel organización
    falta = true;
  }
  return { valor: alguno ? total : null, confianza: alguno ? (estimado || prorrateo ? "estimado" : "capturado") : "sin_dato", falta, prorrateo, cubiertoPorOrg: porOrg && !falta };
}

function parcialSucursal(ctx: Contexto, n: NumerosColumna, usaSr: boolean, desde: string, hasta: string): ParcialColumna {
  const prop = n.propertyId as string;
  const { config } = ctx.entrada;
  const lineas = new Map<LineaId, LineaPyl>();
  const dias = expandirDias(desde, hasta);

  // Ventas (base SR o base agente)
  let netaSinVentas = false;
  let bruta: number; let descPromo: number | null; let descComp: number | null; let neta: number; let ivaImportado: number | null = null; let netaTarjeta: number | null;
  if (usaSr && n.sr) {
    bruta = n.sr.brutaCentavos; descPromo = n.sr.descuentoCentavos; descComp = null; neta = n.sr.netaCentavos; ivaImportado = n.sr.ivaCentavos; netaTarjeta = n.sr.netaTarjetaCentavos;
    lineas.set("ventas_brutas", linea("ventas_brutas", cifra(bruta, "importado", "sr_resumen_dia")));
    lineas.set("descuentos_promocion", linea("descuentos_promocion", cifra(descPromo, "importado", "sr_resumen_dia"), { nota: "Descuentos de SoftRestaurant (incluyen las compensaciones)" }));
    lineas.set("compensaciones", linea("compensaciones", sinDato("sr_resumen_dia"), { nota: "Incluidas en los descuentos de SoftRestaurant" }));
    lineas.set("ventas_netas", linea("ventas_netas", cifra(neta, "importado", "sr_resumen_dia"), { nota: "Total de SoftRestaurant" }));
  } else {
    bruta = n.ventas.brutaCentavos; descPromo = n.ventas.descPromoCentavos; descComp = n.ventas.descCompCentavos; neta = n.ventas.netaCentavos; netaTarjeta = n.ventas.netaTarjetaCentavos;
    const hayVentas = n.ventas.pedidos > 0 || n.ventas.cancelados > 0 || n.ventas.brutaCentavos > 0;
    const c = (v: number, f: string): Cifra => (hayVentas ? cifra(v, "medido", f) : sinDato(f));
    lineas.set("ventas_brutas", linea("ventas_brutas", c(bruta, "cfo_ventas_diarias")));
    lineas.set("descuentos_promocion", linea("descuentos_promocion", c(descPromo, "cfo_ventas_diarias")));
    lineas.set("compensaciones", linea("compensaciones", c(descComp ?? 0, "cfo_ventas_diarias")));
    lineas.set("ventas_netas", linea("ventas_netas", c(neta, "cfo_ventas_diarias"), { nota: "Ventas por el agente" }));
    netaSinVentas = !hayVentas;
  }
  const netaOk: number | null = netaSinVentas ? null : neta;
  const iva = netaOk == null ? sinDato("formula:iva_estimado") : ivaImportado != null ? cifra(ivaImportado, "importado", "sr_resumen_dia") : ivaEstimado(netaOk, config.ivaPct);
  const sinIva = netaOk == null || iva.valor == null ? sinDato("formula:neta_sin_iva") : cifra(netaOk - iva.valor, iva.confianza === "importado" ? "importado" : "estimado", "formula:neta−iva");
  lineas.set("iva_estimado", linea("iva_estimado", iva));
  lineas.set("ventas_netas_sin_iva", linea("ventas_netas_sin_iva", sinIva));

  // Neta por mes (para el food cost % objetivo)
  const netaPorMes = (mes: string): number | null => {
    const diasMes = dias.filter((d) => mesDe(d) === mes);
    if (usaSr) {
      const f = filasDe(ctx.srPor, prop, diasMes);
      return f.length > 0 ? suma(f.map((x) => x.netaCentavos)) : null;
    }
    const f = filasDe(ctx.ventasPor, prop, diasMes);
    return f.length > 0 ? suma(f.map((x) => x.netaCentavos)) : null;
  };
  lineas.set("costo_ventas", lineaCosto("costo_ventas", costoVentas(ctx, prop, desde, hasta, netaPorMes), "cfo_costo_captura"));

  // Comisión de terminal
  const comCapt = costoMensual(ctx, prop, ["comision_terminal"], desde, hasta);
  if (comCapt.valor != null || comCapt.cubiertoPorOrg) {
    lineas.set("comision_terminal", lineaCosto("comision_terminal", comCapt, "cfo_costo_captura"));
  } else if (config.comisionTerminalPct != null && netaTarjeta != null && netaOk != null) {
    lineas.set("comision_terminal", linea("comision_terminal", formulaComision(config.comisionTerminalPct, netaTarjeta)));
  } else {
    lineas.set("comision_terminal", linea("comision_terminal", sinDato("cfo_config.comision_terminal_pct (captura pendiente)"), { faltaCaptura: true }));
  }

  lineas.set("nomina", lineaCosto("nomina", costoMensual(ctx, prop, ["nomina"], desde, hasta), "cfo_costo_captura"));
  lineas.set("renta", lineaCosto("renta", costoMensual(ctx, prop, ["renta"], desde, hasta), "cfo_costo_captura"));
  lineas.set("servicios", lineaCosto("servicios", costoMensual(ctx, prop, ["servicios"], desde, hasta), "cfo_costo_captura"));
  lineas.set("otros", lineaCosto("otros", costoMensual(ctx, prop, CONCEPTOS_OTROS, desde, hasta), "cfo_costo_captura", "Marketing, mantenimiento y otros"));

  // Costo del agente (medido; sin LLM en sucursales)
  const ca = formulaCostoAgente(n.agente, false);
  lineas.set("costo_agente", linea("costo_agente", n.agente.filas === 0 ? sinDato("cfo_agente_diario") : ca.total, { nota: ca.metaMedido ? null : "Costo de Meta por mensaje: no medido" }));
  return { lineas, netaCentavos: netaOk, netaSinIvaCentavos: sinIva.valor, netaTarjetaCentavos: netaTarjeta };
}

// ---- Columnas ----------------------------------------------------------------------------------------------------------------------------

function memoDe(n: NumerosColumna, usaSr: boolean): MemoPyl {
  const v = n.ventas;
  const hay = v.pedidos > 0 || v.cancelados > 0 || n.cortesiasCentavos > 0;
  const m = (x: number, f: string, c: "medido" | "estimado" = "medido"): Cifra => (hay ? cifra(x, c, f) : sinDato(f));
  const desc = v.brutaCentavos - v.descPromoCentavos - v.descCompCentavos - v.netaCentavos;
  return {
    cortesias: hay ? cifra(n.cortesiasCentavos, "estimado", "cfo_cortesias (precio de lista)") : sinDato("cfo_cortesias"),
    cancelaciones: usaSr && n.sr ? cifra(n.sr.canceladoCentavos, "importado", "sr_resumen_dia") : m(v.canceladosCentavos, "cfo_ventas_diarias"),
    noRecogidos: m(v.noRecogidosCentavos, "cfo_ventas_diarias"),
    propinasTarjeta: usaSr && n.sr ? cifra(n.sr.propinaTarjetaCentavos, "importado", "sr_resumen_dia (solo tarjeta)") : m(v.propinaTarjetaCentavos, "cfo_ventas_diarias (solo tarjeta)"),
    ventasOtrosOrigenes: m(v.netaOtrosOrigenesCentavos, "cfo_ventas_diarias"),
    descuadreCascadaCentavos: v.pedidos > 0 ? desc : null,
  };
}

function titularDe(n: NumerosColumna, usaSr: boolean): TitularVentas {
  const agenteMemo = n.ventas.pedidos > 0 ? cifra(n.ventas.netaAgenteCentavos, "medido", "cfo_ventas_diarias (voz y WhatsApp)") : sinDato("cfo_ventas_diarias");
  if (usaSr && n.sr) {
    const s = n.sr.porServicio;
    const parcial = n.sr.diasConDato < n.diasPeriodo;
    return {
      etiqueta: "Ventas del negocio (SoftRestaurant)",
      origen: "softrestaurant",
      cifra: cifra(n.sr.netaCentavos, "importado", "sr_resumen_dia"),
      desglose: { domicilioSR: s.domicilio, presencial: s.comedor + s.para_llevar + s.rapido, otro: s.otro, comedor: s.comedor, paraLlevar: s.para_llevar, rapido: s.rapido },
      ventasAgenteMemo: agenteMemo,
      nota: "El agente es un subconjunto de estas ventas (ya están dentro de «domicilio» y «para llevar»). No se suman." + (parcial ? ` Cobertura parcial: SoftRestaurant trae ${n.sr.diasConDato} de ${n.diasPeriodo} días del periodo; el memo del agente cubre todos los días y no es comparable.` : ""),
      coberturaParcialSr: parcial ? { diasConDato: n.sr.diasConDato, diasPeriodo: n.diasPeriodo } : null,
    };
  }
  return {
    etiqueta: "Ventas por el agente",
    origen: "agente",
    cifra: n.ventas.pedidos > 0 ? cifra(n.ventas.netaCentavos, "medido", "cfo_ventas_diarias") : sinDato("cfo_ventas_diarias"),
    desglose: null,
    ventasAgenteMemo: null,
    nota: "Sin datos de mostrador de SoftRestaurant: solo se cuentan los pedidos tomados por Atiende (WhatsApp y voz).",
    coberturaParcialSr: null,
  };
}

const REQUERIDAS_COSTO: readonly LineaId[] = ["costo_ventas", "costo_agente", "comision_terminal", "nomina", "renta", "servicios", "otros"];

/**
 * Completa utilidad bruta, EBITDA, margen y ratios a partir de las líneas base.
 * Una línea cuenta como FALTANTE si le falta captura (`faltaCaptura`) o, en el Total, si alguna sucursal no tiene dato (`faltantes`).
 * Una línea de costo sin valor pero cubierta a nivel organización no es faltante, pero impide el EBITDA de la sucursal
 * (el costo está sin asignar): el EBITDA completo vive en el Total.
 */
function derivar(lineas: Map<LineaId, LineaPyl>): { lineas: LineaPyl[]; margen: MargenContribucion; ebitda: Cifra; incompleto: LineaId[]; sinAsignar: boolean; ratios: RatiosPyl } {
  const v = (id: LineaId): number | null => lineas.get(id)?.cifra.valor ?? null;
  const falta = (id: LineaId): boolean => {
    const l = lineas.get(id);
    return !l || l.faltaCaptura || l.faltantes.length > 0;
  };
  const sinIva = v("ventas_netas_sin_iva");
  const costoVentasVal = v("costo_ventas");

  const utilidadOk = sinIva != null && costoVentasVal != null && !falta("costo_ventas");
  const utilidad = utilidadOk ? cifra(sinIva - costoVentasVal, combinarConfianza(["estimado", lineas.get("costo_ventas")!.cifra.confianza]), "formula:neta_sin_iva−costo_ventas") : sinDato("formula:utilidad_bruta");
  lineas.set("utilidad_bruta", linea("utilidad_bruta", utilidad, { faltaCaptura: falta("costo_ventas") }));

  const margen = margenContribucion({
    netaSinIva: lineas.get("ventas_netas_sin_iva")?.cifra ?? sinDato("x"),
    foodCost: falta("costo_ventas") ? sinDato("x") : (lineas.get("costo_ventas")?.cifra ?? sinDato("x")),
    costoAgente: falta("costo_agente") ? sinDato("x") : (lineas.get("costo_agente")?.cifra ?? sinDato("x")),
    comisionTerminal: falta("comision_terminal") ? sinDato("x") : (lineas.get("comision_terminal")?.cifra ?? sinDato("x")),
  });

  const incompleto: LineaId[] = [];
  if (sinIva == null || falta("ventas_netas_sin_iva")) incompleto.push("ventas_netas_sin_iva");
  let sinAsignar = false;
  for (const id of REQUERIDAS_COSTO) {
    const l = lineas.get(id);
    const sinValor = !l || l.cifra.valor == null;
    if (falta(id)) incompleto.push(id);
    else if (sinValor) {
      if (id === "costo_agente") incompleto.push(id); // sin medición del agente: no hay EBITDA
      else sinAsignar = true; // capturado a nivel organización
    }
  }
  let ebitda: Cifra = sinDato("formula:ebitda");
  if (incompleto.length === 0 && !sinAsignar && sinIva != null) {
    let e = sinIva;
    const confs = ["estimado" as const];
    for (const id of REQUERIDAS_COSTO) {
      e -= v(id) ?? 0;
      confs.push(lineas.get(id)!.cifra.confianza as "estimado");
    }
    ebitda = cifra(e, combinarConfianza(confs), "formula:ebitda");
  }
  lineas.set("ebitda", linea("ebitda", ebitda, { faltaCaptura: incompleto.length > 0, nota: sinAsignar && incompleto.length === 0 ? "Hay costos capturados a nivel organización: el EBITDA completo está en el Total" : null }));

  const fijoFalta = (["nomina", "renta", "servicios", "otros"] as const).some((id) => falta(id) || v(id) == null);
  const fijos = fijoFalta ? null : suma((["nomina", "renta", "servicios", "otros"] as const).map((id) => v(id)));
  const prime = !falta("costo_ventas") && costoVentasVal != null && !falta("nomina") && v("nomina") != null ? costoVentasVal + (v("nomina") ?? 0) : null;
  const agenteVal = falta("costo_agente") ? null : v("costo_agente");
  const ratios: RatiosPyl = {
    margenBrutoPct: pctSobreVentas(utilidad.valor, sinIva, "formula:utilidad_bruta/neta_sin_iva"),
    foodCostPct: pctSobreVentas(falta("costo_ventas") ? null : costoVentasVal, sinIva, "formula:costo_ventas/neta_sin_iva"),
    primeCostPct: pctSobreVentas(prime, sinIva, "formula:(food+nómina)/neta_sin_iva"),
    costoAgentePct: pctSobreVentas(agenteVal, sinIva, "formula:costo_agente/neta_sin_iva"),
    margenContribucionPct: pctSobreVentas(margen.parcial ? null : margen.cifra.valor, sinIva, "formula:margen_contribucion/neta_sin_iva"),
    puntoEquilibrio: puntoEquilibrio(fijos, margen.parcial ? null : margen.cifra.valor, sinIva),
  };
  const orden: LineaId[] = ["ventas_brutas", "descuentos_promocion", "compensaciones", "ventas_netas", "iva_estimado", "ventas_netas_sin_iva", "costo_ventas", "utilidad_bruta", "costo_agente", "comision_terminal", "nomina", "renta", "servicios", "otros", "ebitda"];
  return { lineas: orden.map((id) => lineas.get(id)!).filter(Boolean), margen, ebitda, incompleto, sinAsignar, ratios };
}

function notasDe(n: NumerosColumna | null, ca: CostoAgente | null): string[] {
  const out: string[] = [];
  if (ca && !ca.metaMedido) out.push("Costo de Meta por mensaje: no medido (no se cuenta como $0).");
  if (ca && !ca.completo) out.push("Costo del agente incompleto: falta el tipo de cambio o el dato de voz/telefonía.");
  if (n && n.ventas.pedidosOtrosOrigenes > 0) out.push("Incluye pedidos capturados desde el panel o la web (no son del agente).");
  return out;
}

function columnaSucursal(ctx: Contexto, prop: string, desde: string, hasta: string, usaSr: boolean): ColumnaPyl {
  const dias = expandirDias(desde, hasta);
  const n = numerosDeColumna(ctx, prop, dias);
  const p = parcialSucursal(ctx, n, usaSr, desde, hasta);
  const d = derivar(p.lineas);
  const ca = n.agente.filas === 0 ? null : formulaCostoAgente(n.agente, false);
  return {
    clave: "sucursal",
    propertyId: prop,
    nombre: ctx.nombres.get(prop) ?? prop,
    titular: titularDe(n, usaSr),
    lineas: d.lineas,
    margenContribucion: d.margen,
    ebitda: d.ebitda,
    incompleto: d.incompleto,
    memo: memoDe(n, usaSr),
    ratios: d.ratios,
    costoAgente: ca,
    notas: notasDe(n, ca),
  };
}

function columnaNoAsignado(ctx: Contexto, desde: string, hasta: string): ColumnaPyl {
  const dias = expandirDias(desde, hasta);
  const n = numerosDeColumna(ctx, null, dias);
  const ca = n.agente.filas === 0 ? null : formulaCostoAgente(n.agente, true);
  const lineas = new Map<LineaId, LineaPyl>();
  const sd = (id: LineaId): LineaPyl => linea(id, sinDato("No asignado"));
  for (const id of ["ventas_brutas", "descuentos_promocion", "compensaciones", "ventas_netas", "iva_estimado", "ventas_netas_sin_iva"] as const) lineas.set(id, sd(id));
  // Montos capturados a nivel organización: se muestran aquí, sin marcar faltante (lo que falta se marca en cada sucursal).
  const org = (ids: readonly ConceptoCosto[]): ResultadoCosto => {
    const r = costoMensual(ctx, null, ids, desde, hasta);
    return { ...r, falta: false, cubiertoPorOrg: false };
  };
  const lineaOrg = (id: LineaId, ids: readonly ConceptoCosto[]): LineaPyl => {
    const r = org(ids);
    return r.valor == null ? linea(id, sinDato("No asignado")) : lineaCosto(id, r, "cfo_costo_captura (organización)");
  };
  lineas.set("costo_ventas", lineaOrg("costo_ventas", ["insumos"]));
  lineas.set("comision_terminal", lineaOrg("comision_terminal", ["comision_terminal"]));
  lineas.set("nomina", lineaOrg("nomina", ["nomina"]));
  lineas.set("renta", lineaOrg("renta", ["renta"]));
  lineas.set("servicios", lineaOrg("servicios", ["servicios"]));
  lineas.set("otros", lineaOrg("otros", CONCEPTOS_OTROS));
  lineas.set("costo_agente", linea("costo_agente", n.agente.filas === 0 ? sinDato("cfo_agente_diario") : (ca?.total ?? sinDato("cfo_agente_diario")), { nota: "Incluye el costo de IA de texto, que es de la organización y no se asigna a una sucursal" }));
  lineas.set("utilidad_bruta", sd("utilidad_bruta"));
  lineas.set("ebitda", linea("ebitda", sinDato("No asignado"), { nota: "El EBITDA se calcula por sucursal y en el total" }));
  const orden: LineaId[] = ["ventas_brutas", "descuentos_promocion", "compensaciones", "ventas_netas", "iva_estimado", "ventas_netas_sin_iva", "costo_ventas", "utilidad_bruta", "costo_agente", "comision_terminal", "nomina", "renta", "servicios", "otros", "ebitda"];
  const vacio = sinDato("No asignado");
  return {
    clave: "no_asignado",
    propertyId: null,
    nombre: "No asignado",
    titular: { etiqueta: "No asignado a sucursal", origen: "agente", cifra: vacio, desglose: null, ventasAgenteMemo: null, nota: null, coberturaParcialSr: null },
    lineas: orden.map((id) => lineas.get(id)!),
    margenContribucion: { cifra: sinDato("formula:margen_contribucion"), faltan: [], parcial: false },
    ebitda: vacio,
    incompleto: [],
    memo: memoDe(n, false),
    ratios: { margenBrutoPct: vacio, foodCostPct: vacio, primeCostPct: vacio, costoAgentePct: vacio, margenContribucionPct: vacio, puntoEquilibrio: vacio },
    costoAgente: ca,
    notas: ["Costos que no se pueden asignar a una sucursal (IA de texto de la organización y costos capturados a nivel organización)."],
  };
}

function sumarCifras(cs: readonly Cifra[], fuente: string): Cifra {
  const v = sumaAnulable(cs.map((c) => c.valor));
  return v == null ? sinDato(fuente) : cifra(v, combinarConfianza(cs.map((c) => c.confianza)), fuente);
}

function columnaTotal(ctx: Contexto, cols: readonly ColumnaPyl[], sucursales: readonly ColumnaPyl[], usaSr: boolean, desde: string, hasta: string): ColumnaPyl {
  const lineas = new Map<LineaId, LineaPyl>();
  const ids: LineaId[] = ["ventas_brutas", "descuentos_promocion", "compensaciones", "ventas_netas", "iva_estimado", "ventas_netas_sin_iva", "costo_ventas", "costo_agente", "comision_terminal", "nomina", "renta", "servicios", "otros"];
  for (const id of ids) {
    const ls = cols.map((c) => c.lineas.find((l) => l.id === id)!);
    // Faltante en el Total: a la sucursal le falta captura, o (ventas y costo del agente) no tiene dato. Un costo cubierto por la
    // organización no es faltante: su monto ya está sumado desde «No asignado».
    const exigeDato = id === "costo_agente" || id.startsWith("ventas_");
    const faltantes = sucursales
      .filter((c) => {
        const l = c.lineas.find((x) => x.id === id)!;
        return l.faltaCaptura || (exigeDato && l.cifra.valor == null);
      })
      .map((c) => c.propertyId as string);
    const faltaCap = sucursales.some((c) => c.lineas.find((l) => l.id === id)!.faltaCaptura);
    const prorr = ls.some((l) => l.estimadoPorProrrateo);
    lineas.set(id, linea(id, sumarCifras(ls.map((l) => l.cifra), ls[0]?.cifra.fuente ?? "total"), {
      faltaCaptura: faltaCap,
      faltantes,
      estimadoPorProrrateo: prorr,
      nota: prorr ? "estimado (prorrateo)" : null,
    }));
  }
  const d = derivar(lineas);

  // Titular y memo del total: suma de las columnas (todas con la misma base, decidida por periodo).
  const sumaMemo = (f: (m: MemoPyl) => Cifra, fuente: string): Cifra => sumarCifras(cols.map((c) => f(c.memo)), fuente);
  const descuadres = cols.map((c) => c.memo.descuadreCascadaCentavos).filter((x): x is number => x != null);
  const memo: MemoPyl = {
    cortesias: sumaMemo((m) => m.cortesias, "cfo_cortesias"),
    cancelaciones: sumaMemo((m) => m.cancelaciones, "cfo_ventas_diarias"),
    noRecogidos: sumaMemo((m) => m.noRecogidos, "cfo_ventas_diarias"),
    propinasTarjeta: sumaMemo((m) => m.propinasTarjeta, "cfo_ventas_diarias"),
    ventasOtrosOrigenes: sumaMemo((m) => m.ventasOtrosOrigenes, "cfo_ventas_diarias"),
    descuadreCascadaCentavos: descuadres.length > 0 ? suma(descuadres) : null,
  };
  const tit = sucursales.map((c) => c.titular);
  const desglose: DesgloseSr | null = usaSr
    ? tit.reduce<DesgloseSr>((a, t) => ({
        domicilioSR: a.domicilioSR + (t.desglose?.domicilioSR ?? 0), presencial: a.presencial + (t.desglose?.presencial ?? 0), otro: a.otro + (t.desglose?.otro ?? 0),
        comedor: a.comedor + (t.desglose?.comedor ?? 0), paraLlevar: a.paraLlevar + (t.desglose?.paraLlevar ?? 0), rapido: a.rapido + (t.desglose?.rapido ?? 0),
      }), { domicilioSR: 0, presencial: 0, otro: 0, comedor: 0, paraLlevar: 0, rapido: 0 })
    : null;
  const titularCifra = sumarCifras(tit.map((t) => t.cifra), usaSr ? "sr_resumen_dia" : "cfo_ventas_diarias");
  const agenteMemo = usaSr ? sumarCifras(tit.map((t) => t.ventasAgenteMemo ?? sinDato("x")), "cfo_ventas_diarias (voz y WhatsApp)") : null;

  const cas = cols.map((c) => c.costoAgente).filter((c): c is CostoAgente => c != null);
  const notas = new Set<string>(cols.flatMap((c) => c.notas).filter((n) => !n.startsWith("Costos que no se pueden")));
  if (!ctx.verNoAsignado) notas.add("No incluye el costo de IA de texto de la organización (no se asigna a una sucursal).");
  const costoAgenteTotal: CostoAgente | null = cas.length === 0 ? null : {
    total: sumarCifras(cas.map((c) => c.total), "cfo_agente_diario"),
    llmTexto: sumarCifras(cas.map((c) => c.llmTexto), "core.llm_usage_daily"),
    voz: sumarCifras(cas.map((c) => c.voz), "voice_conversation"),
    telefonia: sumarCifras(cas.map((c) => c.telefonia), "core.usage_cost_event (telefonía)"),
    meta: sumarCifras(cas.map((c) => c.meta), "core.usage_cost_event (whatsapp)"),
    metaMedido: cas.some((c) => c.metaMedido),
    completo: cas.every((c) => c.completo),
  };
  void desde; void hasta;
  return {
    clave: "total",
    propertyId: null,
    nombre: "Total",
    titular: {
      etiqueta: usaSr ? "Ventas del negocio (SoftRestaurant)" : "Ventas por el agente",
      origen: usaSr ? "softrestaurant" : "agente",
      cifra: titularCifra,
      desglose,
      ventasAgenteMemo: agenteMemo,
      coberturaParcialSr: usaSr ? tit.map((t) => t.coberturaParcialSr).reduce<{ diasConDato: number; diasPeriodo: number } | null>((a, c) => (c && (!a || c.diasConDato < a.diasConDato) ? c : a), null) : null,
      nota: usaSr ? "El agente es un subconjunto de estas ventas. No se suman." + (tit.some((t) => t.coberturaParcialSr) ? " Cobertura parcial: SoftRestaurant no trae todos los días del periodo en alguna sucursal; el memo del agente no es comparable." : "") : "Sin datos de mostrador de SoftRestaurant en todas las sucursales: solo se cuentan los pedidos tomados por Atiende.",
    },
    lineas: d.lineas,
    margenContribucion: d.margen,
    ebitda: d.ebitda,
    incompleto: d.incompleto,
    memo,
    ratios: d.ratios,
    costoAgente: costoAgenteTotal,
    notas: [...notas],
  };
}

function calcularPeriodo(ctx: Contexto, clave: string, desde: string, hasta: string): PeriodoPyl {
  const dias = expandirDias(desde, hasta);
  // Base SR: solo si SR cubre el periodo en TODAS las sucursales del alcance. Si no, titular del agente (nunca mezclar).
  const numeros = ctx.ids.map((id) => numerosDeColumna(ctx, id, dias));
  const usaSr = numeros.length > 0 && numeros.every((n) => cubreSr(n, ctx));
  const sucursales = ctx.ids.map((id) => columnaSucursal(ctx, id, desde, hasta, usaSr));
  const noAsig = ctx.verNoAsignado ? columnaNoAsignado(ctx, desde, hasta) : null;
  const todas = noAsig ? [...sucursales, noAsig] : sucursales;
  const total = columnaTotal(ctx, todas, sucursales, usaSr, desde, hasta);
  return { clave, desde, hasta, usaSr, columnas: [...todas, total] };
}

/** Construye el estado de resultados por periodo (según la granularidad) y el acumulado del rango. */
export function construirEstadoResultados(entrada: EntradaEstadoResultados): EstadoResultados {
  const { desde, hasta } = entrada.rango;
  const ctx = construirContexto(entrada);
  const periodos = dividirEnPeriodos(desde, hasta, entrada.granularidad).map((p) => calcularPeriodo(ctx, p.clave, p.desde, p.hasta));
  return {
    granularidad: entrada.granularidad,
    rango: entrada.rango,
    periodos,
    acumulado: calcularPeriodo(ctx, "acumulado", desde, hasta),
    avisoLegal: AVISO_CFO,
  };
}

/** Utilidad para pruebas y UI: la columna de un periodo por propertyId (o "total" / "no_asignado"). */
export function columnaDe(p: PeriodoPyl, quien: string | "total" | "no_asignado"): ColumnaPyl | undefined {
  if (quien === "total") return p.columnas.find((c) => c.clave === "total");
  if (quien === "no_asignado") return p.columnas.find((c) => c.clave === "no_asignado");
  return p.columnas.find((c) => c.propertyId === quien);
}

export function lineaDe(c: ColumnaPyl, id: LineaId): LineaPyl {
  const l = c.lineas.find((x) => x.id === id);
  if (!l) throw new Error(`Línea ${id} no existe`);
  return l;
}

