// AbortAwareFakeSession — doble de prueba GENÉRICO que reproduce la semántica REAL de
// una transacción de Postgres, a diferencia de un doble ad-hoc que solo despache por
// regex sin quedar "abortado": una consulta posterior a un error que ese tipo de doble
// simularía siempre respondería con normalidad, algo que Postgres real NUNCA hace. Esa
// es la causa raíz por la que un bug así puede pasar sin que ningún test lo vea:
// catches de SQLSTATE se probarían contra una sesión que jamás reproduce 25P02 ni el
// `COMMIT` que devuelve el tag `ROLLBACK`.
//
// Mismo doble, mismo criterio, que `packages/db/tests/support/aborting-fake-
// session.ts` / `domain-citas/tests/support/aborting-fake-session.ts` /
// `domain-hoteles/tests/support/aborting-fake-session.ts` /
// `domain-restaurantes/tests/support/aborting-fake-session.ts` /
// `domain-despachos/tests/support/aborting-fake-session.ts` (duplicado a
// propósito -- cada paquete es dueño de sus propios dobles de prueba, sin una
// dependencia cruzada nueva solo para esto). Agregado a domain-licitaciones en
// f2-orden-total-bitacoras para `postgres-repository.ts::listTenderAuditLogPage`.
//
// Regla real de Postgres que este doble modela (verificada en `scripts/verify-
// fallback-savepoint/pg-scenarios.sql` contra Postgres real, no solo aquí):
//   - Una consulta (`query`) dentro de una transacción que lanza un error dentro de
//     UN bloque de transacción deja esa transacción "abortada".
//   - Mientras está abortada, CUALQUIER `query()` posterior lanza SQLSTATE 25P02
//     ("current transaction is aborted, commands ignored until end of transaction
//     block") -- SIN excepción, incluida una consulta de "camino de respaldo" que un
//     `try/catch` simple (sin SAVEPOINT) intentaría correr.
//   - `ROLLBACK TO SAVEPOINT <nombre>` es la ÚNICA forma de salir del estado
//     abortado sin terminar toda la transacción -- después de eso, el estado vuelve
//     a "en curso" y las consultas normales funcionan de nuevo. Un `ROLLBACK` liso
//     (fin de la transacción completa) también lo limpia, pero eso no es lo que este
//     doble ejercita (la transacción completa la maneja `withAppSession`, fuera del
//     alcance de un test de repositorio).
//   - `SAVEPOINT`/`RELEASE SAVEPOINT` (fuera del estado abortado) son no-ops desde
//     el punto de vista de este doble -- solo importan para la secuencia de llamadas
//     que un test quiera verificar (`calls`).
import type { TenantDbSession } from "@atiende/core-tenancy";

export interface FakeSessionHandler {
  /** Sub-cadena/regex reconocible del SQL -- el primer handler cuyo `match` acierta
   *  gana. */
  readonly match: RegExp;
  /** Devuelve las filas (para `query`) o `undefined` (para `exec`) en caso de éxito,
   *  o una instancia de `Error` para simular que la consulta falla -- ese error deja
   *  la sesión "abortada" para toda consulta posterior, igual que Postgres real. */
  readonly respond: () => unknown;
}

function transactionAbortedError(): Error & { code: string } {
  const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
  err.code = "25P02";
  return err;
}

export class AbortAwareFakeSession implements TenantDbSession {
  private aborted = false;
  readonly calls: string[] = [];

  constructor(private readonly handlers: readonly FakeSessionHandler[]) {}

  /** Simula el error que dispararía un `SAVEPOINT` FUERA de un bloque de transacción
   *  (SQLSTATE 25P01) -- solo para el puñado de tests que ejercitan explícitamente
   *  `runWithSavepointFallback` sin transacción abierta. */
  noActiveTransaction = false;

  async query<T>(sql: string, _params?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push(this.firstLine(sql));
    if (this.aborted) throw transactionAbortedError();
    return { rows: (await this.dispatch(sql)) as T[] };
  }

  async exec(sql: string): Promise<void> {
    const normalized = sql.trim().toLowerCase();
    this.calls.push(normalized);

    if (normalized.startsWith("rollback to savepoint")) {
      this.aborted = false;
      return;
    }
    if (normalized === "rollback" || normalized === "rollback;") {
      this.aborted = false;
      return;
    }
    if (this.aborted) throw transactionAbortedError();
    if (normalized.startsWith("savepoint")) {
      if (this.noActiveTransaction) {
        const err = new Error('SAVEPOINT can only be used in transaction blocks') as Error & { code: string };
        err.code = "25P01";
        throw err;
      }
      return;
    }
    if (normalized.startsWith("release savepoint")) return;
    await this.dispatch(sql);
  }

  private firstLine(sql: string): string {
    return sql.trim().toLowerCase().split("\n")[0]!;
  }

  private async dispatch(sql: string): Promise<unknown[]> {
    for (const h of this.handlers) {
      if (h.match.test(sql)) {
        const result = h.respond();
        if (result instanceof Error) {
          this.aborted = true;
          throw result;
        }
        return (result as unknown[] | undefined) ?? [];
      }
    }
    throw new Error(`AbortAwareFakeSession: ninguna regla coincide con la consulta -> ${sql}`);
  }
}
