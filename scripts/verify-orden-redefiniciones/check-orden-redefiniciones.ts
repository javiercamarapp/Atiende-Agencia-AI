// check-orden-redefiniciones.ts — redefiniciones de función fuera de orden (Ola 4, G3).
//
// El problema: `supabase db push` aplica en producción las migraciones que FALTAN, en el
// orden en que llegan, no por versión. Si una rama vieja trae una migración con versión
// MENOR que otra ya fusionada y ambas hacen `create or replace function` de la misma
// función:
//   - en una base nueva (CI, el gate de Postgres real) se aplican por versión y gana la
//     más nueva: todo se ve bien;
//   - en producción, la nueva ya estaba aplicada y la vieja llega después: gana la VIEJA y
//     la función queda revertida en silencio (p. ej. pierde un fix de autorización).
// Ningún otro guard lo ve: `verify:migration-versions` solo mira prefijos duplicados.
//
// Regla: una migración AGREGADA por la rama no puede (re)definir una función que también
// define una migración YA EXISTENTE con versión mayor. Arreglo: renumerar la agregada por
// encima de la mayor versión existente (y su espejo), o mover su cambio a una migración
// nueva con la versión siguiente.
//
// Las agregadas se calculan con git (`git diff --diff-filter=A <base>...HEAD`), base =
// `origin/$GITHUB_BASE_REF` en un PR de Actions, si no `origin/main` (variable
// ORDEN_REDEFINICIONES_BASE para forzarla). Necesita historial (checkout con
// fetch-depth: 0). La función de verdad es pura (`redefinicionesFueraDeOrden`).
//
// Clave de función: `esquema.nombre` en minúsculas, sin la lista de argumentos (más
// estricto que Postgres con sobrecargas, a propósito: una sobrecarga nueva en una migración
// vieja también merece revisión a mano).
//
// Uso: node --experimental-strip-types scripts/verify-orden-redefiniciones/check-orden-redefiniciones.ts

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ArchivoMigracion {
  /** Nombre del archivo en supabase/migrations (empieza con la versión de 14 dígitos). */
  nombre: string;
  sql: string;
}

export interface RedefinicionFueraDeOrden {
  agregada: string;
  funcion: string;
  /** Migraciones existentes con versión mayor que también definen la función. */
  posteriores: string[];
}

const DEFINE_FUNCION_RE = /create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+(?:"?([a-z_][a-z0-9_$]*)"?\s*\.\s*)?"?([a-z_][a-z0-9_$]*)"?\s*\(/gi;

function sinComentarios(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/** Funciones (y procedimientos) que define un archivo, `esquema.nombre` en minúsculas, sin repetir, ordenadas. */
export function funcionesDefinidas(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sinComentarios(sql).matchAll(DEFINE_FUNCION_RE)) {
    const esquema = (m[1] ?? "public").toLowerCase();
    out.add(`${esquema}.${(m[2] as string).toLowerCase()}`);
  }
  return [...out].sort();
}

function version(nombre: string): string {
  return nombre.split("_")[0] ?? "";
}

export function redefinicionesFueraDeOrden(archivos: readonly ArchivoMigracion[], agregadas: ReadonlySet<string>): RedefinicionFueraDeOrden[] {
  const existentesPorFuncion = new Map<string, string[]>();
  for (const a of archivos) {
    if (agregadas.has(a.nombre)) continue;
    for (const f of funcionesDefinidas(a.sql)) {
      const lista = existentesPorFuncion.get(f) ?? [];
      lista.push(a.nombre);
      existentesPorFuncion.set(f, lista);
    }
  }
  const out: RedefinicionFueraDeOrden[] = [];
  for (const a of [...archivos].sort((x, y) => x.nombre.localeCompare(y.nombre))) {
    if (!agregadas.has(a.nombre)) continue;
    for (const f of funcionesDefinidas(a.sql)) {
      const posteriores = (existentesPorFuncion.get(f) ?? []).filter((e) => version(e) > version(a.nombre)).sort();
      if (posteriores.length > 0) out.push({ agregada: a.nombre, funcion: f, posteriores });
    }
  }
  return out;
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
  const dir = path.join(repoRoot, "supabase", "migrations");
  const base =
    process.env.ORDEN_REDEFINICIONES_BASE ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main");
  let agregadasRaw: string;
  try {
    agregadasRaw = execFileSync("git", ["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--", "supabase/migrations"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch {
    console.error(
      `verify-orden-redefiniciones: no pude calcular las migraciones agregadas contra ${base} (¿checkout sin historial? usa fetch-depth: 0 o fija ORDEN_REDEFINICIONES_BASE).`,
    );
    process.exit(2);
  }
  const agregadas = new Set(
    agregadasRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith(".sql"))
      .map((l) => path.basename(l)),
  );
  const archivos = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((nombre) => ({ nombre, sql: readFileSync(path.join(dir, nombre), "utf8") }));
  const problemas = redefinicionesFueraDeOrden(archivos, agregadas);
  if (problemas.length > 0) {
    console.error(`verify-orden-redefiniciones: FALLÓ (base ${base}, ${agregadas.size} migración(es) agregada(s))`);
    for (const p of problemas) {
      console.error(
        `  - ${p.agregada} redefine ${p.funcion}, que ya redefine una migración posterior: ${p.posteriores.join(", ")}.\n` +
          `    En producción se aplicaría DESPUÉS y revertiría esa función. Renumera la migración (y su espejo) por encima de la mayor versión existente.`,
      );
    }
    process.exit(1);
  }
  console.log(
    `verify-orden-redefiniciones: OK (base ${base}, ${agregadas.size} migración(es) agregada(s)) -- ninguna redefine una función ya redefinida por una migración posterior.`,
  );
}
