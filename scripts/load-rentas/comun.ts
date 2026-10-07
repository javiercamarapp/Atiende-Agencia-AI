// Utilidades compartidas de la carga de rentas (Rn-P3-14). Sin ningun SLO codificado: estos scripts MIDEN y REPORTAN; solo fallan si se
// rompe un INVARIANTE (regla del original, ACEPTACION §Plan-1: ningun SLO publicado antes del piloto).
import * as os from "node:os";
import type pg from "pg";

/** Conexion `pg` expuesta con el contrato que piden el dominio (EjecutorTransaccional) y el repositorio de sync (TenantDbSession). */
export interface Conexion {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  exec(sql: string): Promise<void>;
}

export function envolver(cliente: pg.Client): Conexion {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const r = await cliente.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.rowCount };
    },
    async exec(sql: string) {
      await cliente.query(sql);
    },
  };
}

export function percentil(ordenados: readonly number[], p: number): number {
  if (ordenados.length === 0) return Number.NaN;
  const i = Math.min(ordenados.length - 1, Math.max(0, Math.ceil((p / 100) * ordenados.length) - 1));
  return ordenados[i]!;
}

export interface ResumenLatencias {
  n: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  promedioMs: number;
}

export function resumenLatencias(muestrasMs: readonly number[]): ResumenLatencias {
  const o = [...muestrasMs].sort((a, b) => a - b);
  const redondeo = (x: number): number => Math.round(x * 10) / 10;
  return {
    n: o.length,
    minMs: redondeo(o[0] ?? Number.NaN),
    p50Ms: redondeo(percentil(o, 50)),
    p95Ms: redondeo(percentil(o, 95)),
    p99Ms: redondeo(percentil(o, 99)),
    maxMs: redondeo(o[o.length - 1] ?? Number.NaN),
    promedioMs: redondeo(o.length > 0 ? o.reduce((a, b) => a + b, 0) / o.length : Number.NaN),
  };
}

export function infoHardware(): Record<string, string | number> {
  const cpus = os.cpus();
  return {
    plataforma: os.platform(),
    arquitectura: os.arch(),
    node: process.version,
    cpu: cpus[0]?.model ?? "desconocido",
    nucleosLogicos: cpus.length,
    memoriaTotalGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
  };
}

/** Ejecuta `tareas` con a lo sumo `limite` en vuelo (cada una abre su propia conexion: concurrencia real, sin saturar max_connections). */
export async function conLimite<T>(limite: number, tareas: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
  const resultados: T[] = new Array<T>(tareas.length);
  let siguiente = 0;
  async function trabajador(): Promise<void> {
    for (;;) {
      const i = siguiente++;
      if (i >= tareas.length) return;
      resultados[i] = await tareas[i]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, tareas.length) }, trabajador));
  return resultados;
}

export interface ResultadoEscenario {
  escenario: string;
  parametros: Record<string, number | string>;
  duracionTotalMs: number;
  latencias: Record<string, ResumenLatencias>;
  invariantes: ReadonlyArray<{ nombre: string; ok: boolean; detalle: string }>;
  datos: Record<string, number | string>;
}

export function invariante(nombre: string, ok: boolean, detalle: string): { nombre: string; ok: boolean; detalle: string } {
  return { nombre, ok, detalle };
}
