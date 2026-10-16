// CFO-04 · fórmulas de KPIs y ratios (diseño §4.2). Una función pura por KPI.
//
// Todas reciben SUMAS (o conteos) y devuelven `Cifra`. Si el denominador es 0 (o falta un insumo) devuelven
// `valor: null` con `confianza: "sin_dato"`, NUNCA 0: la UI dice «sin datos».
// Montos: centavos enteros. Porcentajes: número con 1 decimal (18.4 = 18.4 %). Redondeo: half away from zero con
// aritmética entera (ver util.ts). Excepción documentada: `crecimiento` reutiliza `variacionPct` del cierre diario (041),
// que redondea con Math.round (en un empate exacto de signo negativo, -0.05 → -0.0); así el CFO y el cierre coinciden.
import { variacionPct } from "../cierres/cierre.ts";
import type {
  Cifra,
  CfoConfig,
  FilaAgenteDiario,
  FilaCanastaPar,
  FilaCanastaTotales,
  FilaComandasPos,
  FilaCortesias,
  FilaVentasDiarias,
  TipoBaseComparacion,
} from "./tipos.ts";
import { centesimas, cifra, cmp, combinarConfianza, divEntera, mulDiv, pct1, promedioMin1, redondear, sinDato, suma, sumaDecimal2 } from "./util.ts";

const F_VENTAS = "cfo_ventas_diarias";
const F_AGENTE = "cfo_agente_diario";

// ---- Agregadores: filas SQL -> sumas -----------------------------------------------------------------------------------------------------

/** Sumas de ventas de un conjunto de filas `cfo_ventas_diarias` (todo aditivo). */
export interface SumasVentas {
  readonly pedidos: number;
  readonly brutaCentavos: number;
  readonly descPromoCentavos: number;
  readonly descCompCentavos: number;
  readonly netaCentavos: number;
  readonly propinaCentavos: number;
  /** Solo la propina que capturó el agente con tarjeta (la de efectivo no se registra). */
  readonly propinaTarjetaCentavos: number;
  readonly netaTarjetaCentavos: number;
  readonly pedidosTarjeta: number;
  readonly cancelados: number;
  readonly canceladosCentavos: number;
  readonly noRecogidos: number;
  readonly noRecogidosCentavos: number;
  readonly reposiciones: number;
  readonly reposicionUnidades: number;
  readonly entregados: number;
  readonly entregaMinSuma: number;
  readonly entregaTarde: number;
  readonly pedidosDomicilio: number;
  readonly pedidosRecoger: number;
  readonly netaDomicilioCentavos: number;
  readonly netaRecogerCentavos: number;
  /** voice + whatsapp: lo que el agente tomó. */
  readonly pedidosAgente: number;
  readonly netaAgenteCentavos: number;
  /** web + admin: pedidos de otros orígenes (no son «del agente»). */
  readonly pedidosOtrosOrigenes: number;
  readonly netaOtrosOrigenesCentavos: number;
}

export const SUMAS_VENTAS_VACIAS: SumasVentas = Object.freeze({
  pedidos: 0, brutaCentavos: 0, descPromoCentavos: 0, descCompCentavos: 0, netaCentavos: 0, propinaCentavos: 0, propinaTarjetaCentavos: 0,
  netaTarjetaCentavos: 0, pedidosTarjeta: 0, cancelados: 0, canceladosCentavos: 0, noRecogidos: 0, noRecogidosCentavos: 0, reposiciones: 0,
  reposicionUnidades: 0, entregados: 0, entregaMinSuma: 0, entregaTarde: 0, pedidosDomicilio: 0, pedidosRecoger: 0, netaDomicilioCentavos: 0,
  netaRecogerCentavos: 0, pedidosAgente: 0, netaAgenteCentavos: 0, pedidosOtrosOrigenes: 0, netaOtrosOrigenesCentavos: 0,
});

export function sumarVentas(filas: readonly FilaVentasDiarias[]): SumasVentas {
  const s = { ...SUMAS_VENTAS_VACIAS } as { -readonly [K in keyof SumasVentas]: number };
  let minCent = 0; // minutos de entrega en centésimas ENTERAS (la SQL los devuelve numeric con 2 decimales)
  for (const f of filas) {
    s.pedidos += f.pedidos;
    s.brutaCentavos += f.brutaCentavos;
    s.descPromoCentavos += f.descPromoCentavos;
    s.descCompCentavos += f.descCompCentavos;
    s.netaCentavos += f.netaCentavos;
    s.propinaCentavos += f.propinaCentavos;
    if (f.paymentMethod === "tarjeta") {
      s.propinaTarjetaCentavos += f.propinaCentavos;
      s.netaTarjetaCentavos += f.netaCentavos;
      s.pedidosTarjeta += f.pedidos;
    }
    s.cancelados += f.cancelados;
    s.canceladosCentavos += f.canceladosCentavos;
    s.noRecogidos += f.noRecogidos;
    s.noRecogidosCentavos += f.noRecogidosCentavos;
    s.reposiciones += f.reposiciones;
    s.reposicionUnidades += f.reposicionUnidades;
    s.entregados += f.entregados;
    minCent += centesimas(f.entregaMinSuma);
    s.entregaTarde += f.entregaTarde;
    if (f.canal === "domicilio") {
      s.pedidosDomicilio += f.pedidos;
      s.netaDomicilioCentavos += f.netaCentavos;
    } else {
      s.pedidosRecoger += f.pedidos;
      s.netaRecogerCentavos += f.netaCentavos;
    }
    if (f.source === "voice" || f.source === "whatsapp") {
      s.pedidosAgente += f.pedidos;
      s.netaAgenteCentavos += f.netaCentavos;
    } else {
      s.pedidosOtrosOrigenes += f.pedidos;
      s.netaOtrosOrigenesCentavos += f.netaCentavos;
    }
  }
  s.entregaMinSuma = minCent / 100;
  return s;
}

/** Suma de enteros anulables: null solo si NINGÚN elemento tenía dato. */
export function sumaAnulable(xs: ReadonlyArray<number | null>): number | null {
  let alguno = false;
  let s = 0;
  for (const x of xs) if (x != null) { s += x; alguno = true; }
  return alguno ? s : null;
}

export interface SumasAgente {
  readonly waConversacionesNuevas: number;
  readonly waConPedido: number;
  readonly waConHandoff: number;
  readonly waHandoffs: number;
  readonly vozLlamadas: number;
  readonly vozPedidoCreado: number;
  readonly vozEscalado: number;
  readonly vozAbandonado: number;
  readonly vozCentavos: number | null;
  readonly telefoniaCentavos: number | null;
  readonly metaCentavos: number | null;
  readonly llmCentavos: number | null;
  readonly metaEventos: number;
  /** Cuántas filas aportó (0 = no hay ningún dato del agente). */
  readonly filas: number;
}

export function sumarAgente(filas: readonly FilaAgenteDiario[]): SumasAgente {
  return {
    waConversacionesNuevas: suma(filas.map((f) => f.waConversacionesNuevas)),
    waConPedido: suma(filas.map((f) => f.waConPedido)),
    waConHandoff: suma(filas.map((f) => f.waConHandoff)),
    waHandoffs: suma(filas.map((f) => f.waHandoffs)),
    vozLlamadas: suma(filas.map((f) => f.vozLlamadas)),
    vozPedidoCreado: suma(filas.map((f) => f.vozPedidoCreado)),
    vozEscalado: suma(filas.map((f) => f.vozEscalado)),
    vozAbandonado: suma(filas.map((f) => f.vozAbandonado)),
    vozCentavos: sumaAnulable(filas.map((f) => f.costoVozCentavos)),
    telefoniaCentavos: sumaAnulable(filas.map((f) => f.costoTelefoniaCentavos)),
    metaCentavos: sumaAnulable(filas.map((f) => f.costoMetaCentavos)),
    llmCentavos: sumaAnulable(filas.map((f) => f.costoLlmCentavos)),
    metaEventos: suma(filas.map((f) => f.metaEventos)),
    filas: filas.length,
  };
}

export function sumarCortesias(filas: readonly FilaCortesias[]): { reposiciones: number; valorListaCentavos: number; renglonesSinPrecio: number } {
  return {
    reposiciones: suma(filas.map((f) => f.reposiciones)),
    valorListaCentavos: suma(filas.map((f) => f.valorListaCentavos)),
    renglonesSinPrecio: suma(filas.map((f) => f.renglonesSinPrecio)),
  };
}

// ---- Ventas ------------------------------------------------------------------------------------------------------------------------------

export function ventaBruta(s: Pick<SumasVentas, "brutaCentavos">): Cifra {
  return cifra(s.brutaCentavos, "medido", F_VENTAS);
}

export function ventaNeta(s: Pick<SumasVentas, "netaCentavos">): Cifra {
  return cifra(s.netaCentavos, "medido", F_VENTAS);
}

export function descuentoPromocion(s: Pick<SumasVentas, "descPromoCentavos">): Cifra {
  return cifra(s.descPromoCentavos, "medido", `${F_VENTAS} (derivado: Σ renglones − total)`);
}

export function compensacion(s: Pick<SumasVentas, "descCompCentavos">): Cifra {
  return cifra(s.descCompCentavos, "medido", `${F_VENTAS} (derivado: códigos GRACIAS-)`);
}

/** Cortesías (reposiciones a $0) valuadas a PRECIO DE LISTA: siempre estimado. */
export function cortesias(valorListaCentavos: number): Cifra {
  return cifra(valorListaCentavos, "estimado", "cfo_cortesias (precio de lista vigente)");
}

/** (promoción + compensación) / bruta. */
export function descuentoPct(s: Pick<SumasVentas, "descPromoCentavos" | "descCompCentavos" | "brutaCentavos">): Cifra {
  return cifra(pct1(s.descPromoCentavos + s.descCompCentavos, s.brutaCentavos), "medido", F_VENTAS);
}

/** cortesías / bruta (estimado). */
export function cortesiaPct(valorListaCentavos: number, brutaCentavos: number): Cifra {
  return cifra(pct1(valorListaCentavos, brutaCentavos), "estimado", "cfo_cortesias / cfo_ventas_diarias");
}

/** Los precios al público incluyen IVA: IVA = neta × iva/(100+iva). `ivaPct` puede traer decimales (16, 16.5). Estimado. */
export function ivaEstimado(netaCentavos: number | null, ivaPct: number): Cifra {
  if (netaCentavos == null) return sinDato("formula:iva_estimado");
  const p = redondear(ivaPct * 100);
  if (p < 0) return sinDato("formula:iva_estimado");
  return cifra(mulDiv(netaCentavos, p, 10000 + p), "estimado", `formula:neta×${ivaPct}/${100 + ivaPct}`);
}

export function ventaNetaSinIva(netaCentavos: number | null, ivaCentavos: number | null): Cifra {
  if (netaCentavos == null || ivaCentavos == null) return sinDato("formula:neta_sin_iva");
  return cifra(netaCentavos - ivaCentavos, "estimado", "formula:neta−iva_estimado");
}

export function pedidos(s: Pick<SumasVentas, "pedidos">): Cifra {
  return cifra(s.pedidos, "medido", F_VENTAS);
}

/** neta / pedidos. Con 0 pedidos: null (no 0). */
export function ticketPromedio(s: Pick<SumasVentas, "netaCentavos" | "pedidos">): Cifra {
  return s.pedidos > 0 ? cifra(divEntera(s.netaCentavos, s.pedidos), "medido", F_VENTAS) : sinDato(F_VENTAS);
}

/** Mix de canal: pedidos del canal / pedidos totales. */
export function mixCanalPedidos(pedidosCanal: number, pedidosTotales: number): Cifra {
  return cifra(pct1(pedidosCanal, pedidosTotales), "medido", F_VENTAS);
}

/** Mix de canal por ventas: neta del canal / neta total. */
export function mixCanalVentas(netaCanalCentavos: number, netaTotalCentavos: number): Cifra {
  return cifra(pct1(netaCanalCentavos, netaTotalCentavos), "medido", F_VENTAS);
}

// ---- Crecimiento (3 tipos de base) -------------------------------------------------------------------------------------------------------

export interface InsumosBaseComparacion {
  /** Valor del periodo inmediato anterior de la misma longitud. */
  readonly periodoAnterior?: number | null;
  /** Valor del mismo periodo del año pasado. */
  readonly mismoPeriodoAnioPasado?: number | null;
  /** Valores del mismo día (o mismo tramo) de las 4 semanas previas. Los null/ausentes se ignoran. */
  readonly mismoDiaSemanasPrevias?: ReadonlyArray<number | null>;
}

/** Elige la base. Para el promedio de 4 semanas usa solo las semanas con dato (≥ 1); redondea half away from zero. */
export function baseComparacion(tipo: TipoBaseComparacion, insumos: InsumosBaseComparacion): number | null {
  switch (tipo) {
    case "periodo_anterior":
      return insumos.periodoAnterior ?? null;
    case "mismo_periodo_anio_pasado":
      return insumos.mismoPeriodoAnioPasado ?? null;
    case "promedio_mismo_dia_4_semanas": {
      const v = (insumos.mismoDiaSemanasPrevias ?? []).filter((x): x is number => x != null);
      return v.length > 0 ? divEntera(suma(v), v.length) : null;
    }
  }
}

/** (actual − base)/base en %, 1 decimal. Base nula, 0 o negativa: null (nunca «+infinito»). */
export function crecimiento(actual: number | null, base: number | null, tipo: TipoBaseComparacion, fuente = "formula:crecimiento"): Cifra {
  if (actual == null || base == null) return sinDato(`${fuente} (${tipo})`);
  const v = variacionPct(actual, base);
  return cifra(v, "medido", `${fuente} (${tipo})`);
}

// ---- Cancelaciones, entregas, propinas ---------------------------------------------------------------------------------------------------

/** cancelados / (pedidos + cancelados): igual que el cierre diario (041). */
export function cancelacionPct(s: Pick<SumasVentas, "cancelados" | "pedidos">): Cifra {
  return cifra(pct1(s.cancelados, s.pedidos + s.cancelados), "medido", F_VENTAS);
}

/** no_recogidos / (pedidos de recoger + no_recogidos). */
export function noRecogidoPct(s: Pick<SumasVentas, "noRecogidos" | "pedidosRecoger">): Cifra {
  return cifra(pct1(s.noRecogidos, s.pedidosRecoger + s.noRecogidos), "medido", F_VENTAS);
}

/** propina de tarjeta / neta de pedidos con tarjeta. La propina en efectivo NO se registra. */
export function propinaPct(s: Pick<SumasVentas, "propinaTarjetaCentavos" | "netaTarjetaCentavos">): Cifra {
  return cifra(pct1(s.propinaTarjetaCentavos, s.netaTarjetaCentavos), "medido", `${F_VENTAS} (solo tarjeta)`);
}

/** Promedio de minutos de entrega (1 decimal). */
export function entregaPromedioMin(s: Pick<SumasVentas, "entregaMinSuma" | "entregados">): Cifra {
  return cifra(promedioMin1(s.entregaMinSuma, s.entregados), "medido", F_VENTAS);
}

/** % de entregas por encima de la promesa. */
export function entregaTardePct(s: Pick<SumasVentas, "entregaTarde" | "entregados">): Cifra {
  return cifra(pct1(s.entregaTarde, s.entregados), "medido", F_VENTAS);
}

// ---- Agente: tasa de cierre y costo ------------------------------------------------------------------------------------------------------

/** Conversaciones nuevas de WhatsApp con pedido / conversaciones nuevas (cohorte 040). */
export function tasaCierreWhatsApp(s: Pick<SumasAgente, "waConPedido" | "waConversacionesNuevas">): Cifra {
  return cifra(pct1(s.waConPedido, s.waConversacionesNuevas), "medido", F_AGENTE);
}

/** Llamadas con `pedido_creado` / llamadas cerradas (pedido + escalado + abandonado). */
export function tasaCierreVoz(s: Pick<SumasAgente, "vozPedidoCreado" | "vozEscalado" | "vozAbandonado">): Cifra {
  return cifra(pct1(s.vozPedidoCreado, s.vozPedidoCreado + s.vozEscalado + s.vozAbandonado), "medido", F_AGENTE);
}

/** Tasa de cierre combinada (WhatsApp + voz) desde sumas. */
export function tasaCierreAgente(s: SumasAgente): Cifra {
  const cerradasVoz = s.vozPedidoCreado + s.vozEscalado + s.vozAbandonado;
  return cifra(pct1(s.waConPedido + s.vozPedidoCreado, s.waConversacionesNuevas + cerradasVoz), "medido", F_AGENTE);
}

export interface CostoAgente {
  /** Σ de los componentes MEDIDOS. null si ninguno tiene dato. Nunca suma «no medido» como 0. */
  readonly total: Cifra;
  readonly llmTexto: Cifra;
  readonly voz: Cifra;
  readonly telefonia: Cifra;
  /** `sin_dato` («no medido») si hubo 0 eventos de Meta: jamás $0. */
  readonly meta: Cifra;
  readonly metaMedido: boolean;
  /** true si voz y telefonía (y LLM cuando aplica) tienen dato. */
  readonly completo: boolean;
}

/**
 * Costo del agente. El LLM de texto es de la ORGANIZACIÓN: solo entra (`incluirLlm`) en el renglón «No asignado» y el total.
 * La categoría `voz` de core.usage_cost_event NO se suma aparte (ya va en voice_conversation): evita el doble conteo.
 */
export function costoAgente(s: Pick<SumasAgente, "vozCentavos" | "telefoniaCentavos" | "metaCentavos" | "llmCentavos" | "metaEventos">, incluirLlm: boolean): CostoAgente {
  const metaMedido = s.metaEventos > 0;
  const voz = cifra(s.vozCentavos, "medido", "voice_conversation");
  const telefonia = cifra(s.telefoniaCentavos, "medido", "core.usage_cost_event (telefonía)");
  const meta = metaMedido ? cifra(s.metaCentavos, "medido", "core.usage_cost_event (whatsapp)") : sinDato("Meta: no medido");
  const llmTexto = incluirLlm ? cifra(s.llmCentavos, "medido", "core.llm_usage_daily (organización)") : sinDato("LLM de texto: no asignado a sucursal");
  const partes = [voz.valor, telefonia.valor, metaMedido ? meta.valor : null, incluirLlm ? llmTexto.valor : null];
  const total = sumaAnulable(partes);
  return {
    total: cifra(total, "medido", F_AGENTE),
    llmTexto,
    voz,
    telefonia,
    meta,
    metaMedido,
    completo: voz.valor != null && telefonia.valor != null && (!incluirLlm || llmTexto.valor != null),
  };
}

/** Costo de adquisición por pedido del agente (CAC): costo del agente / pedidos del agente. */
export function costoPorPedidoAgente(costoCentavos: number | null, pedidosAgente: number): Cifra {
  if (costoCentavos == null || pedidosAgente <= 0) return sinDato("formula:cac_agente");
  return cifra(divEntera(costoCentavos, pedidosAgente), "medido", "formula:costo_agente/pedidos_agente");
}

// ---- Costos y margen ---------------------------------------------------------------------------------------------------------------------

/** Comisión de terminal = pct × ventas con tarjeta. `pct` null = captura pendiente. */
export function comisionTerminal(pct: number | null, netaTarjetaCentavos: number): Cifra {
  if (pct == null || pct < 0) return sinDato("cfo_config.comision_terminal_pct (captura pendiente)");
  return cifra(mulDiv(netaTarjetaCentavos, redondear(pct * 100), 10000), "estimado", "formula:comision_terminal_pct×ventas_tarjeta");
}

export interface MargenContribucion {
  readonly cifra: Cifra;
  /** Componentes que faltaron: «parcial: faltan food_cost, comision_terminal». */
  readonly faltan: readonly string[];
  readonly parcial: boolean;
}

/**
 * Margen de contribución = neta sin IVA − food cost − costo del agente − comisión de terminal.
 * Con un componente sin dato NO se inventa: se calcula con lo que hay y se declara `parcial` + `faltan`.
 * Sin neta sin IVA no hay margen (null).
 */
export function margenContribucion(entrada: { netaSinIva: Cifra; foodCost: Cifra; costoAgente: Cifra; comisionTerminal: Cifra }): MargenContribucion {
  if (entrada.netaSinIva.valor == null) return { cifra: sinDato("formula:margen_contribucion"), faltan: ["neta_sin_iva"], parcial: true };
  const faltan: string[] = [];
  let m = entrada.netaSinIva.valor;
  const comps: Array<[string, Cifra]> = [["food_cost", entrada.foodCost], ["costo_agente", entrada.costoAgente], ["comision_terminal", entrada.comisionTerminal]];
  const confs = [entrada.netaSinIva.confianza];
  for (const [nombre, c] of comps) {
    if (c.valor == null) faltan.push(nombre);
    else { m -= c.valor; confs.push(c.confianza); }
  }
  return { cifra: cifra(m, combinarConfianza(["estimado", ...confs]), "formula:margen_contribucion"), faltan, parcial: faltan.length > 0 };
}

/** Un monto sobre neta sin IVA, en %: food cost %, prime cost %, costo del agente %, margen %. */
export function pctSobreVentas(montoCentavos: number | null, netaSinIvaCentavos: number | null, fuente: string): Cifra {
  if (montoCentavos == null || netaSinIvaCentavos == null) return sinDato(fuente);
  return cifra(pct1(montoCentavos, netaSinIvaCentavos), "estimado", fuente);
}

/** Punto de equilibrio = costos fijos / margen de contribución %. Con margen ≤ 0 no existe (null). */
export function puntoEquilibrio(fijosCentavos: number | null, margenCentavos: number | null, netaSinIvaCentavos: number | null): Cifra {
  if (fijosCentavos == null || margenCentavos == null || netaSinIvaCentavos == null || margenCentavos <= 0 || netaSinIvaCentavos <= 0) return sinDato("formula:punto_equilibrio");
  return cifra(mulDiv(fijosCentavos, netaSinIvaCentavos, margenCentavos), "estimado", "formula:fijos/margen_contribucion_pct");
}

// ---- Clientes ----------------------------------------------------------------------------------------------------------------------------

/** % de la cohorte con ≥ 1 pedido posterior dentro de N días. */
export function recompraPct(cohorte: number, conRecompra: number): Cifra {
  return cifra(pct1(conRecompra, cohorte), "medido", "cfo_clientes_cohortes");
}

/** Churn = activos al inicio que pasan a perdidos / activos al inicio. */
export function churnPct(activosAlInicio: number, pasanAPerdidos: number): Cifra {
  return cifra(pct1(pasanAPerdidos, activosAlInicio), "medido", "cfo_clientes_resumen");
}

/** % de frecuentes sobre activos. */
export function frecuentesPct(frecuentes: number, activos: number): Cifra {
  return cifra(pct1(frecuentes, activos), "medido", "cfo_clientes_resumen");
}

/** Valor de vida simple = ticket promedio × pedidos por cliente en 12 meses (promedio con decimales). */
export function valorDeVidaSimple(ticketCentavos: number | null, pedidosPorCliente12m: number | null): Cifra {
  if (ticketCentavos == null || pedidosPorCliente12m == null || pedidosPorCliente12m <= 0) return sinDato("formula:ltv_simple");
  return cifra(mulDiv(ticketCentavos, redondear(pedidosPorCliente12m * 100), 100), "medido", "formula:ticket×pedidos_por_cliente_12m");
}

/** Concentración: % de la venta neta del top 10 % de clientes. */
export function concentracionPct(netaTop10pctCentavos: number, netaTotalCentavos: number): Cifra {
  return cifra(pct1(netaTop10pctCentavos, netaTotalCentavos), "medido", "cfo_clientes_resumen");
}

// ---- Productos y canasta -----------------------------------------------------------------------------------------------------------------

export interface SoporteLift {
  /** % con 2 decimales: pedidos con A y B / pedidos. */
  readonly soportePct: number | null;
  /** lift = soporte(A,B) / (soporte(A) × soporte(B)), 2 decimales. */
  readonly lift: number | null;
}

export function soporteLift(pedidosJuntos: number, pedidosA: number, pedidosB: number, pedidosTotales: number): SoporteLift {
  if (pedidosTotales <= 0) return { soportePct: null, lift: null };
  const soportePct = mulDiv(pedidosJuntos, 10000, pedidosTotales) / 100;
  if (pedidosA <= 0 || pedidosB <= 0) return { soportePct, lift: null };
  return { soportePct, lift: mulDiv(pedidosJuntos * pedidosTotales, 100, pedidosA * pedidosB) / 100 };
}

export interface ParCanasta {
  readonly propertyId: string;
  readonly productoA: string;
  readonly productoB: string;
  readonly pedidosJuntos: number;
  readonly soportePct: number;
  readonly lift: number | null;
}

/** Top de pares con soporte ≥ `minSoportePct` (0.5 por omisión), por pedidos juntos desc; empate por ids (estable). */
export function topParesCanasta(pares: readonly FilaCanastaPar[], totales: readonly FilaCanastaTotales[], limite = 20, minSoportePct = 0.5): ParCanasta[] {
  const porSucursal = new Map(totales.map((t) => [t.propertyId, t]));
  const out: ParCanasta[] = [];
  for (const p of pares) {
    const t = porSucursal.get(p.propertyId);
    if (!t) continue;
    const sl = soporteLift(p.pedidosJuntos, t.pedidosConProducto[p.productoA] ?? 0, t.pedidosConProducto[p.productoB] ?? 0, t.pedidosTotales);
    if (sl.soportePct == null || sl.soportePct < minSoportePct) continue;
    out.push({ propertyId: p.propertyId, productoA: p.productoA, productoB: p.productoB, pedidosJuntos: p.pedidosJuntos, soportePct: sl.soportePct, lift: sl.lift });
  }
  out.sort((a, b) => b.pedidosJuntos - a.pedidosJuntos || cmp(a.propertyId, b.propertyId) || cmp(a.productoA, b.productoA) || cmp(a.productoB, b.productoB));
  return out.slice(0, limite);
}

/**
 * Efecto de una promoción: unidades por día en días CON promo vs mismos días de la semana SIN promo (4 semanas).
 * Devuelve la variación % de la tasa diaria. Estimado (atribución, no causalidad). Sin días o sin base: null.
 */
export function efectoPromocion(e: { unidadesConPromo: number; diasConPromo: number; unidadesSinPromo: number; diasSinPromo: number }): Cifra {
  const fuente = "formula:efecto_promocion";
  if (e.diasConPromo <= 0 || e.diasSinPromo <= 0 || e.unidadesSinPromo <= 0) return sinDato(fuente);
  const den = e.unidadesSinPromo * e.diasConPromo;
  const num = e.unidadesConPromo * e.diasSinPromo - den;
  return cifra(mulDiv(num, 1000, den) / 10, "estimado", fuente);
}

/** Venta en riesgo por agotado = unidades por día de negocio (28 d) × precio de lista × días agotado. Estimado. */
export function ventaEnRiesgoAgotado(e: { unidades28d: number; precioListaCentavos: number | null; diasAgotado: number }): Cifra {
  const fuente = "formula:venta_en_riesgo_agotado";
  if (e.precioListaCentavos == null || e.diasAgotado < 0) return sinDato(fuente);
  return cifra(mulDiv(e.unidades28d * e.precioListaCentavos, e.diasAgotado, 28), "estimado", fuente);
}

// ---- SoftRestaurant ----------------------------------------------------------------------------------------------------------------------

export interface SumasComandas {
  readonly encoladas: number;
  readonly confirmadas: number;
  readonly capturadasManual: number;
  readonly capturaManualPendientes: number;
  readonly fallidas: number;
  readonly pendientesEnviadas: number;
  readonly minACapturaSuma: number;
  readonly capturadasConTiempo: number;
  readonly vencidasUmbral: number;
  readonly conFolioPos: number;
  readonly conFolioDeclarado: number;
  /** Modo consolidado de la bandera: `apagado` solo si TODAS las filas lo están. */
  readonly modo: string;
  /** Cuántas sucursales aportan a las tasas (las encendidas) y cuántas hay: la UI rotula «sobre N de M sucursales». */
  readonly sucursalesEncendidas: number;
  readonly sucursalesTotal: number;
}

export function sumarComandas(filas: readonly FilaComandasPos[]): SumasComandas {
  // El envío es una bandera por organización, pero cada fila trae su modo. Una fila «apagado» no encoló nada: no entra a las tasas.
  // El resultado NO depende del orden de las filas: modo = «activo» si alguna lo está, si no «sombra» si alguna lo está, si no «apagado».
  const encendidas = filas.filter((f) => f.modo !== "apagado");
  const modo = encendidas.some((f) => f.modo === "activo") ? "activo" : (encendidas[0]?.modo ?? "apagado");
  const ids = new Set(filas.map((f) => f.propertyId));
  const idsOn = new Set(encendidas.map((f) => f.propertyId));
  return {
    encoladas: suma(encendidas.map((f) => f.encoladas)),
    confirmadas: suma(encendidas.map((f) => f.confirmadas)),
    capturadasManual: suma(encendidas.map((f) => f.capturadasManual)),
    capturaManualPendientes: suma(encendidas.map((f) => f.capturaManualPendientes)),
    fallidas: suma(encendidas.map((f) => f.fallidas)),
    pendientesEnviadas: suma(encendidas.map((f) => f.pendientesEnviadas)),
    minACapturaSuma: sumaDecimal2(encendidas.map((f) => f.minACapturaSuma)),
    capturadasConTiempo: suma(encendidas.map((f) => f.capturadasConTiempo)),
    vencidasUmbral: suma(encendidas.map((f) => f.vencidasUmbral)),
    conFolioPos: suma(encendidas.map((f) => f.conFolioPos)),
    conFolioDeclarado: suma(encendidas.map((f) => f.conFolioDeclarado)),
    modo,
    sucursalesEncendidas: idsOn.size,
    sucursalesTotal: ids.size,
  };
}

/** SR: tasa de captura = (confirmadas + capturadas a mano) / encoladas. Con modo apagado o 0 encoladas: null (no «0 %»). */
export function tasaCapturaSr(s: Pick<SumasComandas, "confirmadas" | "capturadasManual" | "encoladas" | "modo">): Cifra {
  if (s.modo === "apagado") return sinDato("cfo_comandas_pos (envío de comandas apagado)");
  return cifra(pct1(s.confirmadas + s.capturadasManual, s.encoladas), "medido", "cfo_comandas_pos");
}

/** SR: minutos promedio hasta la captura. */
export function minutosACapturaSr(s: Pick<SumasComandas, "minACapturaSuma" | "capturadasConTiempo">): Cifra {
  return cifra(promedioMin1(s.minACapturaSuma, s.capturadasConTiempo), "medido", "cfo_comandas_pos");
}

export type SemaforoCuadre = "verde" | "ambar" | "rojo" | "sin_datos";

export interface CuadreSr {
  /** nuestro − SR (con signo). */
  readonly diferenciaCentavos: number | null;
  /** |nuestro − SR| / SR, 1 decimal. */
  readonly diferenciaPct: number | null;
  readonly diferenciaPedidos: number | null;
  readonly semaforo: SemaforoCuadre;
}

/**
 * Cuadre diario de domicilio (nuestro vs SR importado). Semáforo: verde ≤ verdePct y ≤ verdeCentavos; ámbar ≤ ámbarPct;
 * rojo > ámbarPct o diferencia en pedidos ≥ 2. Sin SR importado: sin_datos.
 */
export function cuadreSr(
  e: { nuestroCentavos: number; srCentavos: number | null; pedidosNuestros?: number | null; ticketsSr?: number | null },
  config: Pick<CfoConfig, "srCuadreVerdePct" | "srCuadreAmbarPct" | "srCuadreVerdeCentavos">,
): CuadreSr {
  if (e.srCentavos == null) return { diferenciaCentavos: null, diferenciaPct: null, diferenciaPedidos: null, semaforo: "sin_datos" };
  const dif = e.nuestroCentavos - e.srCentavos;
  const difPedidos = e.pedidosNuestros != null && e.ticketsSr != null ? e.pedidosNuestros - e.ticketsSr : null;
  const abs = Math.abs(dif);
  const pct = e.srCentavos > 0 ? pct1(abs, e.srCentavos) : null;
  if (e.srCentavos === 0 && e.nuestroCentavos === 0 && (difPedidos == null || difPedidos === 0)) {
    return { diferenciaCentavos: 0, diferenciaPct: null, diferenciaPedidos: difPedidos, semaforo: "sin_datos" };
  }
  // Umbrales por MULTIPLICACIÓN CRUZADA de enteros (|dif|/SR ≤ pct/100), nunca contra el % ya redondeado a 1 decimal:
  // una diferencia de 1.04 % es ámbar aunque `diferenciaPct` se muestre como 1.
  const dentro = (pctUmbral: number): boolean => abs * 10000 <= redondear(pctUmbral * 100) * (e.srCentavos as number);
  let semaforo: SemaforoCuadre;
  if (difPedidos != null && Math.abs(difPedidos) >= 2) semaforo = "rojo";
  else if (pct == null) semaforo = "rojo"; // SR en 0 y nosotros con venta: no cuadra
  else if (dentro(config.srCuadreVerdePct) && abs <= config.srCuadreVerdeCentavos) semaforo = "verde";
  else if (dentro(config.srCuadreAmbarPct)) semaforo = "ambar";
  else semaforo = "rojo";
  return { diferenciaCentavos: dif, diferenciaPct: pct, diferenciaPedidos: difPedidos, semaforo };
}

// ---- Aporte a la variación (para la narrativa) -------------------------------------------------------------------------------------------

export interface AporteSucursal {
  readonly propertyId: string;
  readonly actualCentavos: number;
  readonly baseCentavos: number;
}

export interface AporteVariacion {
  readonly propertyId: string;
  readonly deltaCentavos: number;
  /** % de la variación total que explica esta sucursal (1 decimal). null si la variación total es 0. */
  readonly aportePct: number | null;
}

/** Cuánto de la variación total (actual − base) explica cada sucursal. Con variación total 0: null. */
export function aporteALaVariacion(sucursales: readonly AporteSucursal[]): AporteVariacion[] {
  const deltas = sucursales.map((s) => ({ propertyId: s.propertyId, deltaCentavos: s.actualCentavos - s.baseCentavos }));
  const totalDelta = suma(deltas.map((d) => d.deltaCentavos));
  return deltas.map((d) => ({ ...d, aportePct: totalDelta === 0 ? null : mulDiv(d.deltaCentavos, 1000, totalDelta) / 10 }));
}
