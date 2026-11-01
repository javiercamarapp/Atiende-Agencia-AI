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

describe("145 (P-1, P-2): ARCO completo y borrado real", () => {
  const f = "145_historial_arco_completo.sql";
  const m = () => mig(f);
  it("envuelve las funciones ARCO de 049/075 sin copiarlas: renombra a *_base de forma idempotente", () => {
    expect(m()).toContain("alter function restaurantes.cliente_exportar_arco(uuid, uuid) rename to cliente_exportar_arco_base");
    expect(m()).toContain("alter function restaurantes.cliente_borrar_memoria(uuid, uuid) rename to cliente_borrar_memoria_base");
    expect(m().match(/to_regprocedure\('restaurantes\.cliente_(exportar_arco|borrar_memoria)_base/g)?.length).toBe(2);
    expect(m()).toMatch(/revoke all on function restaurantes\.cliente_borrar_memoria_base\(uuid, uuid\) from public, anon, authenticated/);
    expect(espejo(f, "492")).toBe(m());
  });
  it("la exportacion publica agrega historial y consentimiento; el borrado publico llama al borrado del historial", () => {
    expect(m()).toContain("v_base || jsonb_build_object('historial_importado', restaurantes.historial_exportar_interno");
    expect(m()).toContain("restaurantes.historial_borrar_interno(p_organization_id, p_customer_id)");
    expect(m()).toContain("restaurantes.marketing_consentimiento_evento");
  });
  it("el borrado suprime primero, revoca el consentimiento y elimina o anonimiza la fila de customers", () => {
    const b = m().slice(m().indexOf("function restaurantes.historial_borrar_interno"));
    expect(b.indexOf("historial_suprimir")).toBeGreaterThan(-1);
    expect(b.indexOf("historial_suprimir")).toBeLessThan(b.indexOf("delete from restaurantes.customer_historial_resumen"));
    expect(b).toContain("set estado = 'revocado'");
    expect(b).toContain("delete from restaurantes.customers where id = p_customer_id");
    expect(b).toMatch(/set name = null, notes = null, staff_notes = null, import_nombre = null, import_notas = null/);
  });
  it("hay escenarios SQL", () => {
    expect(asserts().match(/\((P-1|P-2)\)/g)?.length).toBeGreaterThanOrEqual(14);
  });
});

describe("146 (P-4): historial_existentes", () => {
  const f = "146_historial_existentes.sql";
  it("funcion definer solo owner/admin y espejo identico", () => {
    expect(mig(f)).toMatch(/historial_existentes[\s\S]*security definer[\s\S]*cliente_es_admin\(p_organization_id\)/);
    expect(espejo(f, "493")).toBe(mig(f));
    expect(asserts().match(/\(P-4\)/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe("147 (P-5): la calle importada no es legible por el agente", () => {
  const f = "147_historial_direccion_no_legible_por_agente.sql";
  it("importar_historial ya no inserta en customer_addresses y guarda la calle en el resumen", () => {
    const m = mig(f);
    const imp = m.slice(m.indexOf("function restaurantes.importar_historial"), m.indexOf("function restaurantes.cliente_perfil_historico"));
    expect(imp).not.toContain("customer_addresses");
    expect(imp).toContain("direccion_importada");
    expect(espejo(f, "494")).toBe(m);
  });
  it("el perfil de sistema expone etiqueta y colonia, nunca direccion_importada", () => {
    const m = mig(f);
    const perfil = m.slice(m.indexOf("function restaurantes.cliente_perfil_historico"));
    expect(perfil).toContain("colonia_importada");
    expect(perfil).not.toMatch(/'direccion'|direccion_importada\)/);
    expect(asserts().match(/\(P-5\)/g)?.length).toBeGreaterThanOrEqual(5);
  });
});

describe("148 (P-9): recuperable no es contactable", () => {
  const f = "148_historial_segmentos_optin.sql";
  it("renombra, cruza con marketing_consentimiento y no deja columnas NULL", () => {
    const m = mig(f);
    expect(m.replace(/--.*/g, "")).not.toMatch(/reactivable/);
    expect(m).toContain("recuperable_historico boolean, con_optin boolean, contactable boolean");
    expect(m).toContain("restaurantes.marketing_consentimiento m");
    expect(m.match(/coalesce\(\(not x\.revision_humana\)/g)?.length).toBe(2);
    expect(espejo(f, "495")).toBe(m);
    expect(asserts().match(/\(P-9\)/g)?.length).toBeGreaterThanOrEqual(5);
  });
});
