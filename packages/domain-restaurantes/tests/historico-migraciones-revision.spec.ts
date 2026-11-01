// Contrato de las migraciones 143-149 (revision independiente de privacidad). No ejecuta SQL (la CI con Postgres real es el oraculo):
// verifica por texto que cada correccion existe, que el espejo de supabase/migrations es identico y que los escenarios SQL la cubren.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RAIZ = new URL("../../../", import.meta.url);
const leer = (ruta: string) => readFileSync(new URL(ruta, RAIZ), "utf8");
const mig = (n: string) => leer(`packages/domain-restaurantes/migrations/${n}`);
const espejo = (n: string, ts: string) => leer(`supabase/migrations/20240101000${ts}_${n}`);
const asserts = () => leer("scripts/verify-restaurantes-historico/assertions.sql");

describe("143 (P-8): cliente_es_admin exige alcance de organizacion", () => {
  const f = "143_cliente_es_admin_alcance_organizacion.sql";
  it("la condicion property_ids is null esta en la definicion y el espejo es identico", () => {
    expect(mig(f)).toMatch(/create or replace function restaurantes\.cliente_es_admin[\s\S]*m\.property_ids is null/);
    expect(espejo(f, "490")).toBe(mig(f));
  });
  it("hay escenarios SQL con un admin acotado a una sucursal", () => {
    expect(asserts()).toContain("array['00000000-0000-0000-0000-0000000f6a01']::uuid[], 'admin', 'admin'");
    expect(asserts().match(/\(P-8\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
