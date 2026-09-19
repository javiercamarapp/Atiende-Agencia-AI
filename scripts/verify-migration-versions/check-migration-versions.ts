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
// Este módulo verifica TRES cosas, todas sobre archivos reales del árbol (nunca
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
//   3. findDuplicateInternalNumbers/findNewInternalNumberDuplicates: colisión
//      real del 19-sep-2026 (PR #149, Fase 3 de caller-binding) — dos agentes en
//      paralelo calcularon "el siguiente número interno libre" de `packages/
//      domain-hoteles/migrations/` sin verse entre sí y ambos eligieron `023`
//      (uno para night-audit, otro para esta migración) — a diferencia de la
//      colisión de `findDuplicateVersions` (mismo prefijo de TIMESTAMP en
//      `supabase/migrations/`, que sí rompe `supabase db push`), esta es
//      puramente un problema de coordinación humana/de agentes: dos archivos con
//      nombre completo distinto (`023_night_audit_sistema_escritura.sql` vs.
//      `023_hoteles_caller_binding_fase3.sql`) conviven sin error técnico, pero
//      confunden al elegir "el siguiente número" para una tercera migración
//      futura. El repo YA tenía varias de estas colisiones antes de que este
//      guard existiera (`packages/db/migrations:0015`, `packages/domain-citas/
//      migrations:007`/`015`, `packages/domain-hoteles/migrations:008`/`017`/
//      `018`, `packages/domain-restaurantes/migrations:007`) — NUNCA se
//      renumeran retroactivamente (son migraciones ya aplicadas en producción
//      real, ver supabase/migrations/README.md), así que quedan "grandfathered"
//      en `KNOWN_INTERNAL_NUMBER_DUPLICATES`: el guard solo falla ante una
//      colisión NUEVA (cualquiera fuera de esa lista).
//
// Uso como CLI (mismo criterio que scripts/verify-real-postgres-ci/run-gate.mjs):
//   node scripts/verify-migration-versions/check-migration-versions.ts
// Sale con código != 0 e imprime el detalle si encuentra cualquiera de los tres
// problemas. Se usa también como test unitario (ver
// packages/db/tests/migration-versions-guard.spec.ts) contra fixtures en un
// directorio temporal — nunca contra `supabase/migrations/`/`packages/` reales en
// el test.

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

export interface InternalNumberDuplicate {
  /** Directorio `migrations/` donde ocurre la colisión (tal cual lo devuelve
   *  `findMigrationsDirs` — puede ser absoluto o relativo, según cómo se invoque). */
  dir: string;
  /** El número interno compartido (p. ej. "023", "0015") — SIN el timestamp de 14
   *  dígitos que usa `supabase/migrations/`, ese es un espacio de nombres distinto. */
  number: string;
  files: string[];
}

export interface GuardResult {
  duplicates: DuplicateVersion[];
  divergences: MirrorDivergence[];
  internalNumberDuplicates: InternalNumberDuplicate[];
}

const VERSION_PREFIX_RE = /^(\d+)_/;
const MIRROR_BASENAME_RE = /^\d+_(.+\.sql)$/;
const INTERNAL_NUMBER_RE = /^(\d+)_/;

// Colisiones de número interno YA existentes en el repo antes de que este guard se
// agregara (ver el comentario de cabecera del archivo para el porqué completo) —
// grandfathered a propósito, nunca se renumeran retroactivamente. Clave:
// "<ruta relativa al repo, con '/'>:<número interno>". Cualquier colisión NUEVA
// (fuera de esta lista) hace fallar el guard.
const KNOWN_INTERNAL_NUMBER_DUPLICATES: ReadonlySet<string> = new Set([
  "packages/db/migrations:0015",
  "packages/domain-citas/migrations:007",
  "packages/domain-citas/migrations:015",
  "packages/domain-hoteles/migrations:008",
  "packages/domain-hoteles/migrations:017",
  "packages/domain-hoteles/migrations:018",
  "packages/domain-restaurantes/migrations:007",
]);

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

/**
 * Detecta, DENTRO de cada `migrations/` encontrada bajo `packageSearchRoots`
 * (nunca a través de directorios distintos — dos paquetes pueden compartir
 * libremente un mismo número, la ambigüedad real es DENTRO de un mismo paquete),
 * dos o más archivos que comparten el mismo número interno (el prefijo antes del
 * primer `_`). Puro: nunca toca disco más que leer. Sin filtrar por lo YA conocido
 * — ver `findNewInternalNumberDuplicates` para eso.
 */
export function findDuplicateInternalNumbers(packageSearchRoots: string[]): InternalNumberDuplicate[] {
  const dirs = findMigrationsDirs(packageSearchRoots);
  const out: InternalNumberDuplicate[] = [];
  for (const dir of dirs) {
    const byNumber = new Map<string, string[]>();
    for (const f of listSqlFiles(dir)) {
      const m = f.match(INTERNAL_NUMBER_RE);
      if (!m) continue;
      const num = m[1] as string;
      const list = byNumber.get(num) ?? [];
      list.push(f);
      byNumber.set(num, list);
    }
    for (const [num, files] of byNumber) {
      if (files.length > 1) out.push({ dir, number: num, files: [...files].sort() });
    }
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.number.localeCompare(b.number) : a.dir.localeCompare(b.dir)));
}

/**
 * `findDuplicateInternalNumbers` menos las colisiones YA conocidas antes de que
 * este guard existiera (`KNOWN_INTERNAL_NUMBER_DUPLICATES`, ver el comentario de
 * cabecera del archivo) — lo que de verdad debe hacer fallar el guard: una
 * colisión NUEVA. `repoRoot` normaliza cada `dir` a una ruta relativa (con `/`,
 * sea cual sea el SO) antes de comparar contra la lista, para que el resultado no
 * dependa de si `dir` llegó absoluto o relativo.
 */
export function findNewInternalNumberDuplicates(duplicates: InternalNumberDuplicate[], repoRoot: string): InternalNumberDuplicate[] {
  return duplicates.filter((d) => {
    const rel = path.relative(repoRoot, d.dir).split(path.sep).join("/");
    return !KNOWN_INTERNAL_NUMBER_DUPLICATES.has(`${rel}:${d.number}`);
  });
}

export function runMigrationVersionGuard(migrationsDir: string, packageSearchRoots: string[], options?: { readonly repoRoot?: string }): GuardResult {
  const repoRoot = options?.repoRoot ?? path.resolve(migrationsDir, "..", "..");
  return {
    duplicates: findDuplicateVersions(migrationsDir),
    divergences: findMirrorDivergences(migrationsDir, packageSearchRoots),
    internalNumberDuplicates: findNewInternalNumberDuplicates(findDuplicateInternalNumbers(packageSearchRoots), repoRoot),
  };
}

export function hasProblems(result: GuardResult): boolean {
  return result.duplicates.length > 0 || result.divergences.length > 0 || result.internalNumberDuplicates.length > 0;
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
  for (const dup of result.internalNumberDuplicates) {
    lines.push(
      `  - número interno duplicado "${dup.number}" en ${dup.dir}: ${dup.files.length} archivos -> ${dup.files.join(", ")}\n` +
        `    Dos migraciones nuevas eligieron el mismo "siguiente número libre" sin verse entre sí. Renumera la más\n` +
        `    reciente al siguiente número interno realmente libre en ESE paquete (verifica con \`ls\` justo antes de\n` +
        `    elegirlo) y renombra su espejo en supabase/migrations/ en consecuencia.`,
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

  const result = runMigrationVersionGuard(migrationsDir, [packagesRoot], { repoRoot: REPO_ROOT });

  if (hasProblems(result)) {
    console.error("verify-migration-versions: FALLÓ\n");
    console.error(formatGuardReport(result));
    console.error(
      `\n${result.duplicates.length} versión(es) duplicada(s), ${result.divergences.length} espejo(s) divergente(s), ` +
        `${result.internalNumberDuplicates.length} número(s) interno(s) duplicado(s) nuevo(s).`,
    );
    process.exit(1);
  }

  console.log(
    "verify-migration-versions: OK -- ningún prefijo de versión duplicado en supabase/migrations/, ningún espejo diverge de su fuente real en packages/*/migrations/, y ningún número interno NUEVO se repite dentro de un mismo paquete.",
  );
}
