// sql-errors.ts -- clasificación endurecida de SQLSTATE (hallazgo de
// revisores del 19-sep, rubro B): `isUndefinedFunctionError` YA existía
// (SQLSTATE 42883), pero un `code === "42883"` a secas trata "operator does
// not exist" (bug real de tipos) igual que "function ... does not exist"
// (migración pendiente, el caso normal de este monorepo). Los mensajes
// exactos de abajo se verificaron contra Postgres real (`initdb`/`pg_ctl`
// efímero, 19-sep-2026):
//   `select core.nonexistent_fn_xyz();`                        -> SQLSTATE 42883, "function nonexistent_fn_xyz() does not exist"
//   `select '<uuid>'::uuid = 'x'::text;`                        -> SQLSTATE 42883, "operator does not exist: uuid = text"
// (ver también `scripts/verify-superadmin-resumen/assertions.sql`, escenario
// que reproduce ambos casos con el mismo texto real).
import { describe, expect, it } from "vitest";
import { isMigrationPendingError, isNoUniqueOrExclusionConstraintError, isUndefinedColumnError, isUndefinedFunctionError, isUndefinedTableError } from "../src/sql-errors.ts";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("isUndefinedFunctionError", () => {
  it("42883 con mensaje 'function ... does not exist' (calificada por schema) -> true", () => {
    expect(isUndefinedFunctionError(pgError("42883", "function core.get_daily_ops_summary_for_superadmin(uuid, date) does not exist"))).toBe(true);
  });

  it("42883 con mensaje 'function ... does not exist' (sin schema, verificado contra Postgres real) -> true", () => {
    expect(isUndefinedFunctionError(pgError("42883", "function nonexistent_fn_xyz() does not exist"))).toBe(true);
  });

  it("HALLAZGO ENDURECIDO: 42883 con mensaje 'operator does not exist: uuid = text' (verificado contra Postgres real) -> false, NUNCA se confunde con migración pendiente", () => {
    expect(isUndefinedFunctionError(pgError("42883", "operator does not exist: uuid = text"))).toBe(false);
  });

  it("42883 con mensaje 'operator does not exist' de cualquier otro par de tipos -> false", () => {
    expect(isUndefinedFunctionError(pgError("42883", "operator does not exist: bigint = text"))).toBe(false);
  });

  it("código distinto de 42883 -> false, sin importar el mensaje", () => {
    expect(isUndefinedFunctionError(pgError("42P01", "function core.foo() does not exist"))).toBe(false);
  });

  it("sin .code (no es un error de pg) -> false", () => {
    expect(isUndefinedFunctionError(new Error("function core.foo() does not exist"))).toBe(false);
    expect(isUndefinedFunctionError("boom")).toBe(false);
    expect(isUndefinedFunctionError(null)).toBe(false);
    expect(isUndefinedFunctionError(undefined)).toBe(false);
  });

  describe("expectedFunctionName -- exige que el mensaje mencione la función sondeada", () => {
    it("el mensaje SÍ menciona el nombre esperado -> true", () => {
      expect(isUndefinedFunctionError(pgError("42883", "function core.get_daily_ops_summary_for_superadmin(uuid, date) does not exist"), "core.get_daily_ops_summary_for_superadmin")).toBe(true);
    });

    it("el mensaje menciona OTRA función (p. ej. una función interna llamada dentro de la que sí existe) -> false, no se confunde con la función sondeada", () => {
      expect(isUndefinedFunctionError(pgError("42883", "function core.alguna_funcion_interna_distinta(uuid) does not exist"), "core.get_daily_ops_summary_for_superadmin")).toBe(false);
    });

    it("sin expectedFunctionName -- cualquier 'function ... does not exist' cuenta (comportamiento previo)", () => {
      expect(isUndefinedFunctionError(pgError("42883", "function core.alguna_otra_funcion() does not exist"))).toBe(true);
    });
  });
});

describe("isUndefinedTableError / isUndefinedColumnError", () => {
  it("42P01 -> true para isUndefinedTableError, sin ambigüedad de mensaje que revisar", () => {
    expect(isUndefinedTableError(pgError("42P01", "relation \"core.daily_ops_summary\" does not exist"))).toBe(true);
    expect(isUndefinedTableError(pgError("42883", "function core.foo() does not exist"))).toBe(false);
  });

  it("42703 -> true para isUndefinedColumnError", () => {
    expect(isUndefinedColumnError(pgError("42703", "column d.seq does not exist"))).toBe(true);
    expect(isUndefinedColumnError(pgError("42P01", "relation does not exist"))).toBe(false);
  });
});

describe("isNoUniqueOrExclusionConstraintError -- 42P10 (ON CONFLICT sin índice unique todavía, f2-despachos-fiscal-deadline-unique)", () => {
  it("42P10 -> true, sin ambigüedad de mensaje que revisar (verificado contra Postgres real)", () => {
    expect(
      isNoUniqueOrExclusionConstraintError(
        pgError("42P10", "there is no unique or exclusion constraint matching the ON CONFLICT specification"),
      ),
    ).toBe(true);
  });

  it("código distinto de 42P10 -> false", () => {
    expect(isNoUniqueOrExclusionConstraintError(pgError("23505", "duplicate key value violates unique constraint"))).toBe(false);
  });

  it("sin .code (no es un error de pg) -> false", () => {
    expect(isNoUniqueOrExclusionConstraintError(new Error("boom"))).toBe(false);
    expect(isNoUniqueOrExclusionConstraintError(null)).toBe(false);
    expect(isNoUniqueOrExclusionConstraintError(undefined)).toBe(false);
  });
});

describe("isMigrationPendingError -- clasificación compartida 42883/42P01/42703", () => {
  it("42883 'function ... does not exist' -> true", () => {
    expect(isMigrationPendingError(pgError("42883", "function core.foo() does not exist"))).toBe(true);
  });

  it("42P01 -> true", () => {
    expect(isMigrationPendingError(pgError("42P01", "relation core.daily_ops_summary does not exist"))).toBe(true);
  });

  it("42703 -> true", () => {
    expect(isMigrationPendingError(pgError("42703", "column fecha does not exist"))).toBe(true);
  });

  it("HALLAZGO ENDURECIDO: 42883 'operator does not exist' -> false, se propaga como error real", () => {
    expect(isMigrationPendingError(pgError("42883", "operator does not exist: uuid = text"))).toBe(false);
  });

  it("cualquier otro SQLSTATE (p. ej. una desconexión) -> false", () => {
    expect(isMigrationPendingError(pgError("57P01", "terminating connection due to administrator command"))).toBe(false);
  });

  it("expectedFunctionName se reenvía a isUndefinedFunctionError -- sin efecto sobre 42P01/42703", () => {
    expect(isMigrationPendingError(pgError("42883", "function core.otra_funcion() does not exist"), "core.get_daily_ops_summary_for_superadmin")).toBe(false);
    expect(isMigrationPendingError(pgError("42P01", "relation core.daily_ops_summary does not exist"), "core.get_daily_ops_summary_for_superadmin")).toBe(true);
  });
});
