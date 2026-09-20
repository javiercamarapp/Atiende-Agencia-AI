import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// FASE 2 (integridad) — packages/db/migrations/0023_search_path_hardening_core_functions.sql
// redefine 4 funciones de `core` que carecían de `set search_path` fijo (WARN
// "Function Search Path Mutable" de `get_advisors`): `core.set_property_vertical`
// (0001_core_schema.sql), `core.default_llm_org_monthly_cap_micro_usd`
// (0010_llm_usage_budget_schema.sql), `core.impersonation_block_mutation`
// (0020_superadmin_impersonacion.sql) y `core.authz_audit_log_block_mutation`
// (0021_superadmin_authz_audit_log.sql).
//
// Este repo nunca aplica migraciones reales en sus tests unitarios (todos los
// repositorios de esta suite son en memoria — ver el comentario de cabecera de
// scripts/verify-superadmin-impersonacion/run.sh) — el comportamiento contra
// Postgres real (proconfig + los mismos casos positivo/negativo de cada
// función) se verifica en
// scripts/verify-search-path-hardening-core/{run.sh,assertions.sql}. Lo que
// SÍ puede afirmarse aquí, de forma estática, sin ningún Postgres real: que la
// nueva definición de cada función es BYTE-IDÉNTICA a la definición original
// que ya tenía sus propios tests/verify (cuerpo, firma, atributos de lenguaje)
// con el ÚNICO agregado de la cláusula `set search_path = core, pg_temp` — es
// decir, que este cambio es tan quirúrgico como dice ser y no tocó ninguna
// lógica.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");

function readRepoFile(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

/** Extrae el bloque `create or replace function <name>(...) ... $$;` (primer
 * `$$;` tras la firma) de un texto SQL. Lanza si no lo encuentra — un test que
 * dependiera de una extracción silenciosamente vacía sería peor que ningún
 * test. */
function extractFunctionBlock(sql: string, qualifiedName: string): string {
  const startRe = new RegExp(
    `create or replace function ${qualifiedName.replace(".", "\\.")}\\(`,
  );
  const startMatch = startRe.exec(sql);
  if (!startMatch) {
    throw new Error(`No se encontró "create or replace function ${qualifiedName}(" en el SQL dado.`);
  }
  const start = startMatch.index;
  const bodyStart = sql.indexOf("$$", start);
  if (bodyStart === -1) {
    throw new Error(`No se encontró el inicio de cuerpo "$$" para ${qualifiedName}.`);
  }
  const end = sql.indexOf("$$;", bodyStart + 2);
  if (end === -1) {
    throw new Error(`No se encontró el cierre "$$;" para ${qualifiedName}.`);
  }
  return sql.slice(start, end + "$$;".length);
}

/** Colapsa todo whitespace (saltos de línea incluidos) a un solo espacio —
 * la comparación que sigue es sobre TOKENS SQL (firma/cuerpo/atributos de
 * lenguaje), nunca sobre el formato de línea exacto: mover `set search_path`
 * a su propia línea (en vez de embutirlo en la línea de `language ...`) es un
 * cambio de estilo, no de lógica, y este test no debe fallar por eso. */
function normalizeWhitespace(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Quita EXACTAMENTE UNA aparición de la cláusula `set search_path =
 * <esquema>, pg_temp` de un bloque de función ya normalizado, para comparar
 * contra el bloque original previo al endurecimiento. Falla si la cláusula no
 * aparece exactamente una vez — ese es justo el cambio quirúrgico que este
 * test exige. */
function withoutSearchPathClause(normalizedBlock: string, schema: string): string {
  const clause = `set search_path = ${schema}, pg_temp`;
  const occurrences = normalizedBlock.split(clause).length - 1;
  expect(
    occurrences,
    `Se esperaba exactamente UNA aparición de "${clause}" en el bloque, se encontraron ${occurrences}.`,
  ).toBe(1);
  return normalizeWhitespace(normalizedBlock.replace(clause, " "));
}

describe("0023_search_path_hardening_core_functions — cambio quirúrgico, sin lógica tocada", () => {
  const hardeningMigration = readRepoFile(
    "packages/db/migrations/0023_search_path_hardening_core_functions.sql",
  );
  const mirrorMigration = readRepoFile(
    "supabase/migrations/20240101000176_0023_search_path_hardening_core_functions.sql",
  );

  it("el espejo de supabase/migrations/ es BYTE-IDÉNTICO a packages/db/migrations/ (mismo criterio que verify:migration-versions)", () => {
    expect(mirrorMigration).toBe(hardeningMigration);
  });

  const cases: Array<{ name: string; sourceFile: string }> = [
    { name: "core.set_property_vertical", sourceFile: "packages/db/migrations/0001_core_schema.sql" },
    {
      name: "core.default_llm_org_monthly_cap_micro_usd",
      sourceFile: "packages/db/migrations/0010_llm_usage_budget_schema.sql",
    },
    {
      name: "core.impersonation_block_mutation",
      sourceFile: "packages/db/migrations/0020_superadmin_impersonacion.sql",
    },
    {
      name: "core.authz_audit_log_block_mutation",
      sourceFile: "packages/db/migrations/0021_superadmin_authz_audit_log.sql",
    },
  ];

  for (const { name, sourceFile } of cases) {
    it(`${name}: la nueva definición es idéntica a ${sourceFile} salvo por "set search_path"`, () => {
      const originalSql = readRepoFile(sourceFile);
      const originalBlock = normalizeWhitespace(extractFunctionBlock(originalSql, name));
      const hardenedBlock = normalizeWhitespace(extractFunctionBlock(hardeningMigration, name));

      expect(hardenedBlock).not.toBe(originalBlock);
      expect(withoutSearchPathClause(hardenedBlock, "core")).toBe(originalBlock);
    });
  }

  it("las 4 funciones no son security definer (esta migración no cambia su modelo de privilegios)", () => {
    for (const { name } of cases) {
      const block = extractFunctionBlock(hardeningMigration, name);
      expect(
        block.toLowerCase(),
        `${name} no debería volverse "security definer" en este cambio (fuera de alcance de un fix de search_path).`,
      ).not.toContain("security definer");
    }
  });
});
