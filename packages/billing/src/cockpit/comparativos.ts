// ═══════════════════════════════════════════════════════════════════════════
// COMPARATIVOS del CFO de la plataforma: agregados por vertical y por plan (para comparar vertical
// contra vertical, plan contra plan y cliente contra cliente) a partir de las filas de economia.
// Funciones PURAS. Los margenes de un agregado se calculan SOLO sobre los clientes con ingreso y
// costo conocidos (manzana con manzana); los demas se cuentan aparte.
// ═══════════════════════════════════════════════════════════════════════════
import type { FilaEconomia } from './economia.ts';
import { round2 } from './economia.ts';

export interface AgregadoEconomia {
  readonly clave: string;
  readonly clientes: number;
  readonly clientesConMargen: number;
  readonly ingresoMxn: number;
  readonly costoDirectoMxn: number;
  readonly infraMxn: number | null;
  readonly contribucionMxn: number | null;
  readonly contribucionPct: number | null;
  readonly margenBrutoMxn: number | null;
  readonly margenBrutoPct: number | null;
  readonly llamadas: number;
  readonly minutosVoz: number;
  readonly duracionPromedioMin: number | null;
  readonly conversacionesWa: number;
  readonly pedidos: number;
  /** Costo directo promedio por cliente (MXN); `null` si ninguno tiene costo conocido. */
  readonly costoPorClienteMxn: number | null;
}

function agregar(clave: string, filas: readonly FilaEconomia[]): AgregadoEconomia {
  const comparables = filas.filter((f) => f.ingresoMxn !== null && f.ingresoMxn > 0 && f.costoDirectoMxn !== null);
  const ingreso = round2(comparables.reduce((s, f) => s + (f.ingresoMxn as number), 0));
  const directo = round2(comparables.reduce((s, f) => s + (f.costoDirectoMxn as number), 0));
  const infraTodas = comparables.every((f) => f.infraMxn !== null);
  const infra = comparables.length > 0 && infraTodas ? round2(comparables.reduce((s, f) => s + (f.infraMxn as number), 0)) : null;
  const contribucion = comparables.length > 0 ? round2(ingreso - directo) : null;
  const bruto = contribucion !== null && infra !== null ? round2(contribucion - infra) : null;
  const pct = (x: number | null) => (x !== null && ingreso > 0 ? round2((x / ingreso) * 100) : null);
  const llamadas = filas.reduce((s, f) => s + (f.uso.llamadas ?? 0), 0);
  const minutos = round2(filas.reduce((s, f) => s + (f.uso.minutosVoz ?? 0), 0));
  const costoTodos = filas.filter((f) => f.costoDirectoMxn !== null);
  return {
    clave,
    clientes: filas.length,
    clientesConMargen: comparables.length,
    ingresoMxn: ingreso,
    costoDirectoMxn: directo,
    infraMxn: infra,
    contribucionMxn: contribucion,
    contribucionPct: pct(contribucion),
    margenBrutoMxn: bruto,
    margenBrutoPct: pct(bruto),
    llamadas,
    minutosVoz: minutos,
    duracionPromedioMin: llamadas > 0 ? round2(minutos / llamadas) : null,
    conversacionesWa: filas.reduce((s, f) => s + (f.uso.conversacionesWa ?? 0), 0),
    pedidos: filas.reduce((s, f) => s + (f.uso.pedidos ?? 0), 0),
    costoPorClienteMxn: costoTodos.length > 0 ? round2(costoTodos.reduce((s, f) => s + (f.costoDirectoMxn as number), 0) / costoTodos.length) : null,
  };
}

function agruparPor(filas: readonly FilaEconomia[], clave: (f: FilaEconomia) => string): readonly AgregadoEconomia[] {
  const grupos = new Map<string, FilaEconomia[]>();
  for (const f of filas) {
    const k = clave(f);
    const g = grupos.get(k) ?? [];
    g.push(f);
    grupos.set(k, g);
  }
  return [...grupos.entries()].map(([k, g]) => agregar(k, g)).sort((a, b) => b.ingresoMxn - a.ingresoMxn || a.clave.localeCompare(b.clave));
}

export function porVertical(filas: readonly FilaEconomia[]): readonly AgregadoEconomia[] {
  return agruparPor(filas, (f) => f.vertical);
}

export function porPlan(filas: readonly FilaEconomia[]): readonly AgregadoEconomia[] {
  return agruparPor(filas, (f) => f.planNombre ?? 'sin plan');
}

export function total(filas: readonly FilaEconomia[]): AgregadoEconomia {
  return agregar('total', filas);
}

/** Cliente contra cliente: las filas pedidas en el orden pedido (las inexistentes se omiten). Maximo 4. */
export function compararClientes(filas: readonly FilaEconomia[], ids: readonly string[]): readonly FilaEconomia[] {
  const porId = new Map(filas.map((f) => [f.organizationId, f]));
  return ids.slice(0, 4).flatMap((id) => {
    const f = porId.get(id);
    return f ? [f] : [];
  });
}

export interface Variacion {
  readonly actual: number | null;
  readonly previo: number | null;
  readonly delta: number | null;
  readonly deltaPct: number | null;
}

/** Variacion de una cifra entre dos periodos (mes contra mes, real contra presupuesto). */
export function variacion(actual: number | null, previo: number | null): Variacion {
  const delta = actual !== null && previo !== null ? round2(actual - previo) : null;
  return { actual, previo, delta, deltaPct: delta !== null && previo !== null && previo !== 0 ? round2((delta / Math.abs(previo)) * 100) : null };
}
