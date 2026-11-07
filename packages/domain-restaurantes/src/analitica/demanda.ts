// Analítica del dueño · PANEL DE DEMANDA (puro, sin base ni reloj). Recibe lo que entrega `analitica_demanda` y arma lo que pinta la pantalla:
// matriz día × hora, picos CALCULADOS (no fijos), franjas de refuerzo (percentil 80), recorte vie–dom, tendencia semanal, ticket, mezcla de pago y
// tiempos reales contra la promesa. Todo con la regla de honestidad: sin dato = null.
import { pct } from "./ratios.ts";
import type { CeldaMatriz, DemandaCruda, PromesaCruda } from "./tipos.ts";

export const DIAS_HISTORIAL_MIN = 28;
export const PERCENTIL_REFUERZO = 80;

export interface CeldaDemanda { readonly dow: number; readonly hora: number; readonly pedidos: number; readonly netaCentavos: number }
export interface PicoHora { readonly hora: number; readonly pedidos: number; readonly pctDelTotal: number | null }
export interface DemandaSucursal {
  /** null = suma de las sucursales consultadas. */
  readonly propertyId: string | null;
  readonly pedidos: number;
  readonly netaCentavos: number;
  readonly celdas: readonly CeldaDemanda[];
  /** Las dos horas con más pedidos del periodo (todas las fechas juntas). */
  readonly picos: readonly PicoHora[];
  /** Celdas día × hora con pedidos ≥ percentil 80 de las celdas con ventas de esa sucursal. */
  readonly refuerzo: readonly CeldaDemanda[];
  readonly umbralRefuerzo: number | null;
  readonly vieDom: { readonly pedidos: number; readonly netaCentavos: number; readonly pctPedidos: number | null; readonly pctNeta: number | null };
  readonly porCanal: readonly { readonly canal: string; readonly pedidos: number; readonly netaCentavos: number }[];
  readonly porOrigen: readonly { readonly source: string; readonly pedidos: number; readonly netaCentavos: number }[];
}
export interface SemanaTendencia {
  readonly propertyId: string | null;
  readonly semana: string;
  readonly dias: number;
  readonly completa: boolean;
  readonly pedidos: number;
  readonly netaCentavos: number;
  /** Variación de pedidos contra la semana anterior inmediata, solo si AMBAS son completas (7 días con venta); null si no. */
  readonly variacionPedidosPct: number | null;
}
export interface PagoMezcla { readonly propertyId: string | null; readonly formaPago: string; readonly pedidos: number; readonly pctPedidos: number | null; readonly netaCentavos: number }
export interface TicketVista { readonly propertyId: string | null; readonly canal: string; readonly pedidos: number; readonly ticketPromedioCentavos: number | null; readonly medianaCentavos: number | null; readonly p90Centavos: number | null }
export interface PromesaVista {
  readonly propertyId: string;
  readonly domicilios: number;
  readonly entregados: number;
  readonly conPromesa: number;
  readonly aTiempoPct: number | null;
  readonly tardePct: number | null;
  readonly sinPromesa: number;
  readonly sinCierre: number;
  readonly realMedianaMin: number | null;
  readonly prometidoMedianaMin: number | null;
  readonly desvioMedianaMin: number | null;
}
export interface DemandaVista {
  readonly sucursales: readonly DemandaSucursal[];
  readonly semanas: readonly SemanaTendencia[];
  readonly pago: readonly PagoMezcla[];
  readonly ticket: readonly TicketVista[];
  readonly promesa: readonly PromesaVista[];
  readonly totales: { readonly pedidos: number; readonly netaCentavos: number };
  readonly diasConVenta: number;
  readonly pocoHistorial: boolean;
  readonly avisos: readonly string[];
}

/** Percentil nearest-rank (el mismo del CFO) sobre valores ya numéricos. */
export function percentilNearestRank(valores: readonly number[], p: number): number | null {
  if (valores.length === 0) return null;
  const orden = [...valores].sort((a, b) => a - b);
  const rango = Math.max(1, Math.ceil((p / 100) * orden.length));
  return orden[Math.min(rango, orden.length) - 1] ?? null;
}

function agregarCeldas(celdas: readonly CeldaMatriz[]): CeldaDemanda[] {
  const m = new Map<string, { dow: number; hora: number; pedidos: number; netaCentavos: number }>();
  for (const c of celdas) {
    const k = `${c.dow}|${c.hora}`;
    const a = m.get(k) ?? { dow: c.dow, hora: c.hora, pedidos: 0, netaCentavos: 0 };
    a.pedidos += c.pedidos;
    a.netaCentavos += c.netaCentavos;
    m.set(k, a);
  }
  return [...m.values()].sort((a, b) => a.dow - b.dow || a.hora - b.hora);
}

function sumarPor<T extends string>(celdas: readonly CeldaMatriz[], clave: (c: CeldaMatriz) => T): { k: T; pedidos: number; netaCentavos: number }[] {
  const m = new Map<T, { k: T; pedidos: number; netaCentavos: number }>();
  for (const c of celdas) {
    const a = m.get(clave(c)) ?? { k: clave(c), pedidos: 0, netaCentavos: 0 };
    a.pedidos += c.pedidos;
    a.netaCentavos += c.netaCentavos;
    m.set(clave(c), a);
  }
  return [...m.values()].sort((a, b) => b.pedidos - a.pedidos || (a.k < b.k ? -1 : 1));
}

export function resumirSucursal(propertyId: string | null, celdasCrudas: readonly CeldaMatriz[]): DemandaSucursal {
  const celdas = agregarCeldas(celdasCrudas);
  const pedidos = celdas.reduce((s, c) => s + c.pedidos, 0);
  const neta = celdas.reduce((s, c) => s + c.netaCentavos, 0);
  const porHora = new Map<number, number>();
  for (const c of celdas) porHora.set(c.hora, (porHora.get(c.hora) ?? 0) + c.pedidos);
  const picos = [...porHora.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 2).map(([hora, n]) => ({ hora, pedidos: n, pctDelTotal: pct(n, pedidos) }));
  const umbral = percentilNearestRank(celdas.map((c) => c.pedidos), PERCENTIL_REFUERZO);
  const refuerzo = umbral === null ? [] : celdas.filter((c) => c.pedidos >= umbral).sort((a, b) => b.pedidos - a.pedidos || a.dow - b.dow || a.hora - b.hora);
  const vd = celdas.filter((c) => c.dow >= 5);
  const vdPedidos = vd.reduce((s, c) => s + c.pedidos, 0);
  const vdNeta = vd.reduce((s, c) => s + c.netaCentavos, 0);
  return {
    propertyId,
    pedidos,
    netaCentavos: neta,
    celdas,
    picos,
    refuerzo,
    umbralRefuerzo: umbral,
    vieDom: { pedidos: vdPedidos, netaCentavos: vdNeta, pctPedidos: pct(vdPedidos, pedidos), pctNeta: pct(vdNeta, neta) },
    porCanal: sumarPor(celdasCrudas, (c) => c.canal).map((x) => ({ canal: x.k, pedidos: x.pedidos, netaCentavos: x.netaCentavos })),
    porOrigen: sumarPor(celdasCrudas, (c) => c.source).map((x) => ({ source: x.k, pedidos: x.pedidos, netaCentavos: x.netaCentavos })),
  };
}

function promesaVista(p: PromesaCruda): PromesaVista {
  return {
    propertyId: p.propertyId,
    domicilios: p.domicilios,
    entregados: p.entregados,
    conPromesa: p.conPromesa,
    aTiempoPct: pct(p.aTiempo, p.conPromesa),
    tardePct: p.conPromesa > 0 ? pct(p.conPromesa - p.aTiempo, p.conPromesa) : null,
    sinPromesa: p.sinPromesa,
    sinCierre: p.sinCierre,
    realMedianaMin: p.realMedianaMin,
    prometidoMedianaMin: p.prometidoMedianaMin,
    desvioMedianaMin: p.desvioMedianaMin,
  };
}

export function construirDemanda(c: DemandaCruda): DemandaVista {
  const ids = [...new Set(c.matriz.map((x) => x.propertyId))].sort();
  const sucursales: DemandaSucursal[] = ids.map((id) => resumirSucursal(id, c.matriz.filter((x) => x.propertyId === id)));
  if (ids.length > 1) sucursales.push(resumirSucursal(null, c.matriz));

  // Tendencia: por sucursal y total. Una semana es «completa» si tuvo los 7 días con venta; la variación solo compara contra la semana completa previa.
  const porSemana = (props: string | null): SemanaTendencia[] => {
    const m = new Map<string, { dias: number; pedidos: number; neta: number }>();
    for (const s of c.semanas) {
      if (props !== null && s.propertyId !== props) continue;
      const a = m.get(s.semana) ?? { dias: 0, pedidos: 0, neta: 0 };
      // Con varias sucursales los días con venta se unen: el máximo (no la suma) es el piso honesto de días con actividad.
      a.dias = Math.max(a.dias, s.dias);
      a.pedidos += s.pedidos;
      a.neta += s.netaCentavos;
      m.set(s.semana, a);
    }
    const orden = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return orden.map(([semana, a], i) => {
      const prev = i > 0 ? orden[i - 1] : undefined;
      const prevCompleta = prev !== undefined && prev[1].dias >= 7;
      return {
        propertyId: props,
        semana,
        dias: a.dias,
        completa: a.dias >= 7,
        pedidos: a.pedidos,
        netaCentavos: a.neta,
        variacionPedidosPct: a.dias >= 7 && prevCompleta && prev[1].pedidos > 0 ? Math.round(((a.pedidos - prev[1].pedidos) / prev[1].pedidos) * 1000) / 10 : null,
      };
    });
  };
  const semanas = ids.length > 1 ? [...ids.flatMap((id) => porSemana(id)), ...porSemana(null)] : ids.flatMap((id) => porSemana(id));

  const pagoDe = (props: string | null): PagoMezcla[] => {
    const m = new Map<string, { pedidos: number; neta: number }>();
    for (const p of c.pago) {
      if (props !== null && p.propertyId !== props) continue;
      const a = m.get(p.formaPago) ?? { pedidos: 0, neta: 0 };
      a.pedidos += p.pedidos;
      a.neta += p.netaCentavos;
      m.set(p.formaPago, a);
    }
    const total = [...m.values()].reduce((s, a) => s + a.pedidos, 0);
    return [...m.entries()].sort((a, b) => b[1].pedidos - a[1].pedidos).map(([formaPago, a]) => ({ propertyId: props, formaPago, pedidos: a.pedidos, pctPedidos: pct(a.pedidos, total), netaCentavos: a.neta }));
  };
  const pago = ids.length > 1 ? [...ids.flatMap((id) => pagoDe(id)), ...pagoDe(null)] : ids.flatMap((id) => pagoDe(id));

  const ticketDe = (props: string | null): TicketVista[] => {
    const filas = c.ticket.filter((t) => props === null || t.propertyId === props);
    const canales = [...new Set(filas.map((t) => t.canal))].sort();
    return canales.map((canal) => {
      const fs = filas.filter((t) => t.canal === canal);
      const pedidos = fs.reduce((s, t) => s + t.pedidos, 0);
      const neta = fs.reduce((s, t) => s + t.netaCentavos, 0);
      // Mediana y p90 no se suman entre sucursales: solo existen cuando hay UNA fila.
      const una = fs.length === 1 ? fs[0] : undefined;
      return { propertyId: props, canal, pedidos, ticketPromedioCentavos: pedidos > 0 ? Math.round(neta / pedidos) : null, medianaCentavos: una?.medianaCentavos ?? null, p90Centavos: una?.p90Centavos ?? null };
    });
  };
  const ticket = ids.length > 1 ? [...ids.flatMap((id) => ticketDe(id)), ...ticketDe(null)] : ids.flatMap((id) => ticketDe(id));

  const totales = { pedidos: c.totales.reduce((s, t) => s + t.pedidos, 0), netaCentavos: c.totales.reduce((s, t) => s + t.netaCentavos, 0) };
  const pocoHistorial = c.diasConVenta < DIAS_HISTORIAL_MIN;
  const avisos: string[] = [];
  if (pocoHistorial) avisos.push(`Solo hay ${c.diasConVenta} días con ventas en el periodo: con menos de 4 semanas no se puede hablar de estacionalidad; los picos son una primera pista, no una regla.`);
  return { sucursales, semanas, pago, ticket, promesa: c.promesa.map(promesaVista), totales, diasConVenta: c.diasConVenta, pocoHistorial, avisos };
}
