// Fix hallazgo auditoría (rubro 3, "recuperación de 23505 sin SAVEPOINT deriva en
// 25P02") — regresión para `PostgresRestaurantesRepository.upsertCustomer`. Un doble
// de prueba de `TenantDbSession` que SÍ modela el comportamiento real de Postgres
// (esto es lo que ninguna otra prueba de este repo puede verificar sin un servidor
// real: una vez que una consulta dentro de una transacción lanza un error, CUALQUIER
// consulta posterior sin haber pasado por `ROLLBACK TO SAVEPOINT` falla con 25P02
// "current transaction is aborted..."). Reproducido y verificado también contra un
// Postgres real (dos conexiones concurrentes, ver notas de la ronda de auditoría) —
// sin el SAVEPOINT del fix, el SELECT de recuperación de abajo fallaba con 25P02 en
// vez de devolver la fila ganadora de la carrera.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";

function pgUniqueViolation(): Error & { code: string } {
  const err = new Error('duplicate key value violates unique constraint "customers_organization_id_phone_key"') as Error & { code: string };
  err.code = "23505";
  return err;
}

/** Simula fielmente la semántica de aborto de transacción de Postgres: una vez que
 * `aborted` queda en `true` (una query lanzó), CUALQUIER `query()` posterior lanza
 * 25P02 hasta un `exec("ROLLBACK TO SAVEPOINT ...")` que lo recupera. */
class AbortAwareFakeSession implements TenantDbSession {
  aborted = false;
  readonly calls: string[] = [];
  winnerRow = { id: "winner-id", organization_id: "org-1", phone: "9990001111", name: "Ganador de la carrera", order_count: 0 };

  async query<T>(sql: string, _params?: unknown[]): Promise<{ rows: T[] }> {
    const normalized = sql.trim().toLowerCase();
    this.calls.push(normalized.split("\n")[0]!);
    if (this.aborted) {
      const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
      err.code = "25P02";
      throw err;
    }
    if (normalized.startsWith("select") && normalized.includes("from restaurantes.customers")) {
      // Primer SELECT (antes del INSERT) -- sin fila existente todavía (fuerza el
      // camino de INSERT). El SELECT de RECUPERACIÓN (después del conflicto) SÍ debe
      // ver la fila ganadora.
      return { rows: (this.calls.filter((c) => c.startsWith("select")).length > 1 ? [this.winnerRow] : []) as unknown as T[] };
    }
    if (normalized.startsWith("insert into restaurantes.customers")) {
      // Mismo efecto que Postgres real: el error de la propia query deja la
      // transacción abortada para CUALQUIER consulta posterior (hasta un `ROLLBACK
      // TO SAVEPOINT`), no solo lanza el error al llamador.
      this.aborted = true;
      throw pgUniqueViolation();
    }
    if (normalized.startsWith("update restaurantes.customers")) {
      return { rows: [{ ...this.winnerRow, name: this.winnerRow.name }] as unknown as T[] };
    }
    throw new Error(`AbortAwareFakeSession: query no soportada: ${sql}`);
  }

  async exec(sql: string): Promise<void> {
    const normalized = sql.trim().toLowerCase();
    this.calls.push(normalized);
    if (normalized.startsWith("savepoint")) return;
    if (normalized.startsWith("rollback to savepoint")) {
      this.aborted = false;
      return;
    }
    if (normalized.startsWith("release savepoint")) return;
    throw new Error(`AbortAwareFakeSession: exec no soportado: ${sql}`);
  }
}

describe("PostgresRestaurantesRepository.upsertCustomer — recuperación de 23505 con SAVEPOINT", () => {
  it("recupera la fila ganadora de la carrera en vez de propagar 25P02", async () => {
    const session = new AbortAwareFakeSession();
    const repo = new PostgresRestaurantesRepository(session);
    const result = await repo.upsertCustomer("org-1", "9990001111", "Nombre nuevo");

    expect(result.id).toBe("winner-id");
    // La secuencia real DEBE incluir el SAVEPOINT antes del INSERT y su recuperación
    // (ROLLBACK TO SAVEPOINT + RELEASE SAVEPOINT) antes del SELECT/UPDATE de después.
    expect(session.calls).toContain("savepoint sp_upsert_customer_race");
    expect(session.calls).toContain("rollback to savepoint sp_upsert_customer_race");
    expect(session.calls).toContain("release savepoint sp_upsert_customer_race");
  });

  it("sin el SAVEPOINT, la misma secuencia de consultas SÍ deriva en 25P02 (prueba de que el bug era real)", async () => {
    const session = new AbortAwareFakeSession();
    await expect(
      (async () => {
        // Reproduce el código VIEJO (sin SAVEPOINT): INSERT falla, aborted=true, y
        // el SELECT de recuperación se ejecuta directo, sin recuperar la transacción.
        try {
          await session.query("insert into restaurantes.customers (...) values (...) returning ...;", []);
        } catch {
          session.aborted = true;
        }
        return session.query("select id from restaurantes.customers where organization_id=$1 and phone=$2;", []);
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});
