// Sesion falsa que modela la semantica REAL de SAVEPOINT de Postgres sobre UNA conexion: los savepoints forman
// una pila; RELEASE de uno destruye tambien los abiertos despues de el; RELEASE/ROLLBACK TO de un nombre que ya no
// existe lanza 3B001 y aborta la transaccion (todo lo siguiente falla con 25P02 hasta un ROLLBACK TO valido).
// Cada llamada cede un turno (setImmediate) y se atiende en orden de llegada, como la cola de un cliente pg: asi
// un Promise.all sobre la misma sesion produce SAVEPOINT a,b,c,d + consultas + RELEASE a,b,c,d, igual que en real.
import type { TenantDbSession } from "@atiende/core-tenancy";

export interface NestedSavepointHandler {
  readonly match: RegExp;
  readonly rows: () => unknown[];
}

function pgError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export class NestedSavepointSession implements TenantDbSession {
  readonly calls: string[] = [];
  private stack: string[] = [];
  private aborted = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly handlers: readonly NestedSavepointHandler[]) {}

  get abortada(): boolean {
    return this.aborted;
  }

  private enqueue<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(() => new Promise<void>((r) => setImmediate(r))).then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  query<T>(sql: string): Promise<{ rows: T[] }> {
    return this.enqueue(() => {
      this.calls.push(sql.trim().toLowerCase().split("\n")[0]!);
      if (this.aborted) throw pgError("current transaction is aborted, commands ignored until end of transaction block", "25P02");
      const h = this.handlers.find((x) => x.match.test(sql));
      if (!h) throw new Error(`NestedSavepointSession: sin regla para ${sql}`);
      try {
        return { rows: h.rows() as T[] };
      } catch (err) {
        this.aborted = true; // un error de consulta aborta la transaccion, como en Postgres real
        throw err;
      }
    });
  }

  exec(sql: string): Promise<void> {
    return this.enqueue(() => {
      const s = sql.trim().toLowerCase();
      this.calls.push(s);
      const nombre = s.split(/\s+/).at(-1)!;
      if (s.startsWith("rollback to savepoint")) {
        const i = this.stack.indexOf(nombre);
        if (i < 0) {
          this.aborted = true;
          throw pgError(`no such savepoint: ${nombre}`, "3B001");
        }
        this.stack = this.stack.slice(0, i + 1);
        this.aborted = false;
        return;
      }
      if (this.aborted) throw pgError("current transaction is aborted, commands ignored until end of transaction block", "25P02");
      if (s.startsWith("savepoint")) {
        this.stack.push(nombre);
        return;
      }
      if (s.startsWith("release savepoint")) {
        const i = this.stack.indexOf(nombre);
        if (i < 0) {
          this.aborted = true;
          throw pgError(`no such savepoint: ${nombre}`, "3B001");
        }
        this.stack = this.stack.slice(0, i);
        return;
      }
      throw new Error(`NestedSavepointSession: exec no soportado: ${sql}`);
    });
  }
}
