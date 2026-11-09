import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  findDuplicateInternalNumbers,
  findDuplicateVersions,
  findMirrorDivergences,
  findNewInternalNumberDuplicates,
  findOrphanMirrors,
  formatGuardReport,
  RENAMED_MIRRORS,
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

describe("findDuplicateInternalNumbers", () => {
  it("reproduce el caso real del 19-sep-2026 (PR #149): dos migraciones nuevas eligen el mismo número interno en el mismo paquete", () => {
    const packagesRoot = makeTempDir("packages-internal-dup-");
    const hotelesDir = path.join(packagesRoot, "domain-hoteles", "migrations");
    mkdirSync(hotelesDir, { recursive: true });
    writeSql(hotelesDir, "022_hoteles_sistema_voz_whatsapp_escritura.sql", "select 1;");
    writeSql(hotelesDir, "023_night_audit_sistema_escritura.sql", "select 2;");
    writeSql(hotelesDir, "023_hoteles_caller_binding_fase3.sql", "select 3;");

    const duplicates = findDuplicateInternalNumbers([packagesRoot]);

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.number).toBe("023");
    expect(duplicates[0]?.files).toEqual(["023_hoteles_caller_binding_fase3.sql", "023_night_audit_sistema_escritura.sql"]);
  });

  it("no reporta nada cuando dos PAQUETES distintos reutilizan el mismo número (la ambigüedad real es DENTRO de un mismo paquete)", () => {
    const packagesRoot = makeTempDir("packages-internal-ok-");
    const citasDir = path.join(packagesRoot, "domain-citas", "migrations");
    const hotelesDir = path.join(packagesRoot, "domain-hoteles", "migrations");
    mkdirSync(citasDir, { recursive: true });
    mkdirSync(hotelesDir, { recursive: true });
    writeSql(citasDir, "014_grants.sql", "select 1;");
    writeSql(hotelesDir, "014_grants.sql", "select 2;");

    expect(findDuplicateInternalNumbers([packagesRoot])).toEqual([]);
  });

  it("no reporta nada contra un paquete con numeración sana (sin colisiones)", () => {
    const packagesRoot = makeTempDir("packages-internal-clean-");
    const dir = path.join(packagesRoot, "db", "migrations");
    mkdirSync(dir, { recursive: true });
    writeSql(dir, "0001_a.sql", "select 1;");
    writeSql(dir, "0002_b.sql", "select 2;");

    expect(findDuplicateInternalNumbers([packagesRoot])).toEqual([]);
  });
});

describe("findNewInternalNumberDuplicates", () => {
  it("filtra las colisiones YA conocidas (grandfathered) y deja pasar solo las nuevas", () => {
    const repoRoot = "/repo";
    const duplicates = [
      { dir: "/repo/packages/db/migrations", number: "0015", files: ["0015_a.sql", "0015_b.sql"] },
      { dir: "/repo/packages/domain-hoteles/migrations", number: "099", files: ["099_a.sql", "099_b.sql"] },
    ];

    const nuevas = findNewInternalNumberDuplicates(duplicates, repoRoot);

    expect(nuevas).toEqual([{ dir: "/repo/packages/domain-hoteles/migrations", number: "099", files: ["099_a.sql", "099_b.sql"] }]);
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
    expect(result.internalNumberDuplicates).toHaveLength(0);

    const report = formatGuardReport(result);
    expect(report).toContain("versión duplicada");
    expect(report).toContain("20240101000010_a.sql");
    expect(report).toContain("20240101000010_b.sql");
  });

  it("hasProblems() es true por un número interno duplicado NUEVO, aunque los otros dos checks estén limpios", () => {
    const migrationsDir = makeTempDir("guard-internal-dup-");
    const packagesRoot = makeTempDir("packages-guard-internal-dup-");
    const hotelesDir = path.join(packagesRoot, "domain-hoteles", "migrations");
    mkdirSync(hotelesDir, { recursive: true });
    writeSql(hotelesDir, "099_a.sql", "select 1;");
    writeSql(hotelesDir, "099_b.sql", "select 2;");

    const result = runMigrationVersionGuard(migrationsDir, [packagesRoot]);

    expect(result.duplicates).toHaveLength(0);
    expect(result.divergences).toHaveLength(0);
    expect(result.internalNumberDuplicates).toHaveLength(1);
    expect(hasProblems(result)).toBe(true);

    const report = formatGuardReport(result);
    expect(report).toContain("número interno duplicado");
    expect(report).toContain("099_a.sql");
    expect(report).toContain("099_b.sql");
  });

  it("hasProblems() es false y el reporte queda vacío contra un árbol sano", () => {
    const migrationsDir = makeTempDir("guard-clean-");
    const packagesRoot = makeTempDir("packages-clean-");
    const dbDir = path.join(packagesRoot, "db", "migrations");
    mkdirSync(dbDir, { recursive: true });
    writeSql(migrationsDir, "20240101000001_a.sql", "select 1;");
    writeSql(dbDir, "a.sql", "select 1;");

    const result = runMigrationVersionGuard(migrationsDir, [packagesRoot]);

    expect(hasProblems(result)).toBe(false);
    expect(formatGuardReport(result)).toBe("");
  });
});

// Ola 4 (G1): el espejo `supabase/migrations/` tenía migraciones SIN fuente en
// `packages/*/migrations/` (20240101000110..000119 <-> internas 0008..0014 de
// packages/db) y el guard las dejaba pasar en silencio ("sin candidatos -> no es
// asunto de este guard"). Un espejo huérfano significa que el SQL aplicado en
// producción no tiene fuente canónica: nadie lo ve al revisar el paquete y nadie
// detecta si diverge. Ahora es un error, salvo los espejos RENOMBRADOS (nombre
// base distinto al de la fuente) declarados en RENAMED_MIRRORS, que también se
// exigen byte-idénticos.
describe("findOrphanMirrors", () => {
  it("detecta un espejo sin ninguna fuente en packages/*/migrations", () => {
    const migrationsDir = makeTempDir("orphan-");
    const packagesRoot = makeTempDir("packages-orphan-");
    mkdirSync(path.join(packagesRoot, "db", "migrations"), { recursive: true });
    writeSql(migrationsDir, "20240101000110_0008_staff_google_identity.sql", "select 1;");

    const result = findOrphanMirrors(migrationsDir, [packagesRoot], { repoRoot: packagesRoot, renamed: {} });

    expect(result.orphans).toEqual(["20240101000110_0008_staff_google_identity.sql"]);
    expect(result.renamedDivergences).toEqual([]);
  });

  it("acepta un espejo renombrado declarado cuyo contenido es byte-idéntico a la fuente", () => {
    const migrationsDir = makeTempDir("renamed-ok-");
    const repoRoot = makeTempDir("repo-renamed-ok-");
    const dir = path.join(repoRoot, "packages", "domain-despachos", "migrations");
    mkdirSync(dir, { recursive: true });
    writeSql(dir, "003_cierre_mensual_schema.sql", "select 3;");
    writeSql(migrationsDir, "20240101000048_003_despachos_cierre_mensual_schema.sql", "select 3;");

    const result = findOrphanMirrors(migrationsDir, [path.join(repoRoot, "packages")], {
      repoRoot,
      renamed: { "20240101000048_003_despachos_cierre_mensual_schema.sql": "packages/domain-despachos/migrations/003_cierre_mensual_schema.sql" },
    });

    expect(result).toEqual({ orphans: [], renamedDivergences: [] });
  });

  it("reporta un espejo renombrado que divergió de su fuente declarada", () => {
    const migrationsDir = makeTempDir("renamed-div-");
    const repoRoot = makeTempDir("repo-renamed-div-");
    const dir = path.join(repoRoot, "packages", "domain-despachos", "migrations");
    mkdirSync(dir, { recursive: true });
    writeSql(dir, "002_migracion_catalogo_schema.sql", "-- nota agregada solo en la fuente\nselect 2;");
    writeSql(migrationsDir, "20240101000037_002_despachos_migracion_catalogo_schema.sql", "select 2;");

    const result = findOrphanMirrors(migrationsDir, [path.join(repoRoot, "packages")], {
      repoRoot,
      renamed: { "20240101000037_002_despachos_migracion_catalogo_schema.sql": "packages/domain-despachos/migrations/002_migracion_catalogo_schema.sql" },
    });

    expect(result.orphans).toEqual([]);
    expect(result.renamedDivergences).toEqual([
      { file: "20240101000037_002_despachos_migracion_catalogo_schema.sql", candidates: ["packages/domain-despachos/migrations/002_migracion_catalogo_schema.sql"] },
    ]);
  });

  it("un renombrado declarado cuya fuente ya no existe cuenta como huérfano", () => {
    const migrationsDir = makeTempDir("renamed-gone-");
    const repoRoot = makeTempDir("repo-renamed-gone-");
    writeSql(migrationsDir, "20240101000253_037_restaurantes_demo_organization.sql", "select 37;");

    const result = findOrphanMirrors(migrationsDir, [path.join(repoRoot, "packages")], {
      repoRoot,
      renamed: { "20240101000253_037_restaurantes_demo_organization.sql": "packages/domain-restaurantes/migrations/037_demo_organization.sql" },
    });

    expect(result.orphans).toEqual(["20240101000253_037_restaurantes_demo_organization.sql"]);
  });

  it("runMigrationVersionGuard falla (hasProblems) ante un espejo huérfano y el reporte lo nombra", () => {
    const migrationsDir = makeTempDir("guard-orphan-");
    const packagesRoot = makeTempDir("packages-guard-orphan-");
    writeSql(migrationsDir, "20240101000119_0014_superadmin_demo_access.sql", "select 14;");

    const result = runMigrationVersionGuard(migrationsDir, [packagesRoot], { repoRoot: packagesRoot });

    expect(result.orphans).toEqual(["20240101000119_0014_superadmin_demo_access.sql"]);
    expect(hasProblems(result)).toBe(true);
    expect(formatGuardReport(result)).toContain("espejo huérfano");
  });
});

describe("árbol real del repo (supabase/migrations <-> packages/*/migrations)", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

  it("no queda ningún espejo huérfano ni divergente (incluidos los renombrados)", () => {
    const result = runMigrationVersionGuard(path.join(repoRoot, "supabase", "migrations"), [path.join(repoRoot, "packages")], { repoRoot });
    expect(result.orphans).toEqual([]);
    expect(result.divergences).toEqual([]);
    expect(hasProblems(result)).toBe(false);
  });

  it("las migraciones 0008..0014 de packages/db que solo vivían en el espejo (000110..000119) ya tienen fuente byte-idéntica", () => {
    const pares: Array<[string, string]> = [
      ["20240101000110_0008_staff_google_identity.sql", "0008_staff_google_identity.sql"],
      ["20240101000111_0009_magic_link_login.sql", "0009_magic_link_login.sql"],
      ["20240101000112_0010_platform_superadmin.sql", "0010_platform_superadmin.sql"],
      ["20240101000113_0011_login_lookup_security_definer.sql", "0011_login_lookup_security_definer.sql"],
      ["20240101000114_0012_superadmin_prospectos.sql", "0012_superadmin_prospectos.sql"],
      ["20240101000115_0013_notifications_schema.sql", "0013_notifications_schema.sql"],
      ["20240101000119_0014_superadmin_demo_access.sql", "0014_superadmin_demo_access.sql"],
    ];
    for (const [espejo, fuente] of pares) {
      const a = readFileSync(path.join(repoRoot, "supabase", "migrations", espejo));
      const b = readFileSync(path.join(repoRoot, "packages", "db", "migrations", fuente));
      expect(b.equals(a), `${fuente} debe ser byte-idéntico a ${espejo}`).toBe(true);
    }
  });

  it("cada espejo renombrado declarado apunta a una fuente que existe", () => {
    for (const fuente of Object.values(RENAMED_MIRRORS)) {
      expect(() => readFileSync(path.join(repoRoot, fuente))).not.toThrow();
    }
  });
});
