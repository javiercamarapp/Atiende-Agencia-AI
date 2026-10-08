// CFO-04 · motor de hallazgos «Lo más importante» (diseño §4.4): 14 tipos, ordenados por impacto en pesos o por urgencia.
//
// Cada hallazgo lleva: título, cifra, comparación, por qué importa, acción sugerida (texto + ruta interna de drill-down),
// impacto en centavos (o null si no es monetizable), urgencia y las fuentes de datos. Los umbrales vienen de `CfoConfig`.
// Todo es determinista: textos en español de México (de usted), formato a mano (sin `toLocale*`), sin reloj (recibe `ahora`).
// Reglas de disparo: ESTRICTAS donde el diseño dice «<» o «>» y con «≥» donde dice «≥»; justo bajo el umbral NO dispara.
import { ventaEnRiesgoAgotado, type CuadreSr, type SumasAgente, type SumasComandas, type SumasVentas } from "./formulas.ts";
import type { CfoConfig, Cifra, FilaAgotado, FilaEscalacionHora, SucursalCfo } from "./tipos.ts";
import { cifra, cmp, diaSemanaIso, difFraccionesGE, divEntera, formatoCentavos, formatoEntero, formatoMinutos, formatoPct, formatoPuntos, mulDiv, nombreDiaPlural, pct1, redondear } from "./util.ts";

export type TipoHallazgo =
  | "caida_ventas"
  | "ticket_baja"
  | "cancelacion_alta"
  | "descuento_fuera_rango"
  | "compensaciones_inusuales"
  | "costo_agente_alto"
  | "cierre_agente_bajo"
  | "entrega_lenta"
  | "frecuentes_dormidos"
  | "agotado_estrella"
  | "comandas_sin_capturar"
  | "escalaciones_pico"
  | "participacion_cae"
  | "descuadre_sr";

export const TIPOS_HALLAZGO: readonly TipoHallazgo[] = [
  "caida_ventas", "ticket_baja", "cancelacion_alta", "descuento_fuera_rango", "compensaciones_inusuales", "costo_agente_alto", "cierre_agente_bajo",
  "entrega_lenta", "frecuentes_dormidos", "agotado_estrella", "comandas_sin_capturar", "escalaciones_pico", "participacion_cae", "descuadre_sr",
];

export type Urgencia = "alta" | "media" | "baja";
export type CriterioOrden = "impacto" | "urgencia";

export interface AccionHallazgo {
  readonly texto: string;
  /** Ruta interna relativa a /restaurantes/:orgSlug (drill-down). */
  readonly ruta: string;
}

export interface Hallazgo {
  /** `${tipo}:${propertyId ?? "org"}`: único por tipo × sucursal. */
  readonly id: string;
  readonly tipo: TipoHallazgo;
  readonly propertyId: string | null;
  readonly sucursal: string | null;
  readonly titulo: string;
  readonly cifra: Cifra;
  readonly cifraTexto: string;
  readonly comparacion: string;
  readonly porQueImporta: string;
  readonly accion: AccionHallazgo;
  /** Centavos que está en juego; null si no es monetizable. */
  readonly impactoCentavos: number | null;
  readonly urgencia: Urgencia;
  readonly fuentes: readonly string[];
}

/** Métricas de UNA sucursal (todas son sumas; las bases ya vienen promediadas con `promediarSumasVentas`/`promediarSumasAgente`). */
export interface MetricasSucursalHallazgos {
  readonly propertyId: string;
  readonly actual: SumasVentas;
  /** Promedio del mismo día (o tramo) de las 4 semanas previas. null = sin base. */
  readonly base4Semanas: SumasVentas | null;
  /** Periodo inmediato anterior (para la participación). */
  readonly anterior: SumasVentas | null;
  readonly cortesiasCentavos: number;
  readonly cortesiasBase4SemanasCentavos: number | null;
  readonly agente: SumasAgente | null;
  readonly agenteBase4Semanas: SumasAgente | null;
  readonly costoAgenteCentavos: number | null;
  readonly costoAgenteBase4SemanasCentavos: number | null;
  /** p90 histórico propio del descuento %, si se conoce. */
  readonly descuentoPctP90Historico: number | null;
  /** p90 de entrega (no aditivo), minutos. */
  readonly entregaP90Min: number | null;
  /** Clientes frecuentes sin pedir ≥ 30 días y cuántos pedidos hicieron en los últimos 90 días. */
  readonly frecuentesDormidos: { readonly clientes: number; readonly pedidos90d: number } | null;
  readonly agotados: readonly FilaAgotado[];
  readonly comandas: SumasComandas | null;
  readonly escalacionesPorFranja: readonly FilaEscalacionHora[];
  /** Cuadre del domicilio con SR (solo si hay importación). */
  readonly cuadreSr: CuadreSr | null;
}

export interface EntradaHallazgos {
  /** Reloj inyectado: se usa para saber qué está agotado «hoy». */
  readonly ahora: Date;
  readonly periodo: { readonly desde: string; readonly hasta: string };
  readonly sucursales: readonly SucursalCfo[];
  readonly metricas: readonly MetricasSucursalHallazgos[];
  /** Umbral absoluto opcional del costo del agente por pedido (centavos). */
  readonly costoAgentePedidoMaxCentavos?: number | null;
  /** Mínimo de pedidos para evaluar el ticket (default 30). */
  readonly pedidosMinimosTicket?: number;
}

// ---- Promedios de bases (4 semanas) ------------------------------------------------------------------------------------------------------

/** Promedio campo a campo (entero, half away from zero) de varias sumas. null si la lista está vacía. */
export function promediarSumasVentas(lista: readonly SumasVentas[]): SumasVentas | null {
  if (lista.length === 0) return null;
  const out: Record<string, number> = {};
  for (const k of Object.keys(lista[0]!) as Array<keyof SumasVentas>) out[k] = divEntera(lista.reduce((s, x) => s + x[k], 0), lista.length);
  return out as unknown as SumasVentas;
}

export function promediarSumasAgente(lista: readonly SumasAgente[]): SumasAgente | null {
  if (lista.length === 0) return null;
  const out: Record<string, number | null> = {};
  for (const k of Object.keys(lista[0]!) as Array<keyof SumasAgente>) {
    const vals = lista.map((x) => x[k]).filter((v): v is number => v != null);
    out[k] = vals.length === 0 ? null : divEntera(vals.reduce((s, v) => s + v, 0), vals.length);
  }
  return out as unknown as SumasAgente;
}

// ---- Utilidades --------------------------------------------------------------------------------------------------------------------------

export function rutaCfo(pestana: string, params: Readonly<Record<string, string | undefined>> = {}): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
    .join("&");
  return `/cfo/${pestana}${q ? `?${q}` : ""}`;
}

const ORDEN_URGENCIA: Readonly<Record<Urgencia, number>> = { alta: 3, media: 2, baja: 1 };

/** Mediana de fracciones n/d con BigInt exacto (en tamaño par, el promedio de las dos centrales). Devuelve una fracción de enteros seguros. */
function medianaFraccion(fs: ReadonlyArray<{ n: number; d: number }>): { n: number; d: number } | null {
  if (fs.length === 0) return null;
  const o = [...fs].sort((a, b) => {
    const l = BigInt(a.n) * BigInt(b.d);
    const r = BigInt(b.n) * BigInt(a.d);
    return l < r ? -1 : l > r ? 1 : 0;
  });
  const m = Math.floor(o.length / 2);
  if (o.length % 2 === 1) return o[m]!;
  const x = o[m - 1]!;
  const y = o[m]!;
  return { n: x.n * y.d + y.n * x.d, d: 2 * x.d * y.d };
}

function ticketDe(s: Pick<SumasVentas, "netaCentavos" | "pedidos">): number | null {
  return s.pedidos > 0 ? divEntera(s.netaCentavos, s.pedidos) : null;
}

function descPct(s: SumasVentas): number | null {
  return pct1(s.descPromoCentavos + s.descCompCentavos, s.brutaCentavos);
}

function cierreDe(a: SumasAgente): { tasa: number | null; conversaciones: number; cerrados: number } {
  const cerradasVoz = a.vozPedidoCreado + a.vozEscalado + a.vozAbandonado;
  const conv = a.waConversacionesNuevas + cerradasVoz;
  const cerrados = a.waConPedido + a.vozPedidoCreado;
  return { tasa: pct1(cerrados, conv), conversaciones: conv, cerrados };
}

function etiquetaBase(periodo: { desde: string; hasta: string }): string {
  return periodo.desde === periodo.hasta ? `su promedio de los ${nombreDiaPlural(diaSemanaIso(periodo.desde))}` : "su promedio de las 4 semanas previas";
}

// ---- Detección ---------------------------------------------------------------------------------------------------------------------------

/**
 * Evalúa los 14 tipos para cada sucursal. Devuelve la lista SIN ordenar ni recortar (ver `ordenarHallazgos`).
 * Las reglas de disparo y el impacto son los de §4.4 del diseño.
 */
export function detectarHallazgos(entrada: EntradaHallazgos, config: CfoConfig): Hallazgo[] {
  const nombre = new Map(entrada.sucursales.map((s) => [s.propertyId, s.nombre]));
  const nom = (id: string): string => nombre.get(id) ?? id;
  const out: Hallazgo[] = [];
  const { desde, hasta } = entrada.periodo;
  const pedidosMinTicket = entrada.pedidosMinimosTicket ?? 30;
  const baseTxt = etiquetaBase(entrada.periodo);
  const ruta = (pestana: string, id: string): string => rutaCfo(pestana, { sucursal: id, desde, hasta });
  const push = (h: Omit<Hallazgo, "id" | "sucursal"> & { propertyId: string }): void => {
    out.push({ ...h, id: `${h.tipo}:${h.propertyId}`, sucursal: nom(h.propertyId) });
  };

  // Mediana de cancelación % entre sucursales (para cancelacion_alta).
  // Todo se compara como FRACCIÓN EXACTA (BigInt), nunca contra porcentajes ya redondeados a 1 decimal.
  const fracs = entrada.metricas.map((m) => ({ n: m.actual.cancelados, d: m.actual.pedidos + m.actual.cancelados })).filter((f) => f.d > 0);
  const medianaRac = medianaFraccion(fracs);
  const medianaCancel = medianaRac ? (medianaRac.n / medianaRac.d) * 100 : null;

  // Participación (necesita todas las sucursales).
  const totalActual = entrada.metricas.reduce((s, m) => s + m.actual.netaCentavos, 0);
  const totalAnterior = entrada.metricas.reduce((s, m) => s + (m.anterior?.netaCentavos ?? 0), 0);

  for (const m of entrada.metricas) {
    const id = m.propertyId;
    const n = nom(id);
    const a = m.actual;
    const b = m.base4Semanas;

    // 1) caida_ventas: neta < base × (1 − caida%)
    if (b && b.netaCentavos > 0) {
      const factor = 10000 - redondear(config.caidaPct * 100);
      if (a.netaCentavos * 10000 < b.netaCentavos * factor) {
        const caida = pct1(b.netaCentavos - a.netaCentavos, b.netaCentavos) ?? 0;
        push({
          tipo: "caida_ventas", propertyId: id,
          titulo: `${n} cayó ${formatoPct(caida)} vs ${baseTxt}`,
          cifra: cifra(-caida, "medido", "cfo_ventas_diarias"), cifraTexto: `-${formatoPct(caida)}`,
          comparacion: `Vendió ${formatoCentavos(a.netaCentavos)} contra ${formatoCentavos(b.netaCentavos)} de ${baseTxt}.`,
          porQueImporta: `Son ${formatoCentavos(b.netaCentavos - a.netaCentavos)} menos de lo que suele vender; si continúa, afecta su margen y su flujo.`,
          accion: { texto: `Revise por canal y por hora cuándo se perdió la venta en ${n}.`, ruta: ruta("ventas", id) },
          impactoCentavos: b.netaCentavos - a.netaCentavos, urgencia: caida >= 30 ? "alta" : "media", fuentes: ["cfo_ventas_diarias"],
        });
      }
    }

    // 2) ticket_baja: ticket < base × (1 − ticket_baja%), con ≥ 30 pedidos
    const tk = ticketDe(a);
    const tkB = b ? ticketDe(b) : null;
    if (tk != null && tkB != null && a.pedidos >= pedidosMinTicket && tk * 10000 < tkB * (10000 - redondear(config.ticketBajaPct * 100))) {
      const baja = pct1(tkB - tk, tkB) ?? 0;
      push({
        tipo: "ticket_baja", propertyId: id,
        titulo: `El ticket promedio de ${n} bajó ${formatoPct(baja)}`,
        cifra: cifra(tk, "medido", "cfo_ventas_diarias"), cifraTexto: formatoCentavos(tk),
        comparacion: `Ticket de ${formatoCentavos(tk)} contra ${formatoCentavos(tkB)} en las 4 semanas previas, con ${formatoEntero(a.pedidos)} pedidos.`,
        porQueImporta: "Cada cliente gasta menos por pedido: puede ser menos platillos por canasta o más promociones.",
        accion: { texto: "Revise la canasta y el efecto de las promociones.", ruta: ruta("platillos", id) },
        impactoCentavos: (tkB - tk) * a.pedidos, urgencia: "media", fuentes: ["cfo_ventas_diarias"],
      });
    }

    // 3) cancelacion_alta: cancelación % ≥ k × mediana de sucursales y ≥ 5 cancelados
    const cp = pct1(a.cancelados, a.pedidos + a.cancelados);
    const dCancel = a.pedidos + a.cancelados;
    if (cp != null && medianaRac && medianaCancel != null && a.cancelados >= 5
      && BigInt(a.cancelados) * BigInt(medianaRac.d) * 100n >= BigInt(redondear(config.cancelacionXMediana * 100)) * BigInt(medianaRac.n) * BigInt(dCancel)) {
      const esperados = redondear((medianaCancel / 100) * (a.pedidos + a.cancelados));
      const tkc = tk ?? 0;
      const veces = medianaCancel > 0 ? `${(Math.round((cp / medianaCancel) * 10) / 10).toFixed(1)} veces la mediana` : "mientras la mediana de sus sucursales es 0 %";
      push({
        tipo: "cancelacion_alta", propertyId: id,
        titulo: `${n} cancela ${formatoPct(cp)} de sus pedidos`,
        cifra: cifra(cp, "medido", "cfo_ventas_diarias"), cifraTexto: formatoPct(cp),
        comparacion: `${formatoEntero(a.cancelados)} cancelados: ${veces} (${formatoPct(medianaCancel)}).`,
        porQueImporta: "Cada cancelación es venta perdida y trabajo de cocina desperdiciado.",
        accion: { texto: "Revise los motivos de cancelación y los tiempos de esa sucursal.", ruta: rutaCfo("ventas", { sucursal: id, desde, hasta, status: "cancelado" }) },
        impactoCentavos: Math.max(0, a.cancelados - esperados) * tkc, urgencia: "alta", fuentes: ["cfo_ventas_diarias"],
      });
    }

    // 4) descuento_fuera_rango: descuento % > tope o > p90 histórico propio
    const dp = descPct(a);
    if (dp != null) {
      const topes: number[] = [config.descuentoMaxPct];
      if (m.descuentoPctP90Historico != null && m.descuentoPctP90Historico > 0) topes.push(m.descuentoPctP90Historico); // un p90 de 0 no es un tope real
      const tope = Math.min(...topes);
      const descTotal = a.descPromoCentavos + a.descCompCentavos;
      // descuento/bruta > tope %  <=>  descuento × 10000 > tope×100 × bruta (enteros)
      if (BigInt(descTotal) * 10000n > BigInt(redondear(tope * 100)) * BigInt(a.brutaCentavos)) {
        const permitido = mulDiv(a.brutaCentavos, redondear(tope * 100), 10000);
        push({
          tipo: "descuento_fuera_rango", propertyId: id,
          titulo: `${n} regaló ${formatoPct(dp)} en descuentos`,
          cifra: cifra(dp, "medido", "cfo_ventas_diarias"), cifraTexto: formatoPct(dp),
          comparacion: `Su límite es ${formatoPct(tope)}; ${formatoCentavos(a.descPromoCentavos + a.descCompCentavos)} descontados sobre ${formatoCentavos(a.brutaCentavos)} de venta bruta.`,
          porQueImporta: "El descuento sale directo de su margen; fuera de rango suele indicar promociones mal configuradas o abuso de códigos.",
          accion: { texto: "Revise las promociones y los códigos aplicados.", ruta: rutaCfo("ventas", { sucursal: id, desde, hasta, con_descuento: "1" }) },
          impactoCentavos: descTotal - permitido, urgencia: "media", fuentes: ["cfo_ventas_diarias"],
        });
      }
    }

    // 5) compensaciones_inusuales: (compensaciones + cortesías) ≥ 2 × su media de 4 semanas, y al menos $100 por encima
    if (b && m.cortesiasBase4SemanasCentavos != null) {
      const comp = a.descCompCentavos + m.cortesiasCentavos;
      const media = b.descCompCentavos + m.cortesiasBase4SemanasCentavos;
      if (comp >= 2 * media && comp - media >= 10000) {
        push({
          tipo: "compensaciones_inusuales", propertyId: id,
          titulo: `Las compensaciones de ${n} se duplicaron`,
          cifra: cifra(comp, "estimado", "cfo_ventas_diarias + cfo_cortesias"), cifraTexto: formatoCentavos(comp),
          comparacion: `${formatoCentavos(comp)} en compensaciones y cortesías contra ${formatoCentavos(media)} de promedio en 4 semanas (las cortesías están a precio de lista).`,
          porQueImporta: "Son reposiciones y descuentos por mala experiencia: señalan fallas de servicio o de cocina.",
          accion: { texto: "Revise los pedidos compensados y su causa.", ruta: rutaCfo("ventas", { sucursal: id, desde, hasta, es_compensacion: "1" }) },
          impactoCentavos: comp - media, urgencia: "media", fuentes: ["cfo_ventas_diarias", "cfo_cortesias"],
        });
      }
    }

    // 6) costo_agente_alto: CAC ↑ ≥ costo_agente_alza% vs 4 semanas, o > umbral absoluto
    if (m.agente && m.costoAgenteCentavos != null && a.pedidosAgente > 0) {
      const cac = divEntera(m.costoAgenteCentavos, a.pedidosAgente);
      const cacB = m.costoAgenteBase4SemanasCentavos != null && b && b.pedidosAgente > 0 ? divEntera(m.costoAgenteBase4SemanasCentavos, b.pedidosAgente) : null;
      const sube = cacB != null && cacB > 0 && cac * 100 >= cacB * (100 + redondear(config.costoAgenteAlzaPct));
      const sobreUmbral = entrada.costoAgentePedidoMaxCentavos != null && cac > entrada.costoAgentePedidoMaxCentavos;
      if (sube || sobreUmbral) {
        const ref = sube && cacB != null ? cacB : (entrada.costoAgentePedidoMaxCentavos as number);
        push({
          tipo: "costo_agente_alto", propertyId: id,
          titulo: sube && cacB != null ? `El costo del agente por pedido en ${n} subió ${formatoPct(pct1(cac - cacB, cacB) ?? 0)}` : `El costo del agente por pedido en ${n} pasó su límite`,
          cifra: cifra(cac, "medido", "cfo_agente_diario"), cifraTexto: formatoCentavos(cac),
          comparacion: sube && cacB != null ? `${formatoCentavos(cac)} por pedido contra ${formatoCentavos(cacB)} en las 4 semanas previas (sin costo de Meta, que no se mide).` : `${formatoCentavos(cac)} por pedido; su límite es ${formatoCentavos(ref)}.`,
          porQueImporta: "Cada pedido que toma el agente cuesta más; puede haber llamadas largas o conversaciones que no cierran.",
          accion: { texto: "Revise la operación del agente: llamadas largas y escalaciones.", ruta: ruta("operacion", id) },
          impactoCentavos: Math.max(0, cac - ref) * a.pedidosAgente, urgencia: "media", fuentes: ["cfo_agente_diario", "cfo_ventas_diarias"],
        });
      }
    }

    // 7) cierre_agente_bajo: tasa de cierre ↓ ≥ cierre_baja_pp vs 4 semanas
    if (m.agente && m.agenteBase4Semanas) {
      const c = cierreDe(m.agente);
      const cb = cierreDe(m.agenteBase4Semanas);
      if (c.tasa != null && cb.tasa != null && c.conversaciones > 0 && cb.conversaciones > 0
        && difFraccionesGE(cb.cerrados, cb.conversaciones, c.cerrados, c.conversaciones, redondear(config.cierreBajaPp * 100), 10000)) {
        const deltaTenths = redondear((cb.tasa - c.tasa) * 10);
        push({
          tipo: "cierre_agente_bajo", propertyId: id,
          titulo: `El agente cierra ${formatoPuntos(cb.tasa - c.tasa)} puntos menos de pedidos en ${n}`,
          cifra: cifra(c.tasa, "medido", "cfo_agente_diario"), cifraTexto: formatoPct(c.tasa),
          comparacion: `Tasa de cierre de ${formatoPct(c.tasa)} contra ${formatoPct(cb.tasa)} en las 4 semanas previas, sobre ${formatoEntero(c.conversaciones)} conversaciones.`,
          porQueImporta: "Menos conversaciones y llamadas terminan en pedido: se está escapando venta que ya llegó al agente.",
          accion: { texto: "Revise dónde se abandonan o se escalan las conversaciones.", ruta: ruta("operacion", id) },
          impactoCentavos: tk != null ? mulDiv(c.conversaciones * tk, deltaTenths, 1000) : null, urgencia: "alta", fuentes: ["cfo_agente_diario"],
        });
      }
    }

    // 8) entrega_lenta: p90 > límite (el menor entre el tope configurado y 20 % sobre la promesa)
    if (m.entregaP90Min != null && a.entregados >= 5) {
      const limite = Math.min(config.entregaP90MaxMin, redondear(config.promesaMin * 1.2));
      if (m.entregaP90Min > limite) {
        push({
          tipo: "entrega_lenta", propertyId: id,
          titulo: `Las entregas de ${n} tardan ${formatoMinutos(m.entregaP90Min)} en 9 de cada 10 pedidos`,
          cifra: cifra(m.entregaP90Min, "medido", "cfo_entregas"), cifraTexto: formatoMinutos(m.entregaP90Min),
          comparacion: `La promesa es ${formatoMinutos(config.promesaMin)} y el límite de alerta ${formatoMinutos(limite)}.`,
          porQueImporta: "Las entregas tardías enfrían la comida, generan cancelaciones y quejas.",
          accion: { texto: "Revise tiempos por hora y repartidor.", ruta: ruta("operacion", id) },
          impactoCentavos: null, urgencia: "alta", fuentes: ["cfo_entregas"],
        });
      }
    }

    // 9) frecuentes_dormidos: frecuentes sin pedir ≥ 30 días
    if (m.frecuentesDormidos && m.frecuentesDormidos.clientes > 0 && tk != null) {
      const f = m.frecuentesDormidos;
      push({
        tipo: "frecuentes_dormidos", propertyId: id,
        titulo: `${formatoEntero(f.clientes)} ${f.clientes === 1 ? "cliente frecuente de" : "clientes frecuentes de"} ${n} ${f.clientes === 1 ? "lleva" : "llevan"} 30 días o más sin pedir`,
        cifra: cifra(f.clientes, "medido", "cfo_clientes_resumen"), cifraTexto: formatoEntero(f.clientes),
        comparacion: `Hicieron ${formatoEntero(f.pedidos90d)} pedidos en los últimos 90 días.`,
        porQueImporta: "Son los clientes que más compran; recuperarlos cuesta mucho menos que conseguir uno nuevo.",
        accion: { texto: "Lance una campaña de recuperación a estos clientes.", ruta: ruta("clientes", id) },
        impactoCentavos: mulDiv(tk, f.pedidos90d, 3), urgencia: "media", fuentes: ["cfo_clientes_resumen"],
      });
    }

    // 10) agotado_estrella: producto del top 20 agotado hoy
    const hoyMs = entrada.ahora.getTime();
    const estrellas = m.agotados.filter((p) => p.rankingUnidades != null && p.rankingUnidades <= 20 && p.agotadoHasta != null && Date.parse(p.agotadoHasta) > hoyMs);
    if (estrellas.length > 0) {
      const riesgo = estrellas.reduce((s, p) => s + (ventaEnRiesgoAgotado({ unidades28d: p.unidades28d, precioListaCentavos: p.precioListaCentavos, diasAgotado: 1 }).valor ?? 0), 0);
      const nombres = [...estrellas].sort((x, y) => (x.rankingUnidades ?? 99) - (y.rankingUnidades ?? 99) || cmp(x.productId, y.productId)).map((p) => p.nombre);
      push({
        tipo: "agotado_estrella", propertyId: id,
        titulo: estrellas.length === 1 ? `${nombres[0]} está agotado hoy en ${n}` : `${formatoEntero(estrellas.length)} productos estrella agotados hoy en ${n}`,
        cifra: cifra(estrellas.length, "medido", "cfo_agotados"), cifraTexto: formatoEntero(estrellas.length),
        comparacion: `Agotado${estrellas.length === 1 ? "" : "s"}: ${nombres.join(", ")}. Estima ${formatoCentavos(riesgo)} de venta en riesgo por día (estimado, a precio de lista).`,
        porQueImporta: "Son de lo más pedido: cada día agotado se pierde esa venta o se cambia por algo de menor ticket.",
        accion: { texto: "Reponga el producto o ajuste el menú del agente.", ruta: ruta("platillos", id) },
        impactoCentavos: riesgo, urgencia: "alta", fuentes: ["cfo_agotados"],
      });
    }

    // 11) comandas_sin_capturar: captura manual vencida > 0 o tasa de captura < 95 %
    if (m.comandas && m.comandas.modo !== "apagado" && m.comandas.encoladas > 0) {
      const c = m.comandas;
      const tasa = pct1(c.confirmadas + c.capturadasManual, c.encoladas);
      // tasa < 95 %  <=>  (confirmadas + capturadas) × 100 < 95 × encoladas (entero, sin redondear a 1 decimal)
      if (c.vencidasUmbral > 0 || (c.confirmadas + c.capturadasManual) * 100 < 95 * c.encoladas) {
        push({
          tipo: "comandas_sin_capturar", propertyId: id,
          titulo: c.vencidasUmbral > 0 ? `${n} tiene ${formatoEntero(c.vencidasUmbral)} ${c.vencidasUmbral === 1 ? "comanda vencida" : "comandas vencidas"} sin capturar en SoftRestaurant` : `${n} captura solo ${formatoPct(tasa ?? 0)} de sus comandas en SoftRestaurant`,
          cifra: cifra(tasa, "medido", "cfo_comandas_pos"), cifraTexto: tasa == null ? "—" : formatoPct(tasa),
          comparacion: `Tasa de captura de ${tasa == null ? "—" : formatoPct(tasa)} (mínimo esperado 95 %), con ${formatoEntero(c.capturaManualPendientes)} pendientes de captura manual.`,
          porQueImporta: "Una comanda sin capturar es un pedido que la cocina no ve: se retrasa o se pierde.",
          accion: { texto: "Capture las comandas pendientes en SoftRestaurant.", ruta: ruta("softrestaurant", id) },
          impactoCentavos: null, urgencia: "alta", fuentes: ["cfo_comandas_pos"],
        });
      }
    }

    // 12) escalaciones_pico: handoffs/conversaciones en una franja ≥ 2 × la media
    if (m.escalacionesPorFranja.length > 0) {
      const totConv = m.escalacionesPorFranja.reduce((s, f) => s + f.conversaciones, 0);
      const totH = m.escalacionesPorFranja.reduce((s, f) => s + f.handoffs, 0);
      let mejor: FilaEscalacionHora | null = null;
      for (const f of m.escalacionesPorFranja) {
        if (f.conversaciones < 10 || f.handoffs < 3) continue;
        // f.handoffs / f.conversaciones ≥ 2 × totH / totConv
        if (f.handoffs * totConv < 2 * totH * f.conversaciones) continue;
        if (!mejor || f.handoffs * mejor.conversaciones > mejor.handoffs * f.conversaciones || (f.handoffs * mejor.conversaciones === mejor.handoffs * f.conversaciones && (f.handoffs > mejor.handoffs || (f.handoffs === mejor.handoffs && (f.dowNegocio < mejor.dowNegocio || (f.dowNegocio === mejor.dowNegocio && f.horaLocal < mejor.horaLocal)))))) mejor = f;
      }
      if (mejor) {
        const tasaFranja = pct1(mejor.handoffs, mejor.conversaciones) ?? 0;
        const tasaMedia = pct1(totH, totConv) ?? 0;
        push({
          tipo: "escalaciones_pico", propertyId: id,
          titulo: `Las escalaciones de ${n} se disparan los ${nombreDiaPlural(mejor.dowNegocio)} a las ${mejor.horaLocal} h`,
          cifra: cifra(tasaFranja, "medido", "cfo_escalaciones_hora"), cifraTexto: formatoPct(tasaFranja),
          comparacion: `${formatoPct(tasaFranja)} de las conversaciones de esa franja pasan a una persona, contra ${formatoPct(tasaMedia)} en promedio.`,
          porQueImporta: "En esa franja el agente no resuelve solo: hay clientes esperando a alguien del restaurante.",
          accion: { texto: "Refuerce la atención o revise qué le preguntan al agente en esa franja.", ruta: ruta("operacion", id) },
          impactoCentavos: null, urgencia: "media", fuentes: ["cfo_escalaciones_hora"],
        });
      }
    }

    // 13) participacion_cae: participación ↓ ≥ 5 pp vs periodo anterior (requiere ≥ 2 sucursales y ventas en ambos periodos)
    if (entrada.metricas.length >= 2 && totalActual > 0 && totalAnterior > 0 && m.anterior) {
      const shareA = pct1(a.netaCentavos, totalActual) ?? 0;
      const shareP = pct1(m.anterior.netaCentavos, totalAnterior) ?? 0;
      // participación previa − actual ≥ 5 pp, con fracciones exactas
      if (difFraccionesGE(m.anterior.netaCentavos, totalAnterior, a.netaCentavos, totalActual, 5, 100)) {
        const deltaTenths = redondear((shareP - shareA) * 10);
        push({
          tipo: "participacion_cae", propertyId: id,
          titulo: `${n} perdió ${formatoPuntos(shareP - shareA)} puntos de participación en las ventas`,
          cifra: cifra(shareA, "medido", "cfo_ventas_diarias"), cifraTexto: formatoPct(shareA),
          comparacion: `Aporta ${formatoPct(shareA)} de la venta total contra ${formatoPct(shareP)} del periodo anterior.`,
          porQueImporta: "Otra sucursal está absorbiendo la venta, o esta pierde clientes mientras las demás crecen.",
          accion: { texto: "Compare esta sucursal contra el resto en el tablero de sucursales.", ruta: rutaCfo("sucursales", { desde, hasta }) },
          impactoCentavos: mulDiv(totalActual, deltaTenths, 1000), urgencia: "media", fuentes: ["cfo_ventas_diarias"],
        });
      }
    }

    // 14) descuadre_sr: semáforo rojo del cuadre de domicilio con SoftRestaurant
    if (m.cuadreSr && m.cuadreSr.semaforo === "rojo" && m.cuadreSr.diferenciaCentavos != null) {
      const dif = m.cuadreSr.diferenciaCentavos;
      push({
        tipo: "descuadre_sr", propertyId: id,
        titulo: `El domicilio de ${n} no cuadra con SoftRestaurant`,
        cifra: cifra(Math.abs(dif), "importado", "sr_resumen_dia"), cifraTexto: formatoCentavos(Math.abs(dif)),
        comparacion: `Diferencia de ${formatoCentavos(dif)}${m.cuadreSr.diferenciaPct != null ? ` (${formatoPct(m.cuadreSr.diferenciaPct)})` : ""}${m.cuadreSr.diferenciaPedidos != null ? ` y ${formatoEntero(Math.abs(m.cuadreSr.diferenciaPedidos))} pedidos de diferencia` : ""}.`,
        porQueImporta: "Lo que vendió el agente a domicilio no coincide con lo que registró el punto de venta: hay pedidos sin capturar, mal capturados o cobros que no entraron.",
        accion: { texto: "Concilie los pedidos a domicilio del día contra las cuentas de SoftRestaurant.", ruta: ruta("softrestaurant", id) },
        impactoCentavos: Math.abs(dif), urgencia: "alta", fuentes: ["cfo_ventas_diarias", "sr_resumen_dia"],
      });
    }
  }
  return out;
}

// ---- Orden, deduplicación y tope ---------------------------------------------------------------------------------------------------------

/**
 * Deduplica por tipo × sucursal (se queda con el de mayor impacto; empate: el de id menor), ordena con desempate estable y recorta a `tope` (10).
 *  - "impacto": impacto desc (los null al final), luego urgencia, luego id.
 *  - "urgencia": urgencia desc, luego impacto desc (null al final), luego id.
 */
export function ordenarHallazgos(lista: readonly Hallazgo[], criterio: CriterioOrden, tope = 10): Hallazgo[] {
  const mejores = new Map<string, Hallazgo>();
  for (const h of lista) {
    const clave = `${h.tipo}|${h.propertyId ?? ""}`;
    const prev = mejores.get(clave);
    if (!prev || (h.impactoCentavos ?? -1) > (prev.impactoCentavos ?? -1) || ((h.impactoCentavos ?? -1) === (prev.impactoCentavos ?? -1) && h.id < prev.id)) mejores.set(clave, h);
  }
  const porImpacto = (a: Hallazgo, b: Hallazgo): number => {
    if (a.impactoCentavos == null && b.impactoCentavos == null) return 0;
    if (a.impactoCentavos == null) return 1;
    if (b.impactoCentavos == null) return -1;
    return b.impactoCentavos - a.impactoCentavos;
  };
  const porUrgencia = (a: Hallazgo, b: Hallazgo): number => ORDEN_URGENCIA[b.urgencia] - ORDEN_URGENCIA[a.urgencia];
  const comparador = criterio === "impacto"
    ? (a: Hallazgo, b: Hallazgo): number => porImpacto(a, b) || porUrgencia(a, b) || cmp(a.id, b.id)
    : (a: Hallazgo, b: Hallazgo): number => porUrgencia(a, b) || porImpacto(a, b) || cmp(a.id, b.id);
  return [...mejores.values()].sort(comparador).slice(0, tope);
}
