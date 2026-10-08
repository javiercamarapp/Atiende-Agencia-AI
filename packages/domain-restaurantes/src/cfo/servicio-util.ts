// CFO-05 · helpers puros del servicio del CFO (rangos de comparación, series, semáforos, outliers, sumas). Sin I/O ni reloj.
import { SUMAS_VENTAS_VACIAS, sumaAnulable, type SumasAgente, type SumasVentas } from "./formulas.ts";
import type { CompararCfo, OutlierApi, PuntoSerie, Semaforo, VariacionKpi } from "./tipos-api.ts";
import type { Granularidad } from "./estado-resultados.ts";
import { dividirEnPeriodos } from "./estado-resultados.ts";
import type { RangoCfo } from "./repositorio.ts";
import type { CfoConfig, FilaVentasDiarias } from "./tipos.ts";
import { centesimas, diasEntre, divEntera, pct1, redondear, sumarDiasFecha } from "./util.ts";

// ---- Rangos --------------------------------------------------------------------------------------------------------------------------------

/** Mismo día y mes del año anterior (el 29 de febrero cae al 28). */
export function restarAnio(fecha: string): string {
  const [a, m, d] = fecha.split("-") as [string, string, string];
  const dia = m === "02" && d === "29" ? "28" : d;
  return `${String(Number(a) - 1).padStart(4, "0")}-${m}-${dia}`;
}

/** Periodo inmediato anterior de la misma longitud. */
export function rangoAnterior(r: RangoCfo): RangoCfo {
  const n = diasEntre(r.desde, r.hasta);
  return { desde: sumarDiasFecha(r.desde, -n), hasta: sumarDiasFecha(r.desde, -1) };
}

export function rangoAnioAnterior(r: RangoCfo): RangoCfo {
  return { desde: restarAnio(r.desde), hasta: restarAnio(r.hasta) };
}

/** Las 4 ventanas del mismo tramo de las 4 semanas previas (k = 1..4), de la más reciente a la más antigua. */
export function ventanas4Semanas(r: RangoCfo): RangoCfo[] {
  return [1, 2, 3, 4].map((k) => ({ desde: sumarDiasFecha(r.desde, -7 * k), hasta: sumarDiasFecha(r.hasta, -7 * k) }));
}

/** Rango del comparativo declarado en el periodo (null con «mismo día de la semana»: son 4 ventanas). */
export function rangoComparativo(r: RangoCfo, comparar: CompararCfo): RangoCfo | null {
  if (comparar === "periodo_anterior") return rangoAnterior(r);
  if (comparar === "anio_anterior") return rangoAnioAnterior(r);
  return null;
}

export const enRango = (dia: string, r: RangoCfo): boolean => dia >= r.desde && dia <= r.hasta;

// ---- Sumas --------------------------------------------------------------------------------------------------------------------------------

/** Suma campo a campo de varias `SumasVentas` (los minutos en centésimas enteras). */
export function sumarSumasVentas(lista: readonly SumasVentas[]): SumasVentas {
  const out: Record<string, number> = { ...SUMAS_VENTAS_VACIAS };
  let min = 0;
  for (const s of lista) {
    for (const k of Object.keys(SUMAS_VENTAS_VACIAS)) {
      if (k === "entregaMinSuma") min += centesimas(s.entregaMinSuma);
      else out[k] = (out[k] ?? 0) + (s as unknown as Record<string, number>)[k]!;
    }
  }
  out["entregaMinSuma"] = min / 100;
  return out as unknown as SumasVentas;
}

/** Suma de `SumasAgente`: los costos anulables solo son null si NINGÚN elemento tenía dato. */
export function sumarSumasAgente(lista: readonly SumasAgente[]): SumasAgente {
  const n = (f: (s: SumasAgente) => number): number => lista.reduce((a, s) => a + f(s), 0);
  const c = (f: (s: SumasAgente) => number | null): number | null => sumaAnulable(lista.map(f));
  return {
    waConversacionesNuevas: n((s) => s.waConversacionesNuevas),
    waConPedido: n((s) => s.waConPedido),
    waConHandoff: n((s) => s.waConHandoff),
    waHandoffs: n((s) => s.waHandoffs),
    vozLlamadas: n((s) => s.vozLlamadas),
    vozPedidoCreado: n((s) => s.vozPedidoCreado),
    vozEscalado: n((s) => s.vozEscalado),
    vozAbandonado: n((s) => s.vozAbandonado),
    vozCentavos: c((s) => s.vozCentavos),
    telefoniaCentavos: c((s) => s.telefoniaCentavos),
    metaCentavos: c((s) => s.metaCentavos),
    llmCentavos: c((s) => s.llmCentavos),
    metaEventos: n((s) => s.metaEventos),
    filas: n((s) => s.filas),
  };
}

export function indexarPor<T>(filas: readonly T[], clave: (f: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const f of filas) {
    const k = clave(f) ?? "*";
    const l = m.get(k);
    if (l) l.push(f);
    else m.set(k, [f]);
  }
  return m;
}

// ---- Series -------------------------------------------------------------------------------------------------------------------------------

/** Agrupa filas de ventas por periodo (día, semana ISO o mes). Incluye periodos sin venta con ceros (la serie no tiene huecos). */
export function serieDeVentas(filas: readonly FilaVentasDiarias[], rango: RangoCfo, g: Granularidad): PuntoSerie[] {
  return dividirEnPeriodos(rango.desde, rango.hasta, g).map((p) => {
    let pedidos = 0;
    let bruta = 0;
    let neta = 0;
    for (const f of filas) {
      if (f.diaNegocio < p.desde || f.diaNegocio > p.hasta) continue;
      pedidos += f.pedidos;
      bruta += f.brutaCentavos;
      neta += f.netaCentavos;
    }
    return { clave: p.clave, desde: p.desde, hasta: p.hasta, pedidos, brutaCentavos: bruta, netaCentavos: neta, ticketCentavos: pedidos > 0 ? divEntera(neta, pedidos) : null };
  });
}

// ---- Variación y semáforos ----------------------------------------------------------------------------------------------------------------

/** (actual − base)/base en %, 1 decimal. Base nula, 0 o negativa: null (nunca «+infinito»). */
export function variacionPct(actual: number | null, base: number | null): number | null {
  if (actual == null || base == null || base <= 0) return null;
  return pct1(actual - base, base) as number;
}

export function variacion(tipoValor: "centavos" | "pct" | "entero" | "minutos", actual: number | null, base: number | null): VariacionKpi {
  if (actual == null || base == null) return { tipo: tipoValor === "pct" ? "pp" : tipoValor === "minutos" ? "minutos" : "pct", valor: null };
  if (tipoValor === "pct") return { tipo: "pp", valor: redondear((actual - base) * 10) / 10 };
  if (tipoValor === "minutos") return { tipo: "minutos", valor: redondear((actual - base) * 10) / 10 };
  return { tipo: "pct", valor: variacionPct(actual, base) };
}

/** Peor si cae: rojo si la caída llega al umbral, ámbar si llega a la mitad. */
export function semaforoCaida(variacionPorc: number | null, umbralPct: number): Semaforo {
  if (variacionPorc == null) return "sin_dato";
  if (variacionPorc <= -umbralPct) return "rojo";
  if (variacionPorc <= -umbralPct / 2) return "ambar";
  return "verde";
}

/** Peor si sube: rojo si el alza llega al umbral, ámbar si llega a la mitad. */
export function semaforoAlza(variacionPorc: number | null, umbralPct: number): Semaforo {
  if (variacionPorc == null) return "sin_dato";
  if (variacionPorc >= umbralPct) return "rojo";
  if (variacionPorc >= umbralPct / 2) return "ambar";
  return "verde";
}

/** Descuento %: rojo por encima del máximo configurado, ámbar desde el 75 % del máximo. */
export function semaforoDescuento(descuentoPorc: number | null, cfg: Pick<CfoConfig, "descuentoMaxPct">): Semaforo {
  if (descuentoPorc == null) return "sin_dato";
  if (descuentoPorc > cfg.descuentoMaxPct) return "rojo";
  if (descuentoPorc > cfg.descuentoMaxPct * 0.75) return "ambar";
  return "verde";
}

/** Entrega p90: rojo por encima del máximo configurado, ámbar por encima de la promesa. */
export function semaforoEntrega(p90: number | null, cfg: Pick<CfoConfig, "entregaP90MaxMin" | "promesaMin">): Semaforo {
  if (p90 == null) return "sin_dato";
  if (p90 > cfg.entregaP90MaxMin) return "rojo";
  if (p90 > cfg.promesaMin) return "ambar";
  return "verde";
}

/** Caída de la tasa de cierre en puntos: rojo si llega al umbral, ámbar si llega a la mitad. */
export function semaforoPuntos(ppCambio: number | null, umbralPp: number): Semaforo {
  if (ppCambio == null) return "sin_dato";
  if (ppCambio <= -umbralPp) return "rojo";
  if (ppCambio <= -umbralPp / 2) return "ambar";
  return "verde";
}

// ---- Outliers entre sucursales -------------------------------------------------------------------------------------------------------------

export function mediana(valores: readonly number[]): number | null {
  if (valores.length === 0) return null;
  const o = [...valores].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 === 1 ? o[m]! : (o[m - 1]! + o[m]!) / 2;
}

/** z-score poblacional entre sucursales. null con menos de 3 sucursales o sin dispersión. */
export function zScore(valor: number, valores: readonly number[]): number | null {
  if (valores.length < 3) return null;
  const media = valores.reduce((s, v) => s + v, 0) / valores.length;
  const varianza = valores.reduce((s, v) => s + (v - media) ** 2, 0) / valores.length;
  if (varianza === 0) return null;
  return redondear(((valor - media) / Math.sqrt(varianza)) * 100) / 100;
}

export function detectarOutliers(
  metrica: OutlierApi["metrica"],
  filas: ReadonlyArray<{ readonly propertyId: string; readonly nombre: string; readonly valor: number | null }>,
): OutlierApi[] {
  const con = filas.filter((f): f is { propertyId: string; nombre: string; valor: number } => f.valor != null);
  if (con.length < 2) return [];
  const valores = con.map((f) => f.valor);
  const med = mediana(valores) as number;
  const out: OutlierApi[] = [];
  for (const f of con) {
    const z = zScore(f.valor, valores);
    // z ≥ 2 en valor absoluto, o 2× la mediana (hacia arriba; con mediana 0 no hay razón que comparar).
    if (z != null && Math.abs(z) >= 2) out.push({ propertyId: f.propertyId, nombre: f.nombre, metrica, valor: f.valor, mediana: med, z, motivo: "z>=2" });
    else if (med > 0 && f.valor >= 2 * med) out.push({ propertyId: f.propertyId, nombre: f.nombre, metrica, valor: f.valor, mediana: med, z, motivo: ">=2xMediana" });
  }
  return out;
}

// ---- Textos --------------------------------------------------------------------------------------------------------------------------------

export function etiquetaAlcance(n: number, todas: boolean, organizacionCompleta: boolean, nombres: readonly string[]): string {
  if (!todas) return n === 1 ? (nombres[0] ?? "1 sucursal") : `${n} sucursales seleccionadas`;
  if (!organizacionCompleta) return n === 1 ? "Su sucursal" : `Sus ${n} sucursales`;
  return n === 1 ? "Su única sucursal" : "Todas sus sucursales";
}

export function textoComparado(c: CompararCfo): string {
  if (c === "periodo_anterior") return "el periodo anterior";
  if (c === "anio_anterior") return "el mismo periodo del año pasado";
  return "su promedio de las 4 semanas previas";
}

export function corteHHMM(corte: string | null | undefined): string | null {
  if (!corte) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(corte);
  return m ? `${m[1]!.padStart(2, "0")}:${m[2]}` : null;
}
