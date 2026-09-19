// Hallazgo de revisión real (ronda r5): las 7 funciones `security definer` de
// `020_break_glass_lectores.sql` lanzan SQLSTATE `P0002` ("la propiedad
// indicada no pertenece a esta organización") y `42501` (defensa en
// profundidad -- caller distinto de `auth.uid()` / no-superadmin / sin sesión
// de romper-cristal vigente) -- antes de este fix, `PostgresBreakGlassRentas
// DataRepository` los repropagaba tal cual (solo distinguía SQLSTATE 42883,
// ver postgres-data-repository-fallback.spec.ts) y `apps/api` tampoco los
// mapeaba, terminando en un 500 genérico. Este archivo cubre la traducción
// real: SQLSTATE -> error tipado, CON `ROLLBACK TO SAVEPOINT` (la transacción
// debe quedar recuperada, nunca abortada, para que el llamador -- p.ej. el
// resto de una misma sesión HTTP -- pueda seguir usándola).
//
// También cubre el segundo hallazgo de la misma ronda: `fecha_payout`/
// `vigente_desde`/`fecha_check_in`/`fecha_check_out`/`programada_para` son
// columnas `date` -- el driver `pg` real las entrega como objeto `Date`
// (medianoche LOCAL del proceso), nunca como texto, aunque los tipos
// declarados dicen `string`. `dateColumnToYmd` debe leer los COMPONENTES
// LOCALES del objeto (nunca UTC) para no desplazar la fecha un día en un
// proceso con offset horario positivo.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { BreakGlassAccessDeniedError, BreakGlassPropertyNotFoundError } from "../../src/break-glass/errors.ts";
import { PostgresBreakGlassRentasDataRepository } from "../../src/break-glass/postgres-data-repository.ts";

function pgError(message: string, code: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/**
 * Doble de `TenantDbSession` -- mismo patrón que
 * postgres-data-repository-fallback.spec.ts::abortableFakeSession, pero
 * generalizado: CUALQUIER error (no solo 42883) dentro de un SAVEPOINT deja
 * la transacción "abortada" en este doble, tal como Postgres real -- ninguna
 * sentencia posterior (aparte de `ROLLBACK TO SAVEPOINT`) sobrevive a una
 * excepción real dentro de una transacción.
 */
function abortableFakeSession(handlers: { match: RegExp; respond: () => unknown }[]): TenantDbSession {
  let aborted = false;
  return {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      if (aborted) throw pgError("current transaction is aborted, commands ignored until end of transaction block", "25P02");
      for (const h of handlers) {
        if (h.match.test(sql)) {
          const result = h.respond();
          if (result instanceof Error) {
            aborted = true;
            throw result;
          }
          return { rows: result as T[] };
        }
      }
      throw new Error(`abortableFakeSession: ninguna regla coincide con la query -> ${sql}`);
    },
    async exec(sql: string): Promise<void> {
      const trimmed = sql.trim();
      if (aborted) {
        if (/^rollback to savepoint\b/i.test(trimmed)) {
          aborted = false;
          return;
        }
        throw pgError("current transaction is aborted, commands ignored until end of transaction block", "25P02");
      }
      if (/^savepoint\b/i.test(trimmed) || /^release savepoint\b/i.test(trimmed) || /^rollback to savepoint\b/i.test(trimmed)) {
        return;
      }
      throw new Error(`abortableFakeSession: exec() no reconocido -> ${sql}`);
    },
  };
}

const ORG_ID = "00000000-0000-0000-0000-0000000000aa";
const CALLER_ID = "00000000-0000-0000-0000-0000000000cc";
const PROPERTY_ID_AJENA = "00000000-0000-0000-0000-0000000000ff";

describe("PostgresBreakGlassRentasDataRepository -- mapeo de SQLSTATE P0002/42501 a errores tipados, con recuperación real de la transacción", () => {
  const casos: Array<{
    nombre: string;
    invocar: (repo: PostgresBreakGlassRentasDataRepository) => Promise<unknown>;
    match5Params: RegExp;
    savepoint: string;
  }> = [
    { nombre: "reservas", invocar: (repo) => repo.listReservasTenant(ORG_ID, CALLER_ID, { propertyId: PROPERTY_ID_AJENA }), match5Params: /^select \* from rentas\.list_reservas_for_break_glass\(\$1, \$2, \$3, \$4, \$5\);$/, savepoint: "sp_break_glass_reservas" },
    { nombre: "finanzas", invocar: (repo) => repo.listFinanzasTenant(ORG_ID, CALLER_ID, { propertyId: PROPERTY_ID_AJENA }), match5Params: /^select \* from rentas\.list_finanzas_for_break_glass/, savepoint: "sp_break_glass_finanzas" },
    { nombre: "payouts", invocar: (repo) => repo.listPayoutsTenant(ORG_ID, CALLER_ID, { propertyId: PROPERTY_ID_AJENA }), match5Params: /^select \* from rentas\.list_payouts_for_break_glass/, savepoint: "sp_break_glass_payouts" },
    { nombre: "pricing", invocar: (repo) => repo.listPricingTenant(ORG_ID, CALLER_ID, { propertyId: PROPERTY_ID_AJENA }), match5Params: /^select \* from rentas\.list_pricing_for_break_glass/, savepoint: "sp_break_glass_pricing" },
    { nombre: "mensajeria", invocar: (repo) => repo.listMensajeriaTenant(ORG_ID, CALLER_ID, { propertyId: PROPERTY_ID_AJENA }), match5Params: /^select \* from rentas\.list_mensajeria_for_break_glass/, savepoint: "sp_break_glass_mensajeria" },
    { nombre: "limpieza", invocar: (repo) => repo.listLimpiezaTenant(ORG_ID, CALLER_ID, { propertyId: PROPERTY_ID_AJENA }), match5Params: /^select \* from rentas\.list_limpieza_for_break_glass/, savepoint: "sp_break_glass_limpieza" },
    { nombre: "sync_ical", invocar: (repo) => repo.listSyncIcalTenant(ORG_ID, CALLER_ID, { propertyId: PROPERTY_ID_AJENA }), match5Params: /^select \* from rentas\.list_sync_ical_for_break_glass/, savepoint: "sp_break_glass_sync_ical" },
  ];

  for (const caso of casos) {
    it(`${caso.nombre}: P0002 (propiedad ajena) -> BreakGlassPropertyNotFoundError, NUNCA cae al fallback de 42883, y la transacción queda recuperada (una query posterior no lanza 25P02)`, async () => {
      const session = abortableFakeSession([
        { match: caso.match5Params, respond: () => pgError("la propiedad indicada no pertenece a esta organización", "P0002") },
        // Si el código cayera (por error) al mismo camino que 42883, esta regla
        // respondería -- su sola presencia sirve de guard: si se llamara,
        // devolvería datos reales en vez de propagar el error, lo cual haría
        // fallar la aserción de abajo (`rejects.toBeInstanceOf`).
        { match: /^select \* from rentas\.list_reservas_for_break_glass\(\$1, \$2\);$/, respond: () => [] },
      ]);
      const repo = new PostgresBreakGlassRentasDataRepository(session);

      await expect(caso.invocar(repo)).rejects.toBeInstanceOf(BreakGlassPropertyNotFoundError);

      // La transacción quedó recuperada (ROLLBACK TO SAVEPOINT ya corrió) --
      // una query trivial posterior (mismo patrón que el INSERT de bitácora
      // que acceso.ts NUNCA llega a ejecutar aquí, porque el lector lanzó
      // antes) no debe heredar el estado abortado.
      await expect(session.query("select 1;")).rejects.toThrow(/ninguna regla coincide/);
    });

    it(`${caso.nombre}: 42501 (defensa en profundidad de Postgres) -> BreakGlassAccessDeniedError, transacción recuperada`, async () => {
      const session = abortableFakeSession([{ match: caso.match5Params, respond: () => pgError("forbidden", "42501") }]);
      const repo = new PostgresBreakGlassRentasDataRepository(session);

      await expect(caso.invocar(repo)).rejects.toBeInstanceOf(BreakGlassAccessDeniedError);
      await expect(session.query("select 1;")).rejects.toThrow(/ninguna regla coincide/);
    });
  }

  it("el mensaje de BreakGlassAccessDeniedError nunca expone el mensaje CRUDO de la excepción SQL (ninguna de las 3 condiciones se filtra al llamador)", async () => {
    const mensajeCrudoDePostgres = "list_reservas_for_break_glass: el caller autenticado debe coincidir con p_caller_id";
    const session = abortableFakeSession([{ match: /^select \* from rentas\.list_reservas_for_break_glass\(\$1, \$2, \$3, \$4, \$5\);$/, respond: () => pgError(mensajeCrudoDePostgres, "42501") }]);
    const repo = new PostgresBreakGlassRentasDataRepository(session);

    await expect(repo.listReservasTenant(ORG_ID, CALLER_ID)).rejects.toMatchObject({ message: expect.not.stringContaining(mensajeCrudoDePostgres) });
  });
});

describe("PostgresBreakGlassRentasDataRepository -- normalización de columnas `date` a 'YYYY-MM-DD', sin pasar por zona horaria", () => {
  // Construye el MISMO objeto que el parser default de `pg` produce para una
  // columna `date`: `new Date(year, month0, day)` -- medianoche LOCAL del
  // proceso, nunca UTC. Usar esta misma forma en el fixture (en vez de un
  // string ISO) es lo que hace que este test sea un regression guard real del
  // bug: antes del fix, `r.fecha_payout` (etc.) se pasaba tal cual al campo
  // declarado `string`, filtrando este objeto `Date` intacto.
  function fakeDateColumn(year: number, month1based: number, day: number): Date {
    return new Date(year, month1based - 1, day);
  }

  it("listPayoutsTenant: fechaPayout llega como 'YYYY-MM-DD', nunca como objeto Date ni desplazada un día", async () => {
    const session = abortableFakeSession([
      {
        match: /^select \* from rentas\.list_payouts_for_break_glass/,
        respond: () => [
          { id: "p1", property_id: "prop1", canal_id: "canal1", referencia_externa: null, moneda: "MXN", monto_total_centavos: "100000", fecha_payout: fakeDateColumn(2026, 1, 15), creado_en: "2026-01-15T00:00:00.000Z" },
        ],
      },
    ]);
    const repo = new PostgresBreakGlassRentasDataRepository(session);

    const result = await repo.listPayoutsTenant(ORG_ID, CALLER_ID);

    expect(result.datos[0]!.fechaPayout).toBe("2026-01-15");
    expect(typeof result.datos[0]!.fechaPayout).toBe("string");
  });

  it("listPricingTenant: vigenteDesde llega como 'YYYY-MM-DD'", async () => {
    const session = abortableFakeSession([
      { match: /^select \* from rentas\.list_pricing_for_break_glass/, respond: () => [{ id: "t1", property_id: "prop1", unidad_id: "u1", precio_noche_centavos: "150000", moneda: "MXN", vigente_desde: fakeDateColumn(2026, 12, 1) }] },
    ]);
    const repo = new PostgresBreakGlassRentasDataRepository(session);

    const result = await repo.listPricingTenant(ORG_ID, CALLER_ID);

    expect(result.datos[0]!.vigenteDesde).toBe("2026-12-01");
  });

  it("listMensajeriaTenant: fechaCheckIn/fechaCheckOut llegan como 'YYYY-MM-DD', y null se preserva tal cual (nunca se le aplica el normalizador)", async () => {
    const session = abortableFakeSession([
      {
        match: /^select \* from rentas\.list_mensajeria_for_break_glass/,
        respond: () => [
          { id: "c1", property_id: "prop1", unidad_id: "u1", canal_codigo: "airbnb", huesped_nombre: "Ana", fecha_check_in: fakeDateColumn(2026, 10, 1), fecha_check_out: null, reserva_confirmada: true, creado_en: "2026-09-01T00:00:00.000Z" },
        ],
      },
    ]);
    const repo = new PostgresBreakGlassRentasDataRepository(session);

    const result = await repo.listMensajeriaTenant(ORG_ID, CALLER_ID);

    expect(result.datos[0]!.fechaCheckIn).toBe("2026-10-01");
    expect(result.datos[0]!.fechaCheckOut).toBeNull();
  });

  it("listLimpiezaTenant: programadaPara llega como 'YYYY-MM-DD'", async () => {
    const session = abortableFakeSession([
      {
        match: /^select \* from rentas\.list_limpieza_for_break_glass/,
        respond: () => [{ id: "tarea1", property_id: "prop1", unidad_id: "u1", tipo: "limpieza", estado: "pendiente", prioridad: "media", programada_para: fakeDateColumn(2026, 9, 22), completada_en: null, creado_en: "2026-09-01T00:00:00.000Z" }],
      },
    ]);
    const repo = new PostgresBreakGlassRentasDataRepository(session);

    const result = await repo.listLimpiezaTenant(ORG_ID, CALLER_ID);

    expect(result.datos[0]!.programadaPara).toBe("2026-09-22");
  });

  it("el normalizador lee los componentes LOCALES del objeto Date, nunca UTC -- una fecha 'de calendario' arbitraria sobrevive sin desplazarse", async () => {
    // Regression guard directo del riesgo documentado: si el código usara
    // `toISOString().slice(0, 10)` (UTC) en vez de los getters locales, esta
    // fecha se desplazaría un día en cualquier proceso con offset horario
    // POSITIVO (ej. Europa/Asia) -- el propio helper (`dateColumnToYmd`) debe
    // dar el MISMO resultado sin importar la zona horaria del proceso que
    // corre la prueba, porque nunca pasa por UTC.
    const fecha = fakeDateColumn(2026, 3, 31);
    const session = abortableFakeSession([
      { match: /^select \* from rentas\.list_pricing_for_break_glass/, respond: () => [{ id: "t1", property_id: "prop1", unidad_id: "u1", precio_noche_centavos: "1", moneda: "MXN", vigente_desde: fecha }] },
    ]);
    const repo = new PostgresBreakGlassRentasDataRepository(session);

    const result = await repo.listPricingTenant(ORG_ID, CALLER_ID);

    expect(result.datos[0]!.vigenteDesde).toBe(`${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}-${String(fecha.getDate()).padStart(2, "0")}`);
    expect(result.datos[0]!.vigenteDesde).toBe("2026-03-31");
  });
});
