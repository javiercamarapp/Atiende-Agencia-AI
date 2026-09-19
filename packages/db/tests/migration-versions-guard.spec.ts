import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findDuplicateVersions,
  findMirrorDivergences,
  formatGuardReport,
  hasProblems,
  runMigrationVersionGuard,
} from "../../../scripts/verify-migration-versions/check-migration-versions.ts";

// Guard agregado tras la colisión real que llegó a `main` el 19-sep-2026: dos
// PRs paralelos (#119/#120) mergearon `20240101000120_0008_auth_exchange_code.sql`
// y `20240101000120_001_folio_stamp_reservation.sql` con el mismo prefijo de
// timestamp -- Supabase CLI usa ese prefijo como `version`, así que
// `supabase db push` habría fallado o ignorado uno de los dos. Estos tests usan
// SIEMPRE un directorio temporal (nunca `supabase/migrations/` real) para poder
// demostrar el caso roto sin ensuciar el árbol del repo.

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeSql(dir: string, name: string, content: string): void {
  writeFileSync(path.join(dir, name), content, "utf8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("findDuplicateVersions", () => {
  it("no reporta nada contra un directorio de migraciones sin colisiones", () => {
    const dir = makeTempDir("migrations-ok-");
    writeSql(dir, "20240101000001_a.sql", "select 1;");
    writeSql(dir, "20240101000002_b.sql", "select 2;");

    expect(findDuplicateVersions(dir)).toEqual([]);
  });

  it("detecta el caso real: dos archivos con el mismo prefijo de timestamp", () => {
    const dir = makeTempDir("migrations-dup-");
    writeSql(dir, "20240101000120_0008_auth_exchange_code.sql", "create table core.auth_exchange_code ();");
    writeSql(dir, "20240101000120_001_folio_stamp_reservation.sql", "create schema mcp_cfdi;");
    writeSql(dir, "20240101000121_0009_billing_saas_schema.sql", "create table core.billing ();");

    const duplicates = findDuplicateVersions(dir);

    expect(duplicates).toEqual([
      {
        version: "20240101000120",
        files: ["20240101000120_0008_auth_exchange_code.sql", "20240101000120_001_folio_stamp_reservation.sql"],
      },
    ]);
  });

  it("detecta 3+ archivos compartiendo el mismo prefijo, no solo pares", () => {
    const dir = makeTempDir("migrations-triple-");
    writeSql(dir, "20240101000005_a.sql", "select 1;");
    writeSql(dir, "20240101000005_b.sql", "select 2;");
    writeSql(dir, "20240101000005_c.sql", "select 3;");

    const duplicates = findDuplicateVersions(dir);

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.files).toHaveLength(3);
  });

  it("ignora README.md y cualquier archivo que no sea .sql", () => {
    const dir = makeTempDir("migrations-readme-");
    writeSql(dir, "20240101000001_a.sql", "select 1;");
    writeSql(dir, "README.md", "# Migraciones consolidadas");

    expect(findDuplicateVersions(dir)).toEqual([]);
  });
});

describe("findMirrorDivergences", () => {
  it("no reporta nada cuando el espejo es byte-idéntico a su fuente real", () => {
    const migrationsDir = makeTempDir("mirror-ok-");
    const packagesRoot = makeTempDir("packages-ok-");
    const sourceDir = path.join(packagesRoot, "db", "migrations");
    mkdirSync(sourceDir, { recursive: true });

    const content = "create table core.example ();\n";
    writeSql(sourceDir, "0001_example.sql", content);
    writeSql(migrationsDir, "20240101000001_0001_example.sql", content);

    expect(findMirrorDivergences(migrationsDir, [packagesRoot])).toEqual([]);
  });

  it("detecta un espejo que divergió de su fuente real", () => {
    const migrationsDir = makeTempDir("mirror-diverged-");
    const packagesRoot = makeTempDir("packages-diverged-");
    const sourceDir = path.join(packagesRoot, "db", "migrations");
    mkdirSync(sourceDir, { recursive: true });

    writeSql(sourceDir, "0001_example.sql", "create table core.example (id uuid);\n");
    writeSql(migrationsDir, "20240101000001_0001_example.sql", "create table core.example (id text);\n");

    const divergences = findMirrorDivergences(migrationsDir, [packagesRoot]);

    expect(divergences).toHaveLength(1);
    expect(divergences[0]?.file).toBe("20240101000001_0001_example.sql");
    expect(divergences[0]?.candidates[0]).toContain("0001_example.sql");
  });

  it("no falla cuando no hay ninguna fuente candidata (sin espejo que comparar)", () => {
    const migrationsDir = makeTempDir("mirror-no-source-");
    const packagesRoot = makeTempDir("packages-empty-");
    writeSql(migrationsDir, "20240101000001_solo_en_supabase.sql", "select 1;");

    expect(findMirrorDivergences(migrationsDir, [packagesRoot])).toEqual([]);
  });

  it("no produce falso positivo cuando varios paquetes reutilizan el mismo nombre base (basta que coincida con UNA fuente)", () => {
    // Caso real de este repo: '014_email_outbox_authenticated_grants.sql' existe
    // en más de un domain-*/migrations/ con contenido propio de cada vertical.
    const migrationsDir = makeTempDir("mirror-ambiguous-");
    const packagesRoot = makeTempDir("packages-ambiguous-");
    const citasDir = path.join(packagesRoot, "domain-citas", "migrations");
    const hotelesDir = path.join(packagesRoot, "domain-hoteles", "migrations");
    mkdirSync(citasDir, { recursive: true });
    mkdirSync(hotelesDir, { recursive: true });

    writeSql(citasDir, "014_grants.sql", "-- citas\nselect 1;\n");
    writeSql(hotelesDir, "014_grants.sql", "-- hoteles\nselect 2;\n");
    // El espejo coincide con la versión de hoteles -- no debe marcarse como
    // divergente solo porque también existe una versión distinta en citas.
    writeSql(migrationsDir, "20240101000050_014_grants.sql", "-- hoteles\nselect 2;\n");

    expect(findMirrorDivergences(migrationsDir, [packagesRoot])).toEqual([]);
  });
});

describe("runMigrationVersionGuard / hasProblems / formatGuardReport", () => {
  it("combina ambos checks y hasProblems() refleja el resultado", () => {
    const migrationsDir = makeTempDir("guard-combined-");
    const packagesRoot = makeTempDir("packages-combined-");
    writeSql(migrationsDir, "20240101000010_a.sql", "select 1;");
    writeSql(migrationsDir, "20240101000010_b.sql", "select 2;");

    const result = runMigrationVersionGuard(migrationsDir, [packagesRoot]);

    expect(hasProblems(result)).toBe(true);
    expect(result.duplicates).toHaveLength(1);
    expect(result.divergences).toHaveLength(0);

    const report = formatGuardReport(result);
    expect(report).toContain("versión duplicada");
    expect(report).toContain("20240101000010_a.sql");
    expect(report).toContain("20240101000010_b.sql");
  });

  it("hasProblems() es false y el reporte queda vacío contra un árbol sano", () => {
    const migrationsDir = makeTempDir("guard-clean-");
    const packagesRoot = makeTempDir("packages-clean-");
    writeSql(migrationsDir, "20240101000001_a.sql", "select 1;");

    const result = runMigrationVersionGuard(migrationsDir, [packagesRoot]);

    expect(hasProblems(result)).toBe(false);
    expect(formatGuardReport(result)).toBe("");
  });
});
