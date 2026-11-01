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

describe("144 (P-3): supresion con HMAC y pimienta", () => {
  const f = "144_historial_supresion_hmac.sql";
  it("usa hmac con pimienta de historial_config, falla cerrado y conserva compatibilidad v1", () => {
    const m = mig(f);
    expect(m).toMatch(/hmac\(convert_to\(p_organization_id::text \|\| ':' \|\| p_phone, 'utf8'\), convert_to\(v_pepper, 'utf8'\), 'sha256'\)/);
    expect(m).toContain("errcode = '55000'");
    expect(m).toMatch(/hash_version = 1 and s\.phone_hash = encode\(sha256/);
    expect(m).toMatch(/revoke all on restaurantes\.historial_config from public, anon, authenticated, service_role/);
    expect(espejo(f, "491")).toBe(m);
  });
  it("ni importar_historial ni historial_borrar vuelven a escribir sha256 sin pimienta", () => {
    const m = mig(f);
    const bloque = m.slice(m.indexOf("create or replace function restaurantes.importar_historial"));
    expect(bloque).not.toMatch(/insert into restaurantes\.import_historico_supresion/);
    expect(bloque).toContain("historial_suprimir(p_organization_id, v_phone)");
  });
  it("hay escenarios SQL de HMAC, transicion y fail-closed", () => {
    expect(asserts().match(/\(P-3\)/g)?.length).toBeGreaterThanOrEqual(7);
  });
});
