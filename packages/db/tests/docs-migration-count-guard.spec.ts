import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard de documentación (barrido del 19-sep-2026, invertido el 19-sep-2026
// tras un segundo round de revisión): la primera versión de este guard
// comparaba un conteo-snapshot citado en docs/DEPLOY.md/
// supabase/migrations/README.md contra el conteo real de
// supabase/migrations/*.sql, y fallaba si divergían. Eso resultó ser la
// forma equivocada de resolver el problema: CI de este repo no corre
// `npm run test:unit` (ver .github/workflows/postgres-real-gate.yml -- solo
// corre los `scripts/verify-*/` contra Postgres real), así que cualquier PR
// que agregara una migración nueva sin también editar esos dos documentos
// rompía este guard EN SILENCIO para quien corriera la suite completa
// después -- ningún check automático lo habría atrapado antes de mergear.
//
// Ambos documentos ya se reescribieron para NO citar ningún conteo fijo,
// solo el comando que lo calcula (`ls supabase/migrations/*.sql | wc -l`).
// Este guard ahora protege esa decisión al revés: falla si cualquiera de los
// dos vuelve a contener un conteo-snapshot escrito a mano (los mismos 2
// patrones de frase que el guard original extraía), para que el número no
// pueda volver a pudrirse -- nunca compara contra el conteo real de
// supabase/migrations/, así que agregar una migración nunca puede romper
// este test.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");

function readDoc(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

describe("docs migration count guard (sin conteos-snapshot)", () => {
  it("docs/DEPLOY.md no vuelve a citar un conteo-snapshot de migraciones tipo '(N al DD-mmm-YYYY)'", () => {
    const doc = readDoc("docs/DEPLOY.md");
    const match = doc.match(/\(\d+ al \d{1,2}-\w{3}-\d{4}\)/);
    expect(
      match,
      `docs/DEPLOY.md vuelve a citar un conteo fijo de migraciones ("${match?.[0]}") -- ese número se pudre en cuanto se agrega una migración nueva y nadie lo edita a mano. Usa "corre \`ls supabase/migrations/*.sql | wc -l\`" en vez de un número, como el resto del documento ya hace.`,
    ).toBeNull();
  });

  it("supabase/migrations/README.md no vuelve a citar un conteo-snapshot de migraciones tipo 'esa cuenta da **N** archivos'", () => {
    const doc = readDoc("supabase/migrations/README.md");
    const match = doc.match(/esa cuenta da \*\*\d+\*\* archivos/);
    expect(
      match,
      `supabase/migrations/README.md vuelve a citar un conteo fijo de migraciones ("${match?.[0]}") -- mismo problema que docs/DEPLOY.md, ver el comentario de cabecera de este spec.`,
    ).toBeNull();
  });
});
