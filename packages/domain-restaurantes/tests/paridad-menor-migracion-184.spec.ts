// F4c (revision de seguridad): contrato ESTATICO de la migracion 184 y de su espejo (la verificacion real contra Postgres vive en scripts/verify-restaurantes-paridad-menor).
// No sustituye a esa verificacion: solo impide que alguien quite el trigger, la policy de alcance o el espejo sin que un test lo note.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const aqui = dirname(fileURLToPath(import.meta.url));
const migraciones = join(aqui, "..", "migrations");
const espejos = join(aqui, "..", "..", "..", "supabase", "migrations");
const leer = (f: string) => readFileSync(join(migraciones, f), "utf8");

describe("migracion 184: historial protege el borrado", () => {
  const sql = leer("184_producto_proteger_historial.sql");
  it("trigger BEFORE DELETE que levanta 23503 si hay pedidos con el producto (por contencion en orders.items)", () => {
    expect(sql).toMatch(/before delete on restaurantes\.products/i);
    expect(sql).toMatch(/errcode = '23503'/);
    expect(sql).toMatch(/o\.items @> jsonb_build_array\(jsonb_build_object\('id', old\.id\)\)/);
  });
  it("el borrado en cascada de la organizacion (demo_limpiar) no se bloquea: sin organizacion el trigger sale antes de revisar pedidos o tocar promotions", () => {
    const i = sql.indexOf("if tg_op = 'DELETE' then");
    const salida = sql.indexOf("from core.organization g where g.id = old.organization_id", i);
    const revision = sql.indexOf("from restaurantes.orders o", i);
    const limpieza = sql.indexOf("perform restaurantes.promos_quitar_producto(old.organization_id", i);
    expect(salida).toBeGreaterThan(i);
    expect(salida).toBeLessThan(revision);
    expect(salida).toBeLessThan(limpieza);
    expect(sql).toMatch(/set search_path = restaurantes, core, pg_temp/);
  });
  it("DELETE exige alcance de toda la organizacion (property_ids null)", () => {
    expect(sql).toMatch(/drop policy if exists "duenos y admins borran productos"/);
    expect(sql).toMatch(/actor_tiene_rol_en_alcance\(organization_id, null, array\['owner', 'admin'\]\)/);
  });
  it("las funciones son security definer con search_path fijo y sin EXECUTE para anon/authenticated", () => {
    expect(sql.match(/^security definer$/gm)?.length).toBe(2);
    expect(sql.match(/^set search_path = restaurantes(?:, core)?, pg_temp$/gm)?.length).toBe(2);
    expect(sql).toMatch(/revoke all on function restaurantes\.producto_proteger_historial\(\) from public, anon, authenticated/);
  });
  it("limpia product_ids y courtesy_product_ids al archivar y al borrar, y desactiva la cortesia que quedaria sin producto", () => {
    expect(sql).toMatch(/after update of archived_at on restaurantes\.products/);
    expect(sql).toMatch(/array_remove\(p\.product_ids, p_product_id\)/);
    expect(sql).toMatch(/array_remove\(p\.courtesy_product_ids, p_product_id\)/);
    expect(sql).toMatch(/is_active = case/);
  });
  it("el comentario de la 180 ya no dice que la policy sea 'membership'", () => {
    expect(leer("180_producto_archivado.sql")).not.toMatch(/staff gestiona productos de su organizacion"\s*\n--\s*\(membership/);
    expect(leer("180_producto_archivado.sql")).toMatch(/duenos y admins/);
  });
  it("espejo byte-identico con version unica 484 (sin chocar con 417, 430, 440-442, 450, 460-463, 470-472, 480-483)", () => {
    const f = readdirSync(espejos).filter((n) => n.includes("_184_producto_proteger_historial"));
    expect(f).toEqual(["20240101000484_184_producto_proteger_historial.sql"]);
    expect(readFileSync(join(espejos, f[0]!), "utf8")).toBe(sql);
    const versiones = readdirSync(espejos).filter((n) => n.endsWith(".sql")).map((n) => n.split("_")[0]);
    expect(new Set(versiones).size).toBe(versiones.length);
    for (const v of ["20240101000417", "20240101000430", "20240101000440", "20240101000441", "20240101000442", "20240101000450", "20240101000460", "20240101000461", "20240101000462", "20240101000463", "20240101000470", "20240101000471", "20240101000472"]) {
      expect(versiones.filter((x) => x === v).length).toBeLessThanOrEqual(1);
    }
    expect(readFileSync(join(espejos, "20240101000480_180_producto_archivado.sql"), "utf8")).toBe(leer("180_producto_archivado.sql"));
  });
});
