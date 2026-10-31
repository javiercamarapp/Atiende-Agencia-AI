// Segmentos RFM sobre los AGREGADOS importados (pedidos, gasto, ultimo pedido) y cuentas de kilo/eventos.
// Fuente distinta de `cfo_clientes_rfm` (que usa orders reales, migracion 095): estos son de confianza menor y NO se mezclan con aquella.
// Puro y determinista: el reloj se inyecta; los umbrales son configurables y todos tienen un valor por omision documentado.

export type SegmentoRfm = "campeon" | "en_riesgo_alto_valor" | "dormido" | "nuevo" | "regular";

export interface ClienteParaSegmento {
  readonly id: string;
  readonly pedidos: number;
  readonly gastoMxn: number;
  readonly ticketMxn: number | null;
  readonly primerPedido: string | null;
  readonly ultimoPedido: string | null;
  /** Kilos pedidos en total si se conocen (cuenta de kilo por volumen); null = no se sabe. */
  readonly kilosTotales?: number | null;
  /** true = hay queja abierta: se EXCLUYE de cualquier lista de reactivacion. */
  readonly revisionHumana?: boolean;
}

export interface UmbralesSegmento {
  /** Dias sin comprar para ser «dormido». */
  readonly diasDormido: number;
  /** Dias sin comprar para «en riesgo» (menor que dormido). */
  readonly diasEnRiesgo: number;
  /** Pedidos minimos del campeon. */
  readonly pedidosCampeon: number;
  /** Dias maximos desde la ultima compra para campeon. */
  readonly diasCampeonReciente: number;
  /** Gasto desde el cual un cliente es «alto valor» (si no, se usa el percentil `percentilAltoValor`). */
  readonly gastoAltoValor: number | null;
  readonly percentilAltoValor: number;
  /** Dias desde el primer pedido para considerarlo «nuevo». */
  readonly diasNuevo: number;
  /** Ticket promedio (MXN) por ENCIMA del cual es candidata a evento. */
  readonly ticketEvento: number;
  /** Kilos acumulados para «cuenta de kilo». */
  readonly kilosCuentaKilo: number;
}

export const UMBRALES_POR_OMISION: UmbralesSegmento = {
  diasDormido: 90,
  diasEnRiesgo: 45,
  pedidosCampeon: 6,
  diasCampeonReciente: 30,
  gastoAltoValor: null,
  percentilAltoValor: 0.75,
  diasNuevo: 30,
  ticketEvento: 2000,
  kilosCuentaKilo: 10,
};

const MS_DIA = 86_400_000;
const dias = (f: string | null, hoy: Date) => (f === null ? null : Math.max(0, Math.floor((hoy.getTime() - Date.parse(`${f.slice(0, 10)}T00:00:00Z`)) / MS_DIA)));

/** Valor del percentil p (0..1) por rango mas cercano, sobre los gastos > 0. Determinista. */
export function percentil(valores: readonly number[], p: number): number | null {
  const v = valores.filter((x) => x > 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]!;
}

export interface ResultadoSegmento {
  readonly id: string;
  readonly segmento: SegmentoRfm;
  readonly diasSinComprar: number | null;
  readonly altoValor: boolean;
  /** Elegible para entrar a una lista de reactivacion (todavia falta el opt-in de marketing, que NUNCA viene del historico). */
  readonly reactivable: boolean;
}

/**
 * Orden de evaluacion (gana el primero):
 *   campeon              >= pedidosCampeon pedidos y compro hace <= diasCampeonReciente
 *   en_riesgo_alto_valor alto valor y sin comprar entre diasEnRiesgo y diasDormido (o mas): hay que recuperarlo
 *   dormido              sin comprar >= diasDormido
 *   nuevo                primer pedido hace <= diasNuevo
 *   regular              el resto
 * Alto valor = gasto >= gastoAltoValor, o >= el percentil `percentilAltoValor` de la cartera si el umbral es null.
 */
export function segmentarRfm(clientes: readonly ClienteParaSegmento[], hoy: Date, u: UmbralesSegmento = UMBRALES_POR_OMISION): ResultadoSegmento[] {
  const corte = u.gastoAltoValor ?? percentil(clientes.map((c) => c.gastoMxn), u.percentilAltoValor);
  return [...clientes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => {
      const sin = dias(c.ultimoPedido, hoy);
      const altoValor = corte !== null && c.gastoMxn >= corte && c.gastoMxn > 0;
      const diasPrimero = dias(c.primerPedido, hoy);
      let segmento: SegmentoRfm = "regular";
      if (c.pedidos >= u.pedidosCampeon && sin !== null && sin <= u.diasCampeonReciente) segmento = "campeon";
      else if (altoValor && sin !== null && sin >= u.diasEnRiesgo) segmento = "en_riesgo_alto_valor";
      else if (sin !== null && sin >= u.diasDormido) segmento = "dormido";
      else if (diasPrimero !== null && diasPrimero <= u.diasNuevo && c.pedidos > 0) segmento = "nuevo";
      return { id: c.id, segmento, diasSinComprar: sin, altoValor, reactivable: c.revisionHumana !== true && (segmento === "en_riesgo_alto_valor" || segmento === "dormido") };
    });
}

export type TipoCuenta = "kilo" | "evento";
export interface CuentaEtiquetada {
  readonly id: string;
  readonly tipos: readonly TipoCuenta[];
  /** Siempre «sugerida»: ninguna etiqueta es definitiva sin accion humana. */
  readonly estado: "sugerida";
}

/** Cuentas de kilo (volumen acumulado) y candidatas a evento (ticket > umbral o kilos altos). Solo SUGIERE; el gerente confirma. */
export function etiquetarCuentas(clientes: readonly ClienteParaSegmento[], u: UmbralesSegmento = UMBRALES_POR_OMISION): CuentaEtiquetada[] {
  const out: CuentaEtiquetada[] = [];
  for (const c of [...clientes].sort((a, b) => a.id.localeCompare(b.id))) {
    const tipos: TipoCuenta[] = [];
    if ((c.kilosTotales ?? 0) >= u.kilosCuentaKilo) tipos.push("kilo");
    if ((c.ticketMxn ?? 0) > u.ticketEvento) tipos.push("evento");
    if (tipos.length > 0) out.push({ id: c.id, tipos, estado: "sugerida" });
  }
  return out;
}

export interface ResumenSegmentos {
  readonly porSegmento: Readonly<Record<SegmentoRfm, number>>;
  readonly reactivables: number;
  readonly cuentasKilo: number;
  readonly candidatasEvento: number;
}

export function resumirSegmentos(clientes: readonly ClienteParaSegmento[], hoy: Date, u: UmbralesSegmento = UMBRALES_POR_OMISION): ResumenSegmentos {
  const seg = segmentarRfm(clientes, hoy, u);
  const porSegmento: Record<SegmentoRfm, number> = { campeon: 0, en_riesgo_alto_valor: 0, dormido: 0, nuevo: 0, regular: 0 };
  for (const s of seg) porSegmento[s.segmento]++;
  const cuentas = etiquetarCuentas(clientes, u);
  return { porSegmento, reactivables: seg.filter((s) => s.reactivable).length, cuentasKilo: cuentas.filter((c) => c.tipos.includes("kilo")).length, candidatasEvento: cuentas.filter((c) => c.tipos.includes("evento")).length };
}
