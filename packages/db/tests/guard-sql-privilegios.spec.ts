import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analizarMigraciones,
  claveFuncion,
  leerExcepciones,
  leerMigraciones,
  normalizarTipo,
  tipoDeArgumento,
  separarSentencias,
  type Excepciones,
} from "../../../scripts/guard-sql-privilegios/guard.ts";

// Guard estático de privilegios (Ola 2, arreglo F.2): toda SECURITY DEFINER con revoke de PUBLIC y sin
// EXECUTE para anon; ningún grant a anon fuera de scripts/guard-sql-privilegios/excepciones.json. Los casos
// sintéticos simulan migraciones en memoria; el último corre contra supabase/migrations/ real.

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SIN_EXCEPCIONES: Excepciones = { anon: [], definerConPublic: [] };

function analizar(...sqls: string[]) {
  return analizarMigraciones(
    sqls.map((sql, i) => ({ nombre: `2024010100000${i}_m.sql`, sql })),
    SIN_EXCEPCIONES,
  );
}

const DEFINER = `create or replace function app.f(p_id uuid, p_n integer default 0) returns boolean
language sql stable security definer set search_path = app as $$ select true $$;`;

describe("guard-sql-privilegios: funciones SECURITY DEFINER", () => {
  it("una SECURITY DEFINER sin revoke de public es violación", () => {
    const r = analizar(DEFINER);
    expect(r.violaciones.map((v) => [v.regla, v.objeto])).toEqual([["definer-sin-revoke-public", "app.f(uuid,integer)"]]);
  });

  it("con revoke de public (tipos escritos con alias) no hay violación", () => {
    const r = analizar(DEFINER, "revoke all on function app.f(uuid, int4) from public, anon; grant execute on function app.f(uuid, int) to authenticated;");
    expect(r.violaciones).toEqual([]);
  });

  it("create or replace conserva el ACL de la función existente (semántica de Postgres)", () => {
    const r = analizar(DEFINER, "revoke execute on function app.f(uuid, integer) from public;", DEFINER);
    expect(r.violaciones).toEqual([]);
  });

  it("drop + create vuelve a nacer con EXECUTE de PUBLIC", () => {
    const r = analizar(DEFINER, "revoke all on function app.f(uuid, integer) from public;", "drop function if exists app.f(uuid, integer);", DEFINER);
    expect(r.violaciones.map((v) => v.regla)).toEqual(["definer-sin-revoke-public"]);
  });

  it("un grant posterior a public reabre la violación", () => {
    const r = analizar(DEFINER, "revoke all on function app.f(uuid, integer) from public;", "grant execute on function app.f(uuid, integer) to public;");
    expect(r.violaciones.map((v) => v.regla)).toEqual(["definer-sin-revoke-public"]);
  });

  it("EXECUTE explícito para anon en una SECURITY DEFINER es violación aunque PUBLIC esté revocado", () => {
    const r = analizar(DEFINER, "revoke all on function app.f(uuid, integer) from public;", "grant execute on function app.f(uuid, integer) to anon;");
    expect(r.violaciones.map((v) => v.regla)).toContain("definer-ejecutable-por-anon");
  });

  it("revoke on all functions in schema cubre las funciones ya creadas", () => {
    const r = analizar(DEFINER, "revoke all on all functions in schema app from public;");
    expect(r.violaciones).toEqual([]);
  });

  it("cada sobrecarga necesita su propio revoke", () => {
    const otra = "create function app.f(p text) returns int language sql security definer set search_path = app as $$ select 1 $$;";
    const r = analizar(DEFINER, otra, "revoke all on function app.f(uuid, integer) from public;");
    expect(r.violaciones.map((v) => v.objeto)).toEqual(["app.f(text)"]);
  });

  it("revoke sin lista de argumentos aplica a todas las sobrecargas del nombre", () => {
    const otra = "create function app.f(p text) returns int language sql security definer set search_path = app as $$ select 1 $$;";
    const r = analizar(DEFINER, otra, "revoke all on function app.f from public;");
    expect(r.violaciones).toEqual([]);
  });

  it("el texto 'security definer' dentro del cuerpo o de un comentario no cuenta", () => {
    const invoker = `-- esta NO es security definer
create function app.g() returns text language plpgsql as $body$ begin return 'security definer'; end $body$;`;
    expect(analizar(invoker).violaciones).toEqual([]);
  });

  it("alter function … security definer convierte una invoker existente", () => {
    const r = analizar("create function app.g() returns int language sql as $$ select 1 $$;", "alter function app.g() security definer;");
    expect(r.violaciones.map((v) => v.objeto)).toEqual(["app.g()"]);
  });

  it("los parámetros OUT no forman parte de la identidad", () => {
    expect(claveFuncion("App.H", "in p_a uuid, out o_b text, p_c timestamptz")).toBe("app.h(uuid,timestamp with time zone)");
    expect(claveFuncion("app.h", "p_x double precision, p_y numeric(12, 2), p_z character varying(20)[]")).toBe(
      "app.h(double precision,numeric,character varying[])",
    );
  });
});

describe("guard-sql-privilegios: grants a anon", () => {
  it("un grant de tabla a anon fuera de excepciones es violación", () => {
    const r = analizar("grant select on app.t, app.u to anon, authenticated;");
    expect(r.violaciones.map((v) => [v.regla, v.objeto])).toEqual([
      ["grant-a-anon", "tabla:app.t"],
      ["grant-a-anon", "tabla:app.u"],
    ]);
  });

  it("un grant revocado después ya no cuenta, incluso vía 'all tables in schema'", () => {
    expect(analizar("grant select on app.t to anon;", "revoke select on app.t from anon;").violaciones).toEqual([]);
    expect(analizar("grant select on app.t to anon;", "revoke all on all tables in schema app from public, anon;").violaciones).toEqual([]);
  });

  it("una excepción documentada permite exactamente sus privilegios", () => {
    const excepciones: Excepciones = {
      anon: [{ objeto: "tabla:app.t", privilegios: ["select"], justificacion: "catálogo público" }],
      definerConPublic: [],
    };
    const ok = analizarMigraciones([{ nombre: "a.sql", sql: "grant select on app.t to anon;" }], excepciones);
    expect(ok.violaciones).toEqual([]);
    const extra = analizarMigraciones([{ nombre: "a.sql", sql: "grant select, insert on app.t to anon;" }], excepciones);
    expect(extra.violaciones.map((v) => v.detalle)).toEqual([expect.stringContaining("insert")]);
  });

  it("alter default privileges … to anon siempre es violación", () => {
    const r = analizar("alter default privileges in schema app grant select on tables to anon;");
    expect(r.violaciones.map((v) => v.regla)).toEqual(["default-privileges-anon"]);
  });
});

describe("guard-sql-privilegios: tokenización", () => {
  it("separa sentencias sin cortar cuerpos dollar-quoted ni literales con ';'", () => {
    const partes = separarSentencias(
      "select 'a;b'; create function x() returns int language plpgsql as $f$ begin perform 1; return 1; end $f$; /* c; */ select 2;",
    );
    expect(partes).toHaveLength(3);
  });
});

describe("guard-sql-privilegios: migraciones reales", () => {
  it("supabase/migrations/ no tiene violaciones fuera de excepciones.json", () => {
    const r = analizarMigraciones(
      leerMigraciones(path.join(REPO_ROOT, "supabase", "migrations")),
      leerExcepciones(path.join(REPO_ROOT, "scripts", "guard-sql-privilegios", "excepciones.json")),
    );
    expect(r.violaciones).toEqual([]);
  });

  it("cada excepción de anon trae justificación", () => {
    const e = leerExcepciones(path.join(REPO_ROOT, "scripts", "guard-sql-privilegios", "excepciones.json"));
    for (const x of [...e.anon, ...e.definerConPublic]) expect(x.justificacion.length).toBeGreaterThan(20);
  });
});

describe("guard-sql-privilegios: entradas patológicas (sin backtracking catastrófico)", () => {
  const MS_MAX = 50;
  const medir = (fn: () => unknown): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  it("sufijos de arreglo: conserva la normalización", () => {
    expect(normalizarTipo("text[]")).toBe("text[]");
    expect(normalizarTipo("int4 [ ] [3]")).toBe("integer[][]");
    expect(normalizarTipo("character varying(20)[]")).toBe("character varying[]");
    expect(normalizarTipo("numeric(12, 2)")).toBe("numeric");
    expect(normalizarTipo('"core"."mi_tipo"')).toBe("core.mi_tipo");
    expect(tipoDeArgumento("p_ids uuid [ ]  default '{}'")).toBe("uuid[]");
    expect(tipoDeArgumento("p_x int = 3")).toBe("integer");
  });

  it.each([
    ["espacios y corchetes sin cerrar", `x${" [".repeat(25_000)}`],
    ["muchos espacios antes de un corchete abierto", `x${" ".repeat(50_000)}[`],
    ["corchetes vacíos repetidos y basura final", `x${"[ ]".repeat(17_000)}!`],
    ["paréntesis sin cerrar y espacios", `numeric${" (".repeat(25_000)}`],
  ])("%s (50k caracteres) termina en menos de 50 ms", (_nombre, entrada) => {
    expect(entrada.length).toBeGreaterThanOrEqual(50_000);
    normalizarTipo("int"); // calentamiento del JIT
    expect(medir(() => normalizarTipo(entrada))).toBeLessThan(MS_MAX);
    expect(medir(() => tipoDeArgumento(`p ${entrada}`))).toBeLessThan(MS_MAX);
  });

  it("argumento con 50k espacios antes de default termina en menos de 50 ms", () => {
    const entrada = `p_x integer${" ".repeat(50_000)}x`;
    expect(medir(() => tipoDeArgumento(entrada))).toBeLessThan(MS_MAX);
  });
});
