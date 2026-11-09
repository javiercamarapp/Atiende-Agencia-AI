import { describe, expect, it } from "vitest";
import {
  funcionesDefinidas,
  redefinicionesFueraDeOrden,
  type ArchivoMigracion,
} from "../../../scripts/verify-orden-redefiniciones/check-orden-redefiniciones.ts";

// Ola 4 (G3): `supabase db push` aplica en producción las migraciones en el orden en que
// LLEGAN (las que faltan), no en el orden de su versión. Si un PR viejo trae una migración
// con versión MENOR que otra ya fusionada y ambas hacen `create or replace function` de la
// misma función, en una base nueva gana la más nueva (orden de versión) pero en producción
// gana la vieja (se aplica después): la función queda revertida en silencio. El guard
// compara solo las migraciones AGREGADAS por la rama contra las ya existentes.

function m(nombre: string, sql: string): ArchivoMigracion {
  return { nombre, sql };
}

describe("funcionesDefinidas", () => {
  it("extrae funciones calificadas, en minúsculas, ignorando comentarios e incluyendo procedimientos", () => {
    const sql = `
      -- create or replace function core.comentada() returns int
      create or replace function core.Claim_Batch(p integer) returns int language sql as $$ select 1 $$;
      CREATE FUNCTION rentas."cuenta"() returns int language sql as $$ select 2 $$;
      create or replace procedure core.proc() language sql as $$ select 3 $$;
    `;
    expect(funcionesDefinidas(sql)).toEqual(["core.claim_batch", "core.proc", "rentas.cuenta"]);
  });
});

describe("redefinicionesFueraDeOrden", () => {
  const base = [
    m("20240101000100_010_a.sql", "create or replace function core.f() returns int language sql as $$ select 1 $$;"),
    m("20240101000300_030_b.sql", "create or replace function core.f() returns int language sql as $$ select 2 $$;"),
  ];

  it("detecta una migración agregada con versión menor que otra existente que define la misma función", () => {
    const nueva = m("20240101000200_020_vieja.sql", "create or replace function core.f() returns int language sql as $$ select 9 $$;");
    expect(redefinicionesFueraDeOrden([...base, nueva], new Set([nueva.nombre]))).toEqual([
      { agregada: "20240101000200_020_vieja.sql", funcion: "core.f", posteriores: ["20240101000300_030_b.sql"] },
    ]);
  });

  it("no reporta una migración agregada con versión mayor (orden correcto)", () => {
    const nueva = m("20240101000400_040_nueva.sql", "create or replace function core.f() returns int language sql as $$ select 9 $$;");
    expect(redefinicionesFueraDeOrden([...base, nueva], new Set([nueva.nombre]))).toEqual([]);
  });

  it("no reporta el historial existente (A<B ya fusionadas) ni funciones distintas", () => {
    const nueva = m("20240101000200_020_otra.sql", "create or replace function core.g() returns int language sql as $$ select 9 $$;");
    expect(redefinicionesFueraDeOrden([...base, nueva], new Set([nueva.nombre]))).toEqual([]);
  });

  it("dos agregadas en la misma rama que redefinen la misma función entre sí no son conflicto (llegan juntas, en orden)", () => {
    const a = m("20240101000500_050_x.sql", "create or replace function core.h() returns int language sql as $$ select 1 $$;");
    const b = m("20240101000510_051_y.sql", "create or replace function core.h() returns int language sql as $$ select 2 $$;");
    expect(redefinicionesFueraDeOrden([...base, a, b], new Set([a.nombre, b.nombre]))).toEqual([]);
  });

  it("reporta varias posteriores, ordenadas", () => {
    const extra = m("20240101000350_035_c.sql", "create function core.f() returns int language sql as $$ select 3 $$;");
    const nueva = m("20240101000150_015_vieja.sql", "create or replace function core.f() returns int language sql as $$ select 9 $$;");
    expect(redefinicionesFueraDeOrden([...base, extra, nueva], new Set([nueva.nombre]))[0]?.posteriores).toEqual([
      "20240101000300_030_b.sql",
      "20240101000350_035_c.sql",
    ]);
  });
});
