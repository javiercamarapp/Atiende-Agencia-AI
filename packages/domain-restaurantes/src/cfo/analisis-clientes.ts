// CFO «Análisis de clientes» (Fase A, solo lectura): tipos de las filas de la migración 095, afinidad de productos (soporte, confianza y lift) calculada
// en TypeScript sobre `cfo_canasta_pares` (081, sin SQL nuevo) y el armado de la vista de la API.
//
// Principios:
//  - Las definiciones (segmentos, dormido, reactivación, lift) viven en la SQL 095 y en `docs/restaurantes/ANALISIS-CLIENTES.md`; aquí solo se repiten
//    en `DEFINICIONES_ANALISIS_CLIENTES` para que la pantalla las muestre en cada tooltip junto con el periodo.
//  - Sin PII: los clientes viajan con un alias de 8 caracteres (primeros del sha-256 del customer_id) y nunca con nombre, teléfono ni dirección.
//  - Cada sección es independiente: `disponible: false` + `motivo` (base sin migrar, error) sin tumbar el resto de la vista.
//  - Lo que no tiene dato honesto se declara en `pendientes` («no disponible aún: requiere X»), nunca se inventa.
import { pct1 } from "./util.ts";
import type { FilaCanastaPar, FilaCanastaTotales, FilaProducto } from "./tipos.ts";
import type { VistaCfoBase } from "./tipos-api.ts";

// ---- Filas de la migración 095 ---------------------------------------------------------------------------------------------------------

/** Segmentos RFM en el ORDEN de evaluación de la SQL (gana el primero que cumpla). */
export const SEGMENTOS_RFM = ["campeon", "leal", "en_riesgo_alto_valor", "nuevo_prometedor", "dormido", "ocasional"] as const;
export type SegmentoRfm = (typeof SEGMENTOS_RFM)[number];

export type ConsentimientoMarketing = "otorgado" | "revocado" | "sin_registro";
export const CONSENTIMIENTOS_MARKETING: readonly ConsentimientoMarketing[] = ["otorgado", "revocado", "sin_registro"];

export type TipoTortilla = "maiz" | "harina" | "mixta";
export const TIPOS_TORTILLA: readonly TipoTortilla[] = ["maiz", "harina", "mixta"];

/** `cfo_clientes_rfm` -> segmentos. */
export interface FilaSegmentoRfm {
  readonly segmento: SegmentoRfm;
  readonly orden: number;
  readonly clientes: number;
  readonly pedidos: number;
  readonly ventaCentavos: number;
  /** null = segmento sin pedidos (nunca 0). */
  readonly ticketCentavos: number | null;
  readonly recenciaMedianaDias: number | null;
}

export interface ResumenRfm {
  readonly clientesConVenta: number;
  /** Clientes con venta en 2 o más DÍAS distintos del rango (dos ventas el mismo día no son una recompra). */
  readonly clientesRecompra: number;
  /** Clientes con recencia ≤ 30 días contra `hasta`. */
  readonly activos30: number;
  readonly dormidos: number;
  readonly ventaTotalCentavos: number;
  /** Venta del rango de los clientes dormidos o en riesgo de alto valor. */
  readonly ventaEnRiesgoCentavos: number;
}

export interface PuntoPareto {
  readonly clientesPct: number;
  readonly clientes: number;
  readonly ventaPct: number;
}

export interface ParetoRfm {
  readonly puntos: readonly PuntoPareto[];
  /** % de clientes (los de mayor venta) que reúnen el 50 % / 80 % de la venta. null = sin ventas. */
  readonly clientesPara50Pct: number | null;
  readonly clientesPara80Pct: number | null;
}

export interface LecturaRfm {
  readonly disponible: boolean;
  readonly segmentos: readonly FilaSegmentoRfm[];
  readonly resumen: ResumenRfm | null;
  readonly pareto: ParetoRfm | null;
}

/** `cfo_clientes_reactivacion` -> una fila por cliente (alias, sin PII). */
export interface FilaReactivacion {
  readonly alias: string;
  readonly ventas: number;
  readonly ultimaVenta: string;
  readonly diasSinPedir: number;
  /** null = sin intervalo propio (todas sus ventas el mismo día). */
  readonly intervaloMedianoDias: number | null;
  readonly umbralDias: number;
  readonly ventaCentavos: number;
  readonly ticketCentavos: number;
  readonly canalFrecuente: string | null;
  readonly dormido: boolean;
  readonly consentimiento: ConsentimientoMarketing;
  readonly prioridadCentavos: number;
}

export interface LecturaReactivacion {
  readonly disponible: boolean;
  readonly totalElegibles: number;
  readonly mostrados: number;
  readonly ventaEnJuegoCentavos: number;
  readonly dormidos: number;
  readonly consentimiento: { readonly otorgado: number; readonly revocado: number; readonly sinRegistro: number };
  readonly filas: readonly FilaReactivacion[];
}

/** `cfo_intervalo_recompra`: percentiles en días; null = menos de 5 intervalos (muestra insuficiente). */
export interface FilaIntervaloRecompra {
  readonly segmento: "global" | SegmentoRfm;
  readonly clientes: number;
  readonly intervalos: number;
  readonly p25: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
}

/** `cfo_pedidos_tortilla`. */
export interface FilaTortilla {
  readonly tipo: TipoTortilla;
  readonly renglones: number;
  readonly unidades: number;
  readonly pedidos: number;
}

export interface LecturaTortilla {
  readonly disponible: boolean;
  /** Ventas cuyo detalle trae al menos un renglón (las importadas sin detalle quedan fuera). */
  readonly pedidosConItems: number;
  readonly tortilla: readonly FilaTortilla[];
}

// ---- Afinidad de productos (TypeScript puro sobre cfo_canasta_pares) -----------------------------------------------------------------

/** Pedidos mínimos juntos para mostrar un par (k-anonimato: un par visto en menos de 5 pedidos no se publica). */
export const MIN_PEDIDOS_AFINIDAD = 5;
/** Tope por sucursal que se pide a `cfo_canasta_pares` (el máximo que acepta la SQL). */
export const LIMITE_PARES_CANASTA = 500;
export const MAX_PARES_AFINIDAD = 20;

export interface ParAfinidadApi {
  readonly productoA: string;
  readonly nombreA: string;
  readonly productoB: string;
  readonly nombreB: string;
  readonly pedidosJuntos: number;
  /** % de los pedidos del periodo que llevan A y B. */
  readonly soportePct: number;
  /** % de los pedidos con A que también llevan B / de los pedidos con B que también llevan A. */
  readonly confianzaAB: number | null;
  readonly confianzaBA: number | null;
  /** P(A∧B) / (P(A)·P(B)); 1 = independientes, > 1 = se piden juntos más de lo esperado. null = sin base. */
  readonly lift: number | null;
}

export interface AfinidadCalculada {
  readonly pares: readonly ParAfinidadApi[];
  /** Pares con menos de `MIN_PEDIDOS_AFINIDAD` pedidos juntos que NO se muestran (privacidad). */
  readonly ocultosPorPrivacidad: number;
  readonly pedidosTotales: number;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Consolida los pares de las sucursales en alcance (los `pedidosJuntos` SÍ suman entre sucursales) y calcula soporte, confianza y lift sobre el conjunto.
 * Limitación declarada: `cfo_canasta_pares` corta el top POR SUCURSAL (se pide con el máximo de 500) y solo informa `pedidosConProducto` de los productos
 * que aparecen en esos pares; un producto ausente de la lista de una sucursal cuenta 0 ahí, así que en consultas multisucursal el lift es aproximado (el top por sucursal también recorta los pedidos juntos).
 */
export function calcularAfinidad(
  pares: readonly FilaCanastaPar[],
  totales: readonly FilaCanastaTotales[],
  nombres: ReadonlyMap<string, string>,
  limite = MAX_PARES_AFINIDAD,
): AfinidadCalculada {
  const pedidosTotales = totales.reduce((s, t) => s + t.pedidosTotales, 0);
  const conProducto = new Map<string, number>();
  for (const t of totales) for (const [ref, n] of Object.entries(t.pedidosConProducto)) conProducto.set(ref.toLowerCase(), (conProducto.get(ref.toLowerCase()) ?? 0) + n);
  const juntos = new Map<string, { a: string; b: string; n: number }>();
  for (const p of pares) {
    const a = p.productoA.toLowerCase();
    const b = p.productoB.toLowerCase();
    const [x, y] = a < b ? [a, b] : [b, a];
    const k = `${x}\u0000${y}`;
    const previo = juntos.get(k);
    if (previo) previo.n += p.pedidosJuntos;
    else juntos.set(k, { a: x, b: y, n: p.pedidosJuntos });
  }
  const visibles: ParAfinidadApi[] = [];
  let ocultos = 0;
  for (const j of juntos.values()) {
    if (j.n < MIN_PEDIDOS_AFINIDAD) {
      ocultos += 1;
      continue;
    }
    const pa = conProducto.get(j.a) ?? 0;
    const pb = conProducto.get(j.b) ?? 0;
    const lift = pa > 0 && pb > 0 && pedidosTotales > 0 ? Math.round((j.n * pedidosTotales * 100) / (pa * pb)) / 100 : null;
    visibles.push({
      productoA: j.a,
      nombreA: nombres.get(j.a) ?? j.a,
      productoB: j.b,
      nombreB: nombres.get(j.b) ?? j.b,
      pedidosJuntos: j.n,
      soportePct: pct1(j.n, pedidosTotales) ?? 0,
      confianzaAB: pa > 0 ? pct1(j.n, pa) : null,
      confianzaBA: pb > 0 ? pct1(j.n, pb) : null,
      lift,
    });
  }
  visibles.sort((p, q) => (q.lift ?? -1) - (p.lift ?? -1) || q.pedidosJuntos - p.pedidosJuntos || cmp(p.productoA, q.productoA) || cmp(p.productoB, q.productoB));
  return { pares: visibles.slice(0, limite), ocultosPorPrivacidad: ocultos, pedidosTotales };
}

/** `productoRef` en minúsculas -> nombre actual del catálogo (la afinidad compara refs sin distinguir mayúsculas). */
export function nombresPorRef(productos: readonly FilaProducto[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of productos) if (!m.has(p.productoRef.toLowerCase())) m.set(p.productoRef.toLowerCase(), p.nombreActual);
  return m;
}

// ---- Contrato de la API -------------------------------------------------------------------------------------------------------------------

/** Una sección de la vista: con dato, sin migrar o con error. `motivo` se muestra tal cual («no disponible aún: requiere …»). */
export interface SeccionAnalisis<T> {
  readonly disponible: boolean;
  readonly motivo: string | null;
  readonly datos: T | null;
}

export interface ResumenAnalisisClientes {
  readonly clientesConVenta: number;
  readonly activos30: number;
  readonly clientesRecompra: number;
  /** % de los clientes con venta que compraron 2 o más veces en el rango. null = sin clientes. */
  readonly recompraPct: number | null;
  /** Mediana global de días entre compras (null con menos de 5 intervalos). */
  readonly intervaloMedianoDias: number | null;
  readonly dormidos: number;
  readonly ventaTotalCentavos: number;
  readonly ventaEnRiesgoCentavos: number;
}

export interface SegmentosAnalisis {
  readonly segmentos: ReadonlyArray<FilaSegmentoRfm & { readonly etiqueta: string; readonly definicion: string }>;
  /** true = menos de 5 clientes: los quintiles no son estables. */
  readonly pocosClientes: boolean;
}

export interface ReactivacionAnalisis extends Omit<LecturaReactivacion, "disponible"> {
  readonly limite: number;
}

export interface AfinidadAnalisis extends AfinidadCalculada {
  readonly minimoPedidos: number;
  /** true = la consulta abarca más de una sucursal (el lift es aproximado; ver `calcularAfinidad`). */
  readonly multiSucursal: boolean;
}

export interface TortillaAnalisis {
  readonly pedidosConItems: number;
  readonly tortilla: ReadonlyArray<FilaTortilla & { readonly etiqueta: string }>;
  /** Salsas, omisiones y notas viven como texto libre en el pedido: no hay dato estructurado. */
  readonly salsas: { readonly disponible: false; readonly motivo: string };
}

export interface PendienteAnalisis {
  readonly clave: string;
  readonly titulo: string;
  /** «no disponible aún: requiere …». */
  readonly motivo: string;
}

export interface AnalisisClientesVista extends VistaCfoBase {
  /** El periodo de la consulta; la recencia se mide contra `periodo.hasta`. */
  readonly secciones: {
    readonly resumen: SeccionAnalisis<ResumenAnalisisClientes>;
    readonly segmentos: SeccionAnalisis<SegmentosAnalisis>;
    readonly concentracion: SeccionAnalisis<ParetoRfm>;
    readonly intervalo: SeccionAnalisis<readonly FilaIntervaloRecompra[]>;
    readonly reactivacion: SeccionAnalisis<ReactivacionAnalisis>;
    readonly afinidad: SeccionAnalisis<AfinidadAnalisis>;
    readonly tortilla: SeccionAnalisis<TortillaAnalisis>;
  };
  readonly pendientes: readonly PendienteAnalisis[];
  readonly definiciones: Readonly<Record<string, string>>;
}

export const ETIQUETAS_SEGMENTO: Readonly<Record<SegmentoRfm, string>> = {
  campeon: "Campeones",
  leal: "Leales",
  en_riesgo_alto_valor: "En riesgo de alto valor",
  nuevo_prometedor: "Nuevos prometedores",
  dormido: "Dormidos (resto)",
  ocasional: "Ocasionales",
};

export const ETIQUETAS_TORTILLA: Readonly<Record<TipoTortilla, string>> = { maiz: "Maíz", harina: "Harina", mixta: "Mixta" };

/** Definiciones que la pantalla muestra en cada tooltip junto con el periodo (misma redacción que el comentario de la migración 095). */
export const DEFINICIONES_ANALISIS_CLIENTES: Readonly<Record<string, string>> = {
  resumen:
    "Clientes con al menos una venta con cliente identificado en el periodo. Recompra = clientes que compraron en 2 o más días distintos ÷ clientes (dos ventas el mismo día no cuentan). Dormidos = todos los que cumplen la definición de dormido, aunque su segmento sea otro (campeón, leal o en riesgo). Intervalo mediano = mediana de días entre compras. Venta en riesgo = venta del periodo de los clientes dormidos o en riesgo de alto valor.",
  recencia: "Días entre la última venta del cliente y el último día del periodo consultado (no «hoy»).",
  frecuencia: "Ventas del cliente en el periodo. Puntaje fijo: 1, 2, 3 o 4 o más ventas.",
  monetario: "Venta neta del cliente en el periodo. Recencia y monto se puntúan de 1 a 5 por quintil entre los clientes consultados; los empates reciben el mismo puntaje.",
  dormido: "Cliente con 2 o más ventas que lleva sin pedir más de 30 días y más de 1.5 veces su intervalo mediano propio. Es la única definición de «dormido». Como segmento, «Dormidos (resto)» incluye solo a quien no cayó antes en campeón, leal o en riesgo de alto valor; un campeón o un leal también puede estar dormido.",
  campeon: "4 o más ventas y recencia de 4 o 5.",
  leal: "3 o más ventas y recencia de 3 o más (si no es campeón).",
  en_riesgo_alto_valor: "Recencia de 1 o 2 y monto de 4 o 5.",
  nuevo_prometedor: "Una sola venta y recencia de 4 o 5.",
  ocasional: "Todo lo demás, incluido quien tiene una sola venta antigua (no tiene ritmo propio para llamarlo dormido).",
  concentracion: "Porcentaje de la venta que reúne el 10 %, 20 %… 100 % de los clientes con más venta del periodo.",
  reactivacion: "Clientes con 2 o más ventas cuyo tiempo sin pedir supera su ritmo (más de 14 días y 1.5 veces su intervalo mediano propio) o pasa de 30 días.",
  prioridad: "Venta del periodo × el menor entre 1 y (umbral ÷ días sin pedir). Heurística simple para ordenar, no una probabilidad calibrada.",
  consentimiento: "Estado del consentimiento de mensajes promocionales por WhatsApp. Solo se muestra: esta pantalla no envía nada.",
  intervalo: "Días entre días consecutivos con venta de un mismo cliente. Con menos de 5 intervalos no se calcula el percentil.",
  soporte: "Porcentaje de los pedidos del periodo que llevan los dos productos.",
  confianza: "De los pedidos que llevan un producto, porcentaje que también lleva el otro.",
  lift: "Soporte ÷ (porcentaje de pedidos con A × porcentaje con B). 1 = independientes; 2 = se piden juntos el doble de lo esperado. Solo pares con 5 o más pedidos.",
  tortilla: "Renglones de pedidos vendidos con tortilla de maíz, harina o mixta (campo estructurado del pedido). Salsas y omisiones no están estructuradas.",
};

export const PENDIENTES_ANALISIS_CLIENTES: readonly PendienteAnalisis[] = [
  { clave: "quejas_por_tipo", titulo: "Quejas por tipo", motivo: "No disponible aún: requiere un catálogo estructurado de motivos de queja (hoy solo hay texto libre de incidencias)." },
  { clave: "respuesta_humana", titulo: "Respuesta humana por hora", motivo: "No disponible aún: requiere marcas de tiempo por mensaje en las conversaciones (hoy solo se mide el tiempo de toma de un handoff)." },
  { clave: "segmentos_por_producto", titulo: "Segmentos que compran cada producto", motivo: "No disponible aún: requiere cruzar el segmento de cada cliente con el detalle de sus pedidos (fase posterior)." },
  { clave: "salsas_omisiones", titulo: "Salsas y omisiones", motivo: "No disponible aún: requiere decidir un campo estructurado para salsas y omisiones (hoy viven como texto libre en las notas)." },
  { clave: "historial_importado", titulo: "Historial importado de chats", motivo: "No disponible aún: requiere el importador de historial (fase B)." },
];

const MOTIVO_095 = "No disponible aún: requiere aplicar la actualización 095 de la base de datos.";

export interface EntradaAnalisis {
  readonly rfm: LecturaRfm;
  readonly intervalo: { readonly disponible: boolean; readonly filas: readonly FilaIntervaloRecompra[] };
  readonly reactivacion: LecturaReactivacion;
  readonly tortilla: LecturaTortilla;
  readonly canasta: { readonly disponible: boolean; readonly pares: readonly FilaCanastaPar[]; readonly totales: readonly FilaCanastaTotales[] };
  readonly nombres: ReadonlyMap<string, string>;
  readonly limiteReactivacion: number;
  readonly multiSucursal: boolean;
  /** Secciones cuya lectura falló con un error no recuperable (se muestran como no disponibles con motivo de error). */
  readonly conError: ReadonlySet<"rfm" | "intervalo" | "reactivacion" | "tortilla" | "afinidad">;
}

function seccion<T>(ok: boolean, error: boolean, armar: () => T, sinMigrar: string): SeccionAnalisis<T> {
  if (error) return { disponible: false, motivo: "No se pudo leer esta sección. Intente de nuevo en unos minutos.", datos: null };
  if (!ok) return { disponible: false, motivo: sinMigrar, datos: null };
  return { disponible: true, motivo: null, datos: armar() };
}

/** Arma las secciones de la vista a partir de las lecturas (todo puro: sin reloj, sin I/O). */
export function armarSeccionesAnalisis(e: EntradaAnalisis): AnalisisClientesVista["secciones"] {
  const global = e.intervalo.filas.find((f) => f.segmento === "global");
  const rfm = e.rfm;
  const resumen = seccion(rfm.disponible && rfm.resumen !== null, e.conError.has("rfm"), (): ResumenAnalisisClientes => {
    const r = rfm.resumen as ResumenRfm;
    return {
      clientesConVenta: r.clientesConVenta,
      activos30: r.activos30,
      clientesRecompra: r.clientesRecompra,
      recompraPct: pct1(r.clientesRecompra, r.clientesConVenta),
      intervaloMedianoDias: e.intervalo.disponible ? (global?.p50 ?? null) : null,
      dormidos: r.dormidos,
      ventaTotalCentavos: r.ventaTotalCentavos,
      ventaEnRiesgoCentavos: r.ventaEnRiesgoCentavos,
    };
  }, MOTIVO_095);
  const segmentos = seccion(rfm.disponible, e.conError.has("rfm"), (): SegmentosAnalisis => ({
    segmentos: rfm.segmentos.map((s) => ({ ...s, etiqueta: ETIQUETAS_SEGMENTO[s.segmento], definicion: DEFINICIONES_ANALISIS_CLIENTES[s.segmento] ?? "" })),
    pocosClientes: (rfm.resumen?.clientesConVenta ?? 0) < 5,
  }), MOTIVO_095);
  const concentracion = seccion(rfm.disponible && rfm.pareto !== null, e.conError.has("rfm"), () => rfm.pareto as ParetoRfm, MOTIVO_095);
  const intervalo = seccion(e.intervalo.disponible, e.conError.has("intervalo"), () => e.intervalo.filas, MOTIVO_095);
  const reactivacion = seccion(e.reactivacion.disponible, e.conError.has("reactivacion"), (): ReactivacionAnalisis => {
    const { disponible: _d, ...resto } = e.reactivacion;
    return { ...resto, limite: e.limiteReactivacion };
  }, "No disponible aún: requiere aplicar la actualización 095 de la base de datos (y la 052 de marketing para el consentimiento).");
  const afinidad = seccion(e.canasta.disponible, e.conError.has("afinidad"), (): AfinidadAnalisis => ({
    ...calcularAfinidad(e.canasta.pares, e.canasta.totales, e.nombres),
    minimoPedidos: MIN_PEDIDOS_AFINIDAD,
    multiSucursal: e.multiSucursal,
  }), "No disponible aún: requiere aplicar la actualización 081 de la base de datos.");
  const tortilla = seccion(e.tortilla.disponible, e.conError.has("tortilla"), (): TortillaAnalisis => ({
    pedidosConItems: e.tortilla.pedidosConItems,
    tortilla: e.tortilla.tortilla.map((t) => ({ ...t, etiqueta: ETIQUETAS_TORTILLA[t.tipo] })),
    salsas: { disponible: false, motivo: "No disponible aún: requiere decidir un campo estructurado para salsas y omisiones (hoy son texto libre)." },
  }), MOTIVO_095);
  return { resumen, segmentos, concentracion, intervalo, reactivacion, afinidad, tortilla };
}
