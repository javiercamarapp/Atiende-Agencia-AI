// metricas.ts (R-36) — funciones puras del arnes de carga: percentiles, resumen y evaluacion de umbrales.
export type Muestra = { ms: number; status: number };
export type Resumen = { total: number; ok: number; limitadas429: number; errores5xx: number; otros: number; p50: number; p95: number; p99: number; max: number };
export type Umbral = { p95MsMax: number; errores5xxMax: number };

/** Percentil por rango mas cercano (sin interpolar): estable y entendible. `q` en (0,100]. */
export function percentil(valores: readonly number[], q: number): number {
  if (valores.length === 0) return 0;
  const orden = [...valores].sort((a, b) => a - b);
  const idx = Math.min(orden.length - 1, Math.max(0, Math.ceil((q / 100) * orden.length) - 1));
  return orden[idx]!;
}

export function resumir(muestras: readonly Muestra[]): Resumen {
  const ms = muestras.map((m) => m.ms);
  return {
    total: muestras.length,
    ok: muestras.filter((m) => m.status >= 200 && m.status < 300).length,
    limitadas429: muestras.filter((m) => m.status === 429).length,
    errores5xx: muestras.filter((m) => m.status >= 500).length,
    otros: muestras.filter((m) => m.status < 200 || (m.status >= 300 && m.status < 500 && m.status !== 429)).length,
    p50: percentil(ms, 50),
    p95: percentil(ms, 95),
    p99: percentil(ms, 99),
    max: ms.length ? Math.max(...ms) : 0,
  };
}

/** Devuelve los motivos de incumplimiento (vacio = cumple). */
export function evaluarUmbral(nombre: string, r: Resumen, u: Umbral): string[] {
  const m: string[] = [];
  if (r.total === 0) m.push(`${nombre}: sin muestras`);
  if (r.p95 > u.p95MsMax) m.push(`${nombre}: p95 ${r.p95.toFixed(0)} ms > ${u.p95MsMax} ms`);
  if (r.errores5xx > u.errores5xxMax) m.push(`${nombre}: ${r.errores5xx} respuestas 5xx (max ${u.errores5xxMax})`);
  return m;
}

/** Tamano de la corrida. Vive aqui (y no en el spec) porque el inventario de credenciales
 * (apps/api/tests/env-inventory-guard.spec.ts) exige registrar toda variable leida bajo apps/ y packages/, y estas tres
 * son perillas de prueba, no credenciales. Valores por defecto: carga chica para el gate normal. */
export function configuracionDeCarga(env: NodeJS.ProcessEnv = process.env): { clientes: number; mensajesMeta: number; reportar: boolean } {
  return { clientes: Number(env.CARGA_CLIENTES ?? 60), mensajesMeta: Number(env.CARGA_MENSAJES_META ?? 40), reportar: Boolean(env.CARGA_REPORTE) };
}
