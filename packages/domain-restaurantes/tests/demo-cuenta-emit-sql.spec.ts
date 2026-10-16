// Modo `--emit-sql=<archivo>` del seed de la cuenta demo: genera un .sql completo para pegar en el SQL Editor de Supabase. Todo puro (sin conexion).
// La ejecucion real contra Postgres con todas las migraciones vive en scripts/verify-restaurantes-seed-demo-cuenta (escenarios E1 y E2 del gate).
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/seed/demo-cuenta/args.ts";
import { DEMO_CUENTA } from "../src/seed/demo-cuenta/definicion.ts";
import { renderDemoCuentaArchivoSql } from "../src/seed/demo-cuenta/emit-sql.ts";
import { construirPlanDemoCuenta, DemoCuentaError } from "../src/seed/demo-cuenta/plan.ts";
import { renderDemoCuentaPlpgsql } from "../src/seed/demo-cuenta/sql.ts";
import { SeedTargetError } from "../src/seed/target-safety.ts";

const plan = construirPlanDemoCuenta(DEMO_CUENTA);
const sql = renderDemoCuentaArchivoSql(plan);
const conNombre = (nombre: string) => construirPlanDemoCuenta({ ...DEMO_CUENTA, organizacion: { ...DEMO_CUENTA.organizacion, nombre } });

describe("emit-sql: archivo completo y autocontenido", () => {
  it("es determinista y trae begin; ... commit; y un SELECT de verificacion al final", () => {
    expect(renderDemoCuentaArchivoSql(plan)).toBe(sql);
    expect(sql).toMatch(/^begin;$/m);
    expect(sql).toMatch(/^commit;$/m);
    expect(sql.indexOf("\nbegin;\n")).toBeLessThan(sql.indexOf("\ncommit;\n"));
    const trasCommit = sql.slice(sql.indexOf("\ncommit;\n") + 9);
    expect(trasCommit).toMatch(/^\s*-- VERIFICACION[\s\S]*select m\.metrica, m\.obtenido, m\.esperado, \(m\.obtenido >= m\.esperado\) as ok from \(values/);
    for (const esperado of ["'sucursales'", "'productos'", "'promociones'", "'zonas_de_reparto'", "'organizaciones'"]) expect(trasCommit).toContain(esperado);
  });

  it("REUTILIZA el SQL del seed: el cuerpo plpgsql aparece tal cual, sin copia", () => {
    expect(sql).toContain(`do $seed_dc$\n${renderDemoCuentaPlpgsql(plan)}\n$seed_dc$;`);
  });

  it("los comentarios iniciales dicen que es idempotente, que no borra nada ni toca otras organizaciones", () => {
    const cabecera = sql.slice(0, sql.indexOf("\nbegin;\n"));
    expect(cabecera).toMatch(/ES IDEMPOTENTE/);
    expect(cabecera).toMatch(/NO BORRA NADA NI TOCA OTRAS ORGANIZACIONES/);
    expect(cabecera).toContain("demo-restaurantes");
    expect(cabecera).toMatch(/cuenta real de PM/);
    expect(cabecera).toContain("SIN dueno");
    expect(cabecera.split("\n").every((l) => l === "" || l.startsWith("--"))).toBe(true);
  });

  it("el preflight de esquema va dentro de la transaccion y aborta con la lista de migraciones", () => {
    expect(sql).toContain("$preflight$");
    expect(sql).toContain("restaurantes.demo_organization.seed_version");
    expect(sql).toMatch(/Aplique primero las migraciones/);
  });

  it("solo hay un DELETE (precios por sucursal que el plan ya no vende) y ninguna sentencia destructiva", () => {
    expect([...sql.matchAll(/delete from ([a-z_.]+)/g)].map((x) => x[1])).toEqual(["restaurantes.branch_products"]);
    expect(sql).not.toMatch(/\b(drop|truncate|alter)\s/i);
  });

  it("sin dueno no crea membresias; con --owner-email solo enlaza a un usuario de staff EXISTENTE", () => {
    expect(sql).not.toMatch(/core\.membership|staff_user/);
    const conDueno = renderDemoCuentaArchivoSql(plan, { ownerEmail: "  Dueno@Ejemplo.Example " });
    expect(conDueno).toContain("where lower(email) = 'dueno@ejemplo.example'");
    expect(conDueno).toMatch(/select id into v_user from core\.staff_user/);
    expect(conDueno).not.toMatch(/insert into core\.staff_user|auth\.users|password/i);
    expect(conDueno).toContain("v_user uuid;");
  });

  it("rechaza correos que podrian romper el literal SQL", () => {
    for (const malo of ["a'b@x.example", "a@b", "a b@x.example", "a$@x.example", 'a"@x.example', "x@y.z'; drop table core.organization; --"]) {
      expect(() => renderDemoCuentaArchivoSql(plan, { ownerEmail: malo }), malo).toThrow(DemoCuentaError);
    }
  });
});

describe("emit-sql: datos hostiles", () => {
  const hostil = "O'Neil \"x\" $$ ; drop schema core cascade; -- \\ $1 $a$";

  it("comillas, $$ y otras etiquetas viajan intactas dentro del JSON entre dollar-quotes", () => {
    const planHostil = conNombre(hostil);
    const archivo = renderDemoCuentaArchivoSql(planHostil);
    const m = /\$dc\$(.*)\$dc\$::jsonb/s.exec(archivo);
    expect(m).not.toBeNull();
    const doc = JSON.parse(m![1]!) as { organization: { name: string } };
    expect(doc.organization.name).toBe(planHostil.organization.name);
    expect(doc.organization.name).toContain(hostil);
    // el JSON jamas cierra por accidente el cuerpo ni el DO: solo hay UN par de cada delimitador
    expect(archivo.split("$dc$")).toHaveLength(3);
    expect(archivo.split("$seed_dc$")).toHaveLength(3);
    expect(archivo.split("$preflight$")).toHaveLength(3);
  });

  it("aborta la emision si un dato contiene un delimitador reservado (no hay forma de inyectar SQL)", () => {
    for (const d of ["$dc$", "$seed_dc$", "$seed_fn$", "$preflight$"]) {
      expect(() => renderDemoCuentaArchivoSql(conNombre(`Tizon ${d} x`)), d).toThrow(/delimitador/);
    }
  });

  it("un nombre con salto de linea no puede escapar del comentario de cabecera", () => {
    const cabecera = renderDemoCuentaArchivoSql(conNombre("Linea1\ndrop schema core cascade;\nLinea3")).split("\nbegin;\n")[0]!;
    expect(cabecera.split("\n").every((l) => l === "" || l.startsWith("--"))).toBe(true);
  });
});

describe("emit-sql: argumentos de la CLI", () => {
  it("--emit-sql y --owner-email se leen; --emit-sql no se combina con --apply ni con --confirm-host", () => {
    expect(parseArgs(["--", "--emit-sql=salida/demo.sql", "--owner-email=a@b.example"])).toEqual({
      apply: false,
      confirmHost: null,
      help: false,
      emitSql: "salida/demo.sql",
      ownerEmail: "a@b.example",
    });
    expect(() => parseArgs(["--emit-sql=x.sql", "--apply"])).toThrow(SeedTargetError);
    expect(() => parseArgs(["--emit-sql=x.sql", "--confirm-host=db.example.com"])).toThrow(SeedTargetError);
    expect(() => parseArgs(["--emit-sql="])).toThrow(/ruta/);
    expect(() => parseArgs(["--owner-email="])).toThrow(/correo/);
  });
});
