// check-indices-tablas-grandes.ts — política de índices sobre tablas grandes (Ola 4, G2).
//
// Un `create index` normal toma un lock SHARE sobre la tabla durante todo el build:
// mientras dura, ningún INSERT/UPDATE avanza (el outbox deja de encolar, el agente deja de
// guardar mensajes, el gateway deja de registrar uso). `create index concurrently` no
// bloquea escrituras, pero NO puede correr dentro de una transacción, y el runner de
// migraciones (`supabase db push`) aplica cada archivo como una unidad. Por eso el patrón es:
//
//   1. `scripts/indices-concurrentes/<NNNN_nombre>.sql`: `create index concurrently if not
//      exists <nombre> ...`, una sentencia por índice, corrido con `psql -f` (autocommit)
//      ANTES de la migración.
//   2. La migración del espejo: `set lock_timeout`, una guarda que aborta si el índice quedó
//      INVALID (un build concurrente interrumpido), y `create index if not exists <nombre>`
//      con el MISMO nombre: en producción es un no-op; en una base chica (CI, local) lo crea.
//
// Este guard revisa, solo para migraciones con versión >= CORTE (las anteriores ya están
// aplicadas y no se reescriben), que todo `create index` sobre una tabla de TABLAS_GRANDES
// cumpla (a) `lock_timeout` en el archivo y (b) un gemelo `concurrently` con el mismo nombre.
// Solo lee disco.
//
// Uso:  node --experimental-strip-types scripts/verify-indices-tablas-grandes/check-indices-tablas-grandes.ts

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Primera versión de `supabase/migrations/` sujeta a la política. */
export const CORTE = "20240101000900";

/** Tablas grandes o de crecimiento sin tope (append-only o colas). Se comparan contra `esquema.tabla`. */
export const TABLAS_GRANDES: readonly RegExp[] = [
  /^rentas\.mensaje$/,
  /^core\.llm_usage_daily$/,
  /^core\.billing_webhook_log$/,
  /^[a-z_]+\.[a-z_]*audit_log$/,
  /^[a-z_]+\.[a-z_]*outbox$/,
];

export interface ProblemaIndice {
  archivo: string;
  indice: string;
  tabla: string;
  motivo: "sin_lock_timeout" | "sin_gemelo_concurrente";
}

const CREATE_INDEX_RE =
  /create\s+(?:unique\s+)?index\s+(concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s+on\s+(?:only\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gi;

function sinComentarios(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function listarSql(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return [];
  }
}

function esGrande(tabla: string): boolean {
  return TABLAS_GRANDES.some((re) => re.test(tabla));
}

/** Nombres de índice creados con `concurrently` en los scripts de `concurrentesDir`. */
function gemelosConcurrentes(concurrentesDir: string): Set<string> {
  const nombres = new Set<string>();
  for (const f of listarSql(concurrentesDir)) {
    const sql = sinComentarios(readFileSync(path.join(concurrentesDir, f), "utf8"));
    for (const m of sql.matchAll(CREATE_INDEX_RE)) {
      if (m[1]) nombres.add((m[2] as string).toLowerCase());
    }
  }
  return nombres;
}

export function revisarIndicesTablasGrandes(migrationsDir: string, concurrentesDir: string): ProblemaIndice[] {
  const gemelos = gemelosConcurrentes(concurrentesDir);
  const problemas: ProblemaIndice[] = [];
  for (const archivo of listarSql(migrationsDir)) {
    const version = archivo.split("_")[0] ?? "";
    if (!/^\d{14}$/.test(version) || version < CORTE) continue;
    const sql = sinComentarios(readFileSync(path.join(migrationsDir, archivo), "utf8"));
    const conLockTimeout = /\block_timeout\b/i.test(sql);
    for (const m of sql.matchAll(CREATE_INDEX_RE)) {
      const indice = (m[2] as string).toLowerCase();
      const tabla = (m[3] as string).toLowerCase();
      if (!esGrande(tabla)) continue;
      if (!conLockTimeout) problemas.push({ archivo, indice, tabla, motivo: "sin_lock_timeout" });
      if (!gemelos.has(indice)) problemas.push({ archivo, indice, tabla, motivo: "sin_gemelo_concurrente" });
    }
  }
  return problemas;
}

function esModuloPrincipal(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (esModuloPrincipal()) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const problemas = revisarIndicesTablasGrandes(path.join(repoRoot, "supabase", "migrations"), path.join(repoRoot, "scripts", "indices-concurrentes"));
  if (problemas.length > 0) {
    console.error("verify-indices-tablas-grandes: FALLÓ");
    for (const p of problemas) console.error(`  - ${p.archivo}: ${p.indice} sobre ${p.tabla} -> ${p.motivo}`);
    process.exit(1);
  }
  console.log("verify-indices-tablas-grandes: OK -- todo índice nuevo sobre una tabla grande fija lock_timeout y tiene gemelo concurrente.");
}
