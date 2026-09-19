// check-migration-versions.ts — guard contra la colisión real que llegó a `main`
// el 19-sep-2026: dos PRs paralelos (#119 folio_stamp_reservation, #120
// auth_exchange_code) eligieron el mismo prefijo de timestamp en
// `supabase/migrations/` (`20240101000120_...`), y nadie lo detectó a mano antes
// de mergear (a diferencia de dos colisiones anteriores el mismo día). Supabase
// CLI usa ese prefijo como `version` — llave primaria de
// `supabase_migrations.schema_migrations` — así que dos archivos con el mismo
// valor hacen que `supabase db push`/`migration up` falle o ignore uno de los
// dos. El gate de CI existente (`postgres-real-gate.yml` vía
// `scripts/verify-real-postgres-ci/run-gate.mjs`) NO lo detectaba porque aplica
// los archivos de `supabase/migrations/` con `psql -f` uno por uno en orden
// alfabético contra un Postgres real — dos archivos con distinto contenido y
// distinto nombre completo se aplican sin conflicto ahí (`psql` no tiene
// noción de "version"), a diferencia de la CLI real de Supabase.
//
// Este módulo verifica dos cosas, ambas sobre archivos reales del árbol (nunca
// modifica nada):
//
//   1. findDuplicateVersions: ¿dos o más archivos de `supabase/migrations/`
//      comparten el mismo prefijo de versión (todo antes del primer `_`)?
//   2. findMirrorDivergences: `supabase/migrations/` es, por convención de este
//      repo (ver su propio README.md), un espejo BYTE-IDÉNTICO de migraciones
//      reales que viven en `packages/*/migrations/` (incluyendo rutas anidadas
//      como `packages/mcp-servers/cfdi/migrations/`). Para cada archivo del
//      espejo, busca candidatos con el mismo nombre base (sin el prefijo de
//      timestamp) en cualquier `migrations/` bajo `packages/`, y si hay al
//      menos un candidato, exige que el contenido coincida con AL MENOS UNO —
//      nunca exige un candidato único, porque varios paquetes de dominio
//      reutilizan nombres base genéricos (p. ej. `014_email_outbox_
//      authenticated_grants.sql` existe en más de un `domain-*/migrations/`
//      con contenido propio de cada vertical) y esta comparación no debe
//      producir falsos positivos por esa ambigüedad — solo le importa que el
//      espejo siga siendo copia fiel de SU fuente real, sea cual sea.
//
// Uso como CLI (mismo criterio que scripts/verify-real-postgres-ci/run-gate.mjs):
//   node scripts/verify-migration-versions/check-migration-versions.ts
// Sale con código != 0 e imprime el detalle si encuentra cualquiera de los dos
// problemas. Se usa también como test unitario (ver
// packages/db/tests/migration-versions-guard.spec.ts) contra fixtures en un
// directorio temporal — nunca contra `supabase/migrations/` real en el test.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface DuplicateVersion {
  version: string;
  files: string[];
}

export interface MirrorDivergence {
  file: string;
  candidates: string[];
}

export interface GuardResult {
  duplicates: DuplicateVersion[];
  divergences: MirrorDivergence[];
}

const VERSION_PREFIX_RE = /^(\d+)_/;
const MIRROR_BASENAME_RE = /^\d+_(.+\.sql)$/;

function listSqlFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".sql"));
}

/** Detecta archivos de `migrationsDir` que comparten el mismo prefijo de versión. */
export function findDuplicateVersions(migrationsDir: string): DuplicateVersion[] {
  const byVersion = new Map<string, string[]>();
  for (const f of listSqlFiles(migrationsDir)) {
    const m = f.match(VERSION_PREFIX_RE);
    if (!m) continue; // archivo sin prefijo numérico -- fuera del alcance de este guard
    const version = m[1] as string;
    const list = byVersion.get(version) ?? [];
    list.push(f);
    byVersion.set(version, list);
  }
  const duplicates: DuplicateVersion[] = [];
  for (const [version, files] of byVersion) {
    if (files.length > 1) {
      duplicates.push({ version, files: [...files].sort() });
    }
  }
  return duplicates.sort((a, b) => a.version.localeCompare(b.version));
}

/** Busca recursivamente todas las carpetas `migrations/` bajo cualquiera de `searchRoots`. */
function findMigrationsDirs(searchRoots: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // dir inexistente -- ignora en vez de fallar (fixtures parciales en tests)
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "migrations") {
        found.push(full);
        continue; // ninguna migrations/ de este repo trae subcarpetas propias
      }
      walk(full);
    }
  };
  for (const root of searchRoots) walk(root);
  return found;
}

/**
 * Para cada archivo de `migrationsDir` (el espejo consolidado), busca
 * candidatos con el mismo nombre base bajo cualquier `migrations/` dentro de
 * `packageSearchRoots` y exige que el contenido coincida con al menos uno.
 * Sin candidatos -> no es asunto de este guard (no hay fuente que comparar).
 */
export function findMirrorDivergences(migrationsDir: string, packageSearchRoots: string[]): MirrorDivergence[] {
  const sourceDirs = findMigrationsDirs(packageSearchRoots).filter((d) => path.resolve(d) !== path.resolve(migrationsDir));
  const sourceFilesByBasename = new Map<string, string[]>();
  for (const dir of sourceDirs) {
    for (const f of listSqlFiles(dir)) {
      const list = sourceFilesByBasename.get(f) ?? [];
      list.push(path.join(dir, f));
      sourceFilesByBasename.set(f, list);
    }
  }

  const divergences: MirrorDivergence[] = [];
  for (const f of listSqlFiles(migrationsDir)) {
    const m = f.match(MIRROR_BASENAME_RE);
    if (!m) continue;
    const basename = m[1] as string;
    const candidates = sourceFilesByBasename.get(basename);
    if (!candidates || candidates.length === 0) continue;
    const mirrorContent = readFileSync(path.join(migrationsDir, f), "utf8");
    const matchesAny = candidates.some((c) => readFileSync(c, "utf8") === mirrorContent);
    if (!matchesAny) {
      divergences.push({ file: f, candidates: [...candidates].sort() });
    }
  }
  return divergences;
}

export function runMigrationVersionGuard(migrationsDir: string, packageSearchRoots: string[]): GuardResult {
  return {
    duplicates: findDuplicateVersions(migrationsDir),
    divergences: findMirrorDivergences(migrationsDir, packageSearchRoots),
  };
}

export function hasProblems(result: GuardResult): boolean {
  return result.duplicates.length > 0 || result.divergences.length > 0;
}

export function formatGuardReport(result: GuardResult): string {
  const lines: string[] = [];
  for (const dup of result.duplicates) {
    lines.push(
      `  - versión duplicada "${dup.version}": ${dup.files.length} archivos comparten el mismo prefijo -> ${dup.files.join(", ")}\n` +
        `    Supabase CLI usa ese prefijo como \`version\` (llave primaria de supabase_migrations.schema_migrations) --\n` +
        `    \`supabase db push\`/\`migration up\` fallará o ignorará uno de los dos. Renombra uno al siguiente prefijo libre real\n` +
        `    (verifica con \`ls supabase/migrations\` justo antes de elegirlo).`,
    );
  }
  for (const div of result.divergences) {
    lines.push(
      `  - espejo divergente: supabase/migrations/${div.file} no es byte-idéntico a ninguna de sus fuentes candidatas ->\n` +
        `    ${div.candidates.join(", ")}\n` +
        `    Actualiza el espejo o la fuente para que vuelvan a coincidir (nunca edites el SQL solo al copiarlo, ver el\n` +
        `    README de supabase/migrations/).`,
    );
  }
  return lines.join("\n");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = path.resolve(HERE, "..", "..");
  const migrationsDir = path.join(REPO_ROOT, "supabase", "migrations");
  const packagesRoot = path.join(REPO_ROOT, "packages");

  const result = runMigrationVersionGuard(migrationsDir, [packagesRoot]);

  if (hasProblems(result)) {
    console.error("verify-migration-versions: FALLÓ\n");
    console.error(formatGuardReport(result));
    console.error(
      `\n${result.duplicates.length} versión(es) duplicada(s), ${result.divergences.length} espejo(s) divergente(s).`,
    );
    process.exit(1);
  }

  console.log(
    "verify-migration-versions: OK -- ningún prefijo de versión duplicado en supabase/migrations/ y ningún espejo diverge de su fuente real en packages/*/migrations/.",
  );
}
