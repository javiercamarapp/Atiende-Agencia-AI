import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard de documentación (barrido del 19-sep-2026): docs/DEPLOY.md y
// supabase/migrations/README.md citaron un conteo de migraciones ("109
// archivos", luego "112 migraciones") que se desactualizó varias veces
// mientras el directorio real seguía creciendo -- nadie lo notó hasta una
// auditoría manual. En vez de prohibir citar un número (a veces es útil dar
// un snapshot con fecha), este guard falla `npm run test:unit` si el número
// que cualquiera de los dos documentos cita como snapshot deja de coincidir
// con `supabase/migrations/*.sql` real -- así el PR que agrega una migración
// nueva sin actualizar el snapshot se entera aquí, no en la siguiente
// auditoría manual.
//
// Si algún día se decide dejar de citar un número fijo en alguno de los dos
// documentos (reemplazarlo por "corre `ls supabase/migrations/*.sql | wc -l`"
// a secas, sin ningún número), borra el bloque correspondiente de este test
// -- no hay nada que guardar si no hay número que se pudra.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");

function countRealMigrations(): number {
  return readdirSync(path.join(repoRoot, "supabase/migrations")).filter((f) => f.endsWith(".sql")).length;
}

function readDoc(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

describe("docs migration count guard", () => {
  it("docs/DEPLOY.md cita el mismo conteo de migraciones que el directorio real", () => {
    const real = countRealMigrations();
    const doc = readDoc("docs/DEPLOY.md");
    const match = doc.match(/\((\d+) al \d{1,2}-\w{3}-\d{4}\)/);
    expect(match, "docs/DEPLOY.md debe traer un snapshot '(N al DD-mmm-YYYY)' del conteo de migraciones -- si se quitó el número a propósito, borra este assert").not.toBeNull();
    const cited = Number(match?.[1]);
    expect(
      cited,
      `docs/DEPLOY.md dice ${cited} migraciones pero supabase/migrations/ tiene ${real} archivos .sql reales -- actualiza el snapshot en docs/DEPLOY.md`,
    ).toBe(real);
  });

  it("supabase/migrations/README.md cita el mismo conteo de migraciones que el directorio real", () => {
    const real = countRealMigrations();
    const doc = readDoc("supabase/migrations/README.md");
    const match = doc.match(/esa cuenta da \*\*(\d+)\*\* archivos/);
    expect(match, "supabase/migrations/README.md debe traer el snapshot '**N** archivos' -- si se quitó el número a propósito, borra este assert").not.toBeNull();
    const cited = Number(match?.[1]);
    expect(
      cited,
      `supabase/migrations/README.md dice ${cited} migraciones pero supabase/migrations/ tiene ${real} archivos .sql reales -- actualiza el snapshot en ese README (incluida la tabla de "113-132" si agregaste migraciones nuevas)`,
    ).toBe(real);
  });
});
