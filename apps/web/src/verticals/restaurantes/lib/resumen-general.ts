// «Resumen general» de restaurantes: logica PURA que convierte las vistas del CFO (`/admin/cfo/resumen`) en las piezas de la pagina
// (KPI de la organizacion, estado de los datos, «Requiere tu atencion» y el comparativo por sucursal). Sin React, sin red y sin reloj.
//
// Por que el CFO y no los KPIs del Resumen: el CFO ya resuelve el alcance por membresia (dueño/admin con toda la organizacion o admin
// acotado a sus sucursales), incluye TODAS las sucursales con historia (tambien las de «solo venta local», como Galerias, cuya venta
// entra por el reporte importado de SoftRestaurant) y trae por sucursal las mismas cifras que el total. Una cifra `null` es «sin dato»,
// nunca 0.
import type { Hallazgo, KpiTarjeta, ResumenVista } from "@atiende/domain-restaurantes/cfo";

/** Id del KPI de ventas segun el origen del titular: con SoftRestaurant importado, las ventas del negocio; si no, las del agente. */
export const KPI_VENTAS_AGENTE = "ventas_netas";
export const KPI_VENTAS_SR = "ventas_negocio_sr";

const valorDe = (kpis: readonly KpiTarjeta[], id: string): number | null => kpis.find((k) => k.id === id)?.valor.valor ?? null;

export interface VariacionKpiGeneral {
  /** Variacion porcentual con 1 decimal (4.9 = +4.9 %). */
  readonly pct: number;
  /** true si el movimiento es bueno segun la metrica (bajar la cancelacion es bueno). */
  readonly bueno: boolean;
}

/** Variacion de una tarjeta del CFO en el formato de `StatCard`. `null` = se intento comparar y no hubo base; `undefined` = no aplica. */
export function variacionDe(k: KpiTarjeta | undefined): VariacionKpiGeneral | null | undefined {
  if (!k || k.variacion.tipo !== "pct") return undefined;
  const v = k.variacion.valor;
  if (v === null || !Number.isFinite(v)) return null;
  const pct = Math.round(v * 10) / 10;
  const bueno = k.mejorSi === "menor" ? pct <= 0 : pct >= 0;
  return { pct, bueno };
}

export interface FilaComparativo {
  readonly propertyId: string;
  readonly nombre: string;
  /** false = sucursal inactiva que sigue contando por su historia. */
  readonly activa: boolean;
  /** Ventas del negocio (SoftRestaurant importado), centavos. */
  readonly ventasNegocio: number | null;
  /** Ventas tomadas por el agente (WhatsApp y voz), centavos. */
  readonly ventasAgente: number | null;
  readonly pedidos: number | null;
  readonly ticket: number | null;
  readonly variacion: VariacionKpiGeneral | null | undefined;
  /** Fraccion (0..1) de las ventas de la organizacion que aporta la sucursal, sobre la misma base que el titular. */
  readonly participacion: number | null;
}

export interface Comparativo {
  /** Base de ventas que manda (la del titular del CFO). */
  readonly origen: "agente" | "softrestaurant";
  /** true si alguna sucursal trae ventas del negocio: la columna se muestra. */
  readonly conVentasNegocio: boolean;
  readonly filas: readonly FilaComparativo[];
  readonly total: Omit<FilaComparativo, "propertyId" | "nombre" | "activa">;
}

export function armarComparativo(d: ResumenVista): Comparativo {
  const origen = d.titular.origen;
  const idVentas = origen === "softrestaurant" ? KPI_VENTAS_SR : KPI_VENTAS_AGENTE;
  const totalVentas = valorDe(d.kpis.total.kpis, idVentas);
  const activa = new Map(d.sucursales.map((s) => [s.propertyId, s.activa !== false]));
  const participacion = (v: number | null): number | null => (v === null || totalVentas === null || totalVentas <= 0 ? null : v / totalVentas);
  const filas: FilaComparativo[] = d.kpis.porSucursal.map((s) => {
    const ventas = valorDe(s.kpis, idVentas);
    return {
      propertyId: s.propertyId,
      nombre: s.nombre,
      activa: activa.get(s.propertyId) ?? true,
      ventasNegocio: valorDe(s.kpis, KPI_VENTAS_SR),
      ventasAgente: valorDe(s.kpis, KPI_VENTAS_AGENTE),
      pedidos: valorDe(s.kpis, "pedidos"),
      ticket: valorDe(s.kpis, "ticket"),
      variacion: variacionDe(s.kpis.find((k) => k.id === idVentas)),
      participacion: participacion(ventas),
    };
  });
  const t = d.kpis.total.kpis;
  return {
    origen,
    conVentasNegocio: filas.some((f) => f.ventasNegocio !== null) || valorDe(t, KPI_VENTAS_SR) !== null,
    filas,
    total: {
      ventasNegocio: valorDe(t, KPI_VENTAS_SR),
      ventasAgente: valorDe(t, KPI_VENTAS_AGENTE),
      pedidos: valorDe(t, "pedidos"),
      ticket: valorDe(t, "ticket"),
      variacion: variacionDe(t.find((k) => k.id === idVentas)),
      participacion: totalVentas !== null && totalVentas > 0 ? 1 : null,
    },
  };
}

/** Sucursal que mas aporta (para la frase). null si nadie tiene participacion medible. */
export function sucursalLider(c: Comparativo): FilaComparativo | null {
  let lider: FilaComparativo | null = null;
  for (const f of c.filas) if (f.participacion !== null && (lider === null || f.participacion > (lider.participacion ?? -1))) lider = f;
  return lider;
}

export interface EstadoDatos {
  readonly conDatos: number;
  readonly total: number;
  /** Nombres de las fuentes sin datos en este periodo (tal como los manda el servidor). */
  readonly sinCargar: readonly string[];
  /** Ultimo dia con datos (`YYYY-MM-DD`) entre las fuentes disponibles; null si ninguna lo dice. */
  readonly hasta: string | null;
}

/** Franja «Fuentes con datos: x de y · Datos hasta …» con las fuentes que declara la vista del CFO (nunca un conteo inventado). */
export function armarEstadoDatos(d: Pick<ResumenVista, "fuentes">): EstadoDatos {
  const disponibles = d.fuentes.filter((f) => f.disponible);
  const hasta = disponibles.map((f) => f.cobertura.hasta).filter((x): x is string => typeof x === "string" && x.length > 0).sort().at(-1) ?? null;
  return { conDatos: disponibles.length, total: d.fuentes.length, sinCargar: d.fuentes.filter((f) => !f.disponible).map((f) => f.nombre), hasta };
}

export interface AvisoAtencion {
  readonly id: string;
  readonly titulo: string;
  readonly nota: string;
  readonly cifra: string;
  readonly urgente: boolean;
  /** Ruta interna del CFO (`/cfo/...`) para profundizar; la pagina la convierte en enlace solo si la pestaña existe. */
  readonly ruta: string;
}

/** Los `max` hallazgos de mayor prioridad (el servidor ya los ordena por impacto), en el formato de la lista de Rovaq. */
export function armarAtencion(hallazgos: readonly Hallazgo[], max = 3): { readonly total: number; readonly avisos: readonly AvisoAtencion[] } {
  return {
    total: hallazgos.length,
    avisos: hallazgos.slice(0, max).map((h) => ({
      id: h.id,
      titulo: h.titulo,
      nota: h.comparacion || h.porQueImporta,
      cifra: h.cifraTexto,
      urgente: h.urgencia === "alta",
      ruta: h.accion.ruta,
    })),
  };
}

/** Atajos de periodo del encabezado (mismo calculo que el CFO; los dias son de calendario local). */
export const ATAJOS_RESUMEN_GENERAL = ["7d", "30d", "mes", "12m"] as const;
export type AtajoResumenGeneral = (typeof ATAJOS_RESUMEN_GENERAL)[number];
