// r5 -- bitácora de auditoría del staff: regresión para
// `PostgresRentasRepository.registrarAuditoria`. Un doble de prueba de
// `TenantDbSession` que SÍ modela el comportamiento real de Postgres (mismo patrón
// EXACTO que domain-restaurantes/tests/upsert-customer-savepoint.spec.ts y
// domain-citas/tests/upsert-customer-savepoint.spec.ts): una vez que una consulta
// dentro de una transacción lanza un error, CUALQUIER consulta posterior sin haber
// pasado por `ROLLBACK TO SAVEPOINT` falla con 25P02 "current transaction is
// aborted...". Una sesión falsa plana (que solo registra llamadas, sin modelar el
// aborto) NO puede reproducir el bug real que este fix corrige -- ver el comentario
// de cabecera de esos dos archivos.
//
// Escenario real que esto reproduce: `rentas.record_audit_log` no existe todavía en
// la base (SQLSTATE 42883, base sin migrar -- ver AGENTS.md de esta fase). La acción
// de negocio (p.ej. `UPDATE rentas.tarifa_base`) YA CORRIÓ y tuvo éxito ANTES de
// llamar a `registrarAuditoria`, en la MISMA transacción de request
// (`ManagedPostgresEngine.withAppSession`). Sin el SAVEPOINT de este fix, el 42883 de
// la bitácora deja la transacción ABORTADA -- y el `commit` final del request (aquí
// simulado con una query cualquiera después) fallaría con 25P02, revirtiendo la
// acción de negocio que ya se había completado con éxito.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresRentasRepository } from "../src/postgres-repository.ts";

function pgUndefinedFunction(): Error & { code: string } {
  const err = new Error('function rentas.record_audit_log(uuid, text, text, uuid, text, text, text) does not exist') as Error & { code: string };
  err.code = "42883";
  return err;
}

/** Simula fielmente la semántica de aborto de transacción de Postgres: una vez que
 * `aborted` queda en `true` (una query lanzó), CUALQUIER `query()` posterior lanza
 * 25P02 hasta un `exec("ROLLBACK TO SAVEPOINT ...")` que lo recupera. */
class AbortAwareFakeSession implements TenantDbSession {
  aborted = false;
  readonly calls: string[] = [];

  async query<T>(sql: string, _params?: unknown[]): Promise<{ rows: T[] }> {
    const normalized = sql.trim().toLowerCase();
    this.calls.push(normalized.split("\n")[0]!);
    if (this.aborted) {
      const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
      err.code = "25P02";
      throw err;
    }
    if (normalized.startsWith("select rentas.record_audit_log")) {
      this.aborted = true;
      throw pgUndefinedFunction();
    }
    // Representa CUALQUIER sentencia posterior en la misma transacción compartida --
    // el `commit;` final de `ManagedPostgresEngine.withAppSession`, o cualquier otra
    // query que el handler siga corriendo después de llamar a registrarAuditoria.
    if (normalized.startsWith("select 1 as siguiente_query_del_request")) {
      return { rows: [{ ok: true }] as unknown as T[] };
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

describe("PostgresRentasRepository.registrarAuditoria — recuperación de 42883 con SAVEPOINT", () => {
  it("nunca lanza, y la transacción queda recuperada para la query siguiente del request (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession();
    const repo = new PostgresRentasRepository(session);

    await expect(
      repo.registrarAuditoria({
        organizationId: "org-1",
        actorUserId: "staff-1",
        action: "pricing.tarifa_base.actualizada",
        entityType: "pricing",
        entityId: "unidad-1",
        campo: "precio_noche_centavos",
        antes: null,
        despues: "200000 MXN desde 2026-06-01",
      }),
    ).resolves.toBeUndefined();

    // La secuencia real DEBE incluir el SAVEPOINT antes del INSERT y su recuperación
    // (ROLLBACK TO SAVEPOINT + RELEASE SAVEPOINT) -- mismo criterio que el fix de
    // upsertCustomer.
    expect(session.calls).toContain("savepoint sp_rentas_audit_log_write");
    expect(session.calls).toContain("rollback to savepoint sp_rentas_audit_log_write");
    expect(session.calls).toContain("release savepoint sp_rentas_audit_log_write");

    // La transacción quedó recuperada -- una query posterior (el resto del handler /
    // el commit final del request) NO ve 25P02.
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("sin el SAVEPOINT, la misma secuencia SÍ deriva en 25P02 (prueba de que el bug era real)", async () => {
    const session = new AbortAwareFakeSession();
    await expect(
      (async () => {
        // Reproduce el código VIEJO (sin SAVEPOINT): la llamada a la función falla,
        // aborted=true, y la query "siguiente del request" se ejecuta directo, sin
        // recuperar la transacción.
        try {
          await session.query("select rentas.record_audit_log($1,$2,$3,$4,$5,$6,$7);", []);
        } catch {
          // el código viejo no hacía nada aquí -- solo dejaba `aborted` en true.
        }
        return session.query("select 1 as siguiente_query_del_request;");
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});
