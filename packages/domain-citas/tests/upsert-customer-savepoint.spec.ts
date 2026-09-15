// Fix hallazgo auditoría (rubro 3, "recuperación de 23505 sin SAVEPOINT deriva en
// 25P02") — regresión para `PostgresCitasRepository.upsertCustomer`. Mismo doble de
// prueba (y misma verificación empírica contra un Postgres real con dos conexiones
// concurrentes) que packages/domain-restaurantes/tests/upsert-customer-savepoint.spec.ts
// — ver ese archivo de cabecera para el detalle del comportamiento de Postgres que
// esto modela: una vez que una consulta dentro de una transacción lanza un error,
// CUALQUIER consulta posterior sin pasar por `ROLLBACK TO SAVEPOINT` falla con 25P02.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";

function pgUniqueViolation(): Error & { code: string } {
  const err = new Error('duplicate key value violates unique constraint "customers_organization_id_phone_key"') as Error & { code: string };
  err.code = "23505";
  return err;
}

class AbortAwareFakeSession implements TenantDbSession {
  aborted = false;
  readonly calls: string[] = [];
  winnerRow = { id: "winner-id", organization_id: "org-1", full_name: "Ganador de la carrera", phone: "9990001111", email: null as string | null };

  async query<T>(sql: string, _params?: unknown[]): Promise<{ rows: T[] }> {
    const normalized = sql.trim().toLowerCase();
    this.calls.push(normalized.split("\n")[0]!);
    if (this.aborted) {
      const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
      err.code = "25P02";
      throw err;
    }
    if (normalized.startsWith("select") && normalized.includes("from citas.customers")) {
      return { rows: (this.calls.filter((c) => c.startsWith("select")).length > 1 ? [this.winnerRow] : []) as unknown as T[] };
    }
    if (normalized.startsWith("insert into citas.customers")) {
      // Mismo efecto que Postgres real: el error de la propia query deja la
      // transacción abortada para CUALQUIER consulta posterior (hasta un `ROLLBACK
      // TO SAVEPOINT`), no solo lanza el error al llamador.
      this.aborted = true;
      throw pgUniqueViolation();
    }
    if (normalized.startsWith("update citas.customers")) {
      return { rows: [this.winnerRow] as unknown as T[] };
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

describe("PostgresCitasRepository.upsertCustomer — recuperación de 23505 con SAVEPOINT", () => {
  it("recupera la fila ganadora de la carrera en vez de propagar 25P02", async () => {
    const session = new AbortAwareFakeSession();
    const repo = new PostgresCitasRepository(session);
    const result = await repo.upsertCustomer("org-1", "9990001111", "Nombre nuevo");

    expect(result.id).toBe("winner-id");
    expect(session.calls).toContain("savepoint sp_upsert_customer_race");
    expect(session.calls).toContain("rollback to savepoint sp_upsert_customer_race");
    expect(session.calls).toContain("release savepoint sp_upsert_customer_race");
  });

  it("sin el SAVEPOINT, la misma secuencia de consultas SÍ deriva en 25P02 (prueba de que el bug era real)", async () => {
    const session = new AbortAwareFakeSession();
    await expect(
      (async () => {
        try {
          await session.query("insert into citas.customers (...) values (...) returning ...;", []);
        } catch {
          session.aborted = true;
        }
        return session.query("select id from citas.customers where organization_id=$1 and phone=$2;", []);
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});
