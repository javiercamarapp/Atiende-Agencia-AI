// El SQL del seed de «El Tizon Norteño» se EJECUTA contra Postgres real en el gate de CI (scripts/verify-restaurantes-seed-demo-cuenta,
// descubierto por scripts/verify-real-postgres-ci/run-gate.mjs). Este test garantiza que el assertions.sql que corre ese gate es el del seed
// ACTUAL: si el seed cambia y no se regenera, falla aqui en vez de dejar al gate validando un SQL viejo.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { construirAssertions } from "../../../scripts/verify-restaurantes-seed-demo-cuenta/construir-assertions.ts";

const DIR = path.resolve(__dirname, "../../../scripts/verify-restaurantes-seed-demo-cuenta");

describe("verify-restaurantes-seed-demo-cuenta (Postgres real en el gate de CI)", () => {
  it("assertions.sql esta sincronizado con el seed (regenerar: npx vite-node scripts/verify-restaurantes-seed-demo-cuenta/generar-assertions.ts)", () => {
    expect(readFileSync(path.join(DIR, "assertions.sql"), "utf8")).toBe(construirAssertions());
  });

  it("el gate descubre la carpeta: trae los tres archivos que exige run-gate.mjs", () => {
    for (const f of ["bootstrap.sql", "post-migrations.sql", "assertions.sql"]) expect(() => readFileSync(path.join(DIR, f), "utf8")).not.toThrow();
  });

  it("los escenarios cubren conteos, voz con voice_id, idempotencia, aislamiento de la demo vieja y rechazo de otra vertical", () => {
    const sql = readFileSync(path.join(DIR, "assertions.sql"), "utf8");
    for (const alias of ["sucursales_deberia_ser_6", "productos_deberia_ser_289", "precios_deberia_ser_1666", "misma_huella_deberia_ser_1", "should_fail"]) {
      expect(sql).toContain(alias);
    }
    expect(sql).toContain("v.voice_id = 'Kore'");
    expect(sql).toContain("demo-restaurantes");
  });
});
