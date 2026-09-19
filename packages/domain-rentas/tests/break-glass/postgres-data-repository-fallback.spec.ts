// Bloqueante 2 de la revisión real del PR #155 (ronda 1): el fallback 42883 de
// `PostgresBreakGlassRentasDataRepository` no tenía NINGÚN test -- los tests
// existentes (superadmin-break-glass.spec.ts, acceso.spec.ts) solo ejercitan
// `InMemoryBreakGlassRentasDataRepository`, que nunca simula el comportamiento
// real de una transacción de Postgres. Este archivo reproduce esa semántica: un
// `TenantDbSession` falso que, como Postgres real, deja la transacción "abortada"
// después de un SQLSTATE 42883 (`undefined_function`) -- cualquier `query()`
// posterior lanza 25P02 (`in_failed_sql_transaction`) hasta que un
// `exec("ROLLBACK TO SAVEPOINT ...")` la recupere. Sin el fix del bloqueante 1
// (SAVEPOINT antes de cada llamada + ROLLBACK TO SAVEPOINT en el catch de
// 42883), estos tests fallarían con 25P02 sin llegar nunca al resultado
// esperado -- son el regression guard real de ese fix, no solo una demostración.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresBreakGlassRentasDataRepository } from "../../src/break-glass/postgres-data-repository.ts";

function undefinedFunctionError(fnName: string): Error & { code: string } {
  const err = new Error(`function ${fnName} does not exist`) as Error & { code: string };
  err.code = "42883";
  return err;
}

function transactionAbortedError(): Error & { code: string } {
  const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
  err.code = "25P02";
  return err;
}

/**
 * Doble de `TenantDbSession` que reproduce la semántica REAL de una transacción
 * de Postgres alrededor de SAVEPOINT: nunca ejecuta SQL de verdad -- despacha por
 * el texto exacto de la query, mismo patrón que
 * packages/db/tests/postgres-core-repository-org-admin-fallback.spec.ts -- pero,
 * a diferencia de ese doble, modela el estado "transacción abortada":
 *
 * - Cualquier `respond()` que devuelva un error con `code: "42883"` deja la
 *   sesión abortada (`aborted = true`), igual que Postgres real ante una función
 *   inexistente.
 * - Mientras `aborted`, CUALQUIER `query()` posterior lanza 25P02 sin mirar los
 *   `handlers` -- exactamente el "commands ignored until end of transaction
 *   block" real.
 * - Mientras `aborted`, `exec()` SOLO acepta `ROLLBACK TO SAVEPOINT ...` (limpia
 *   `aborted`) -- cualquier otro `exec()`, incluido un `SAVEPOINT` nuevo,
 *   lanzaría 25P02 también en Postgres real.
 * - Sin estar abortada, `SAVEPOINT`/`RELEASE SAVEPOINT`/`ROLLBACK TO SAVEPOINT`
 *   son no-op (no hay estado de fila que deshacer en un SELECT de solo lectura).
 */
function abortableFakeSession(handlers: { match: RegExp; respond: () => unknown }[]): TenantDbSession {
  let aborted = false;
  return {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      if (aborted) throw transactionAbortedError();
      for (const h of handlers) {
        if (h.match.test(sql)) {
          const result = h.respond();
          if (result instanceof Error) {
            if ((result as { code?: string }).code === "42883") aborted = true;
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
        throw transactionAbortedError();
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

describe("PostgresBreakGlassRentasDataRepository.listReservasTenant -- fallback SQLSTATE 42883 contra transacción abortada", () => {
  it("función de 5 parámetros existe -> camino nuevo directo, sin tocar la sobrecarga vieja", async () => {
    const session = abortableFakeSession([
      {
        match: /^select \* from rentas\.list_reservas_for_break_glass\(\$1, \$2, \$3, \$4, \$5\);$/,
        respond: () => [
          { ocupacion_id: "r1", property_id: "p1", unidad_id: "u1", check_in: "2026-01-01", check_out: "2026-01-03", estado: "confirmada", huesped_nombre: "Ana", huesped_contacto: null },
        ],
      },
      { match: /^select \* from rentas\.list_reservas_for_break_glass\(\$1, \$2\);$/, respond: () => new Error("no debería llamarse -- la función nueva SÍ existe") },
    ]);
    const repo = new PostgresBreakGlassRentasDataRepository(session);

    const result = await repo.listReservasTenant(ORG_ID, CALLER_ID);

    expect(result).toEqual([{ ocupacionId: "r1", propertyId: "p1", unidadId: "u1", checkIn: "2026-01-01", checkOut: "2026-01-03", estado: "confirmada", huespedNombre: "Ana", huespedContacto: null }]);
  });

  it("42883 en la función de 5 parámetros -> SAVEPOINT+ROLLBACK TO SAVEPOINT recuperan la transacción y la sobrecarga vieja de 2 parámetros sí responde (sin 25P02)", async () => {
    const session = abortableFakeSession([
      { match: /^select \* from rentas\.list_reservas_for_break_glass\(\$1, \$2, \$3, \$4, \$5\);$/, respond: () => undefinedFunctionError("rentas.list_reservas_for_break_glass(uuid,uuid,uuid,int,int)") },
      {
        match: /^select \* from rentas\.list_reservas_for_break_glass\(\$1, \$2\);$/,
        respond: () => [
          { ocupacion_id: "r1", property_id: "p1", unidad_id: "u1", check_in: "2026-01-01", check_out: "2026-01-03", estado: "confirmada", huesped_nombre: "Ana", huesped_contacto: null },
          { ocupacion_id: "r2", property_id: "p2", unidad_id: "u2", check_in: "2026-02-01", check_out: "2026-02-03", estado: "confirmada", huesped_nombre: "Beto", huesped_contacto: null },
        ],
      },
    ]);
    const repo = new PostgresBreakGlassRentasDataRepository(session);

    // Sin el ROLLBACK TO SAVEPOINT del bloqueante 1, esta llamada lanzaría 25P02
    // (transacción abortada) en vez de devolver la fila de la sobrecarga vieja.
    const result = await repo.listReservasTenant(ORG_ID, CALLER_ID);

    expect(result.map((r) => r.ocupacionId)).toEqual(["r1", "r2"]);
  });

  it("42883 recuperado + filtro por propiedad aplicado en TypeScript sobre el resultado de la sobrecarga vieja (Postgres no filtra del lado del servidor sin la migración 020)", async () => {
    const session = abortableFakeSession([
      { match: /^select \* from rentas\.list_reservas_for_break_glass\(\$1, \$2, \$3, \$4, \$5\);$/, respond: () => undefinedFunctionError("rentas.list_reservas_for_break_glass(uuid,uuid,uuid,int,int)") },
      {
        match: /^select \* from rentas\.list_reservas_for_break_glass\(\$1, \$2\);$/,
        respond: () => [
          { ocupacion_id: "r1", property_id: "p1", unidad_id: "u1", check_in: "2026-01-01", check_out: "2026-01-03", estado: "confirmada", huesped_nombre: "Ana", huesped_contacto: null },
          { ocupacion_id: "r2", property_id: "p2", unidad_id: "u2", check_in: "2026-02-01", check_out: "2026-02-03", estado: "confirmada", huesped_nombre: "Beto", huesped_contacto: null },
        ],
      },
    ]);
    const repo = new PostgresBreakGlassRentasDataRepository(session);

    const result = await repo.listReservasTenant(ORG_ID, CALLER_ID, { propertyId: "p2" });

    expect(result.map((r) => r.ocupacionId)).toEqual(["r2"]);
  });

  it("la transacción sigue usable DESPUÉS del fallback -- una query posterior (mismo patrón que el INSERT de bitácora de acceso.ts) no lanza 25P02", async () => {
    const session = abortableFakeSession([
      { match: /^select \* from rentas\.list_reservas_for_break_glass\(\$1, \$2, \$3, \$4, \$5\);$/, respond: () => undefinedFunctionError("rentas.list_reservas_for_break_glass(uuid,uuid,uuid,int,int)") },
      { match: /^select \* from rentas\.list_reservas_for_break_glass\(\$1, \$2\);$/, respond: () => [] },
      { match: /insert into rentas\.break_glass_access_log/, respond: () => [{ id: "audit-1" }] },
    ]);
    const repo = new PostgresBreakGlassRentasDataRepository(session);

    await repo.listReservasTenant(ORG_ID, CALLER_ID);
    // Simula la escritura de bitácora que acceso.ts ejecuta en la MISMA sesión,
    // después de que el lector ya respondió -- si la transacción siguiera
    // abortada (bug del bloqueante 1), esto lanzaría 25P02 en vez de responder.
    await expect(session.query("insert into rentas.break_glass_access_log (...) values (...) returning id;")).resolves.toEqual({ rows: [{ id: "audit-1" }] });
  });
});

describe("PostgresBreakGlassRentasDataRepository -- los 6 lectores nuevos, fallback SQLSTATE 42883 contra transacción abortada", () => {
  it("listFinanzasTenant: función existe -> mapea la fila real", async () => {
    const session = abortableFakeSession([
      {
        match: /^select \* from rentas\.list_finanzas_for_break_glass/,
        respond: () => [
          {
            id: "f1",
            ocupacion_id: "r1",
            property_id: "p1",
            moneda: "MXN",
            monto_bruto_centavos: "100000",
            comision_canal_centavos: "10000",
            comision_gestor_centavos: "5000",
            gastos_centavos: "0",
            impuestos_centavos: "16000",
            neto_centavos: "69000",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ]);
    const repo = new PostgresBreakGlassRentasDataRepository(session);

    const result = await repo.listFinanzasTenant(ORG_ID, CALLER_ID);

    expect(result).toEqual([
      { id: "f1", ocupacionId: "r1", propertyId: "p1", moneda: "MXN", montoBrutoCentavos: 100000, comisionCanalCentavos: 10000, comisionGestorCentavos: 5000, gastosCentavos: 0, impuestosCentavos: 16000, netoCentavos: 69000, createdAtMs: new Date("2026-01-01T00:00:00.000Z").getTime() },
    ]);
  });

  it("listFinanzasTenant: 42883 -> vacío honesto SIN romper la transacción para una query posterior (mismo patrón de bitácora)", async () => {
    const session = abortableFakeSession([
      { match: /^select \* from rentas\.list_finanzas_for_break_glass/, respond: () => undefinedFunctionError("rentas.list_finanzas_for_break_glass(uuid,uuid,uuid,int,int)") },
      { match: /insert into rentas\.break_glass_access_log/, respond: () => [{ id: "audit-2" }] },
    ]);
    const repo = new PostgresBreakGlassRentasDataRepository(session);

    const result = await repo.listFinanzasTenant(ORG_ID, CALLER_ID);
    expect(result).toEqual([]);

    // Regression guard del bloqueante 1 para los 6 lectores nuevos: sin
    // ROLLBACK TO SAVEPOINT, esta query posterior (el INSERT de bitácora real de
    // acceso.ts, misma sesión/transacción) lanzaría 25P02.
    await expect(session.query("insert into rentas.break_glass_access_log (...) values (...) returning id;")).resolves.toEqual({ rows: [{ id: "audit-2" }] });
  });

  it("listSyncIcalTenant: 42883 -> vacío honesto SIN romper la transacción (URL de import nunca llega a mapearse si la función no existe)", async () => {
    const session = abortableFakeSession([{ match: /^select \* from rentas\.list_sync_ical_for_break_glass/, respond: () => undefinedFunctionError("rentas.list_sync_ical_for_break_glass(uuid,uuid,uuid,int,int)") }]);
    const repo = new PostgresBreakGlassRentasDataRepository(session);

    const result = await repo.listSyncIcalTenant(ORG_ID, CALLER_ID);

    expect(result).toEqual([]);
    // La sesión debe quedar recuperada (no abortada) -- una query trivial
    // posterior no debe lanzar 25P02.
    await expect(session.query("select 1;")).rejects.toThrow(/ninguna regla coincide/);
  });

  it("cualquier OTRO código de error (no 42883) se repropaga tal cual -- el fallback NUNCA enmascara un fallo real", async () => {
    const otherError = new Error("connection terminated unexpectedly") as Error & { code: string };
    otherError.code = "57P01";
    const session = abortableFakeSession([{ match: /^select \* from rentas\.list_payouts_for_break_glass/, respond: () => otherError }]);
    const repo = new PostgresBreakGlassRentasDataRepository(session);

    await expect(repo.listPayoutsTenant(ORG_ID, CALLER_ID)).rejects.toMatchObject({ code: "57P01" });
  });
});
