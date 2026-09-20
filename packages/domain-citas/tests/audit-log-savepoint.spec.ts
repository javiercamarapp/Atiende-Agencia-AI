// FASE 3 (producto) -- bitácora de auditoría del staff: regresión para
// `PostgresCitasRepository.registrarAuditoria` y `.listAuditoria`. Mismo patrón
// EXACTO que `@atiende/domain-restaurantes/tests/audit-log-savepoint.spec.ts`
// (y que este mismo paquete, `upsert-customer-savepoint.spec.ts`): un doble de
// prueba de `TenantDbSession` que SÍ modela el comportamiento real de Postgres --
// una vez que una consulta dentro de una transacción lanza un error, CUALQUIER
// consulta posterior sin haber pasado por `ROLLBACK TO SAVEPOINT` falla con 25P02
// "current transaction is aborted...". Una sesión falsa plana (que solo registra
// llamadas, sin modelar el aborto) NO puede reproducir el bug real que este fix
// corrige.
//
// Escenario real que esto reproduce (escritura): `citas.record_audit_log` no
// existe todavía en la base (SQLSTATE 42883, base sin migrar -- ver AGENTS.md de
// esta fase). La acción de negocio (p.ej. cancelar una cita desde el panel) YA
// CORRIÓ y tuvo éxito ANTES de llamar a `registrarAuditoria`, en la MISMA
// transacción de request (`ManagedPostgresEngine.withAppSession`). Sin el
// SAVEPOINT de este fix, el 42883 de la bitácora deja la transacción ABORTADA --
// y el `commit` final del request (aquí simulado con una query cualquiera
// después) fallaría con 25P02, revirtiendo la acción de negocio que ya se había
// completado con éxito.
//
// Escenario real que esto reproduce (lectura, `listAuditoria`): la tabla
// `citas.audit_log` todavía no existe (SQLSTATE 42P01, base sin migrar) cuando el
// staff abre la pantalla de Auditoría.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";

function pgUndefinedFunction(): Error & { code: string } {
  const err = new Error("function citas.record_audit_log(uuid, text, text, uuid, text, text, text) does not exist") as Error & { code: string };
  err.code = "42883";
  return err;
}

function pgUndefinedTable(): Error & { code: string } {
  const err = new Error('relation "citas.audit_log" does not exist') as Error & { code: string };
  err.code = "42P01";
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
    if (normalized.startsWith("select citas.record_audit_log")) {
      this.aborted = true;
      throw pgUndefinedFunction();
    }
    // `listAuditoria` -- la tabla todavía no existe (base sin migrar): el
    // `count(*)` es la PRIMERA query de la lectura, así que basta con que ella
    // falle para reproducir el mismo aborto de transacción que la escritura.
    if (normalized.startsWith("select count(*)::text as total from citas.audit_log")) {
      this.aborted = true;
      throw pgUndefinedTable();
    }
    if (normalized.startsWith("select id, actor_user_id, action, entity_type")) {
      // Solo se alcanza en el camino feliz (tabla SÍ existe) -- si el fix de
      // SAVEPOINT fallara y esta query corriera tras el 42P01 de arriba sin
      // recuperar la transacción, `this.aborted` seguiría en `true` y esto
      // lanzaría 25P02 en vez de devolver filas, delatando el bug.
      return { rows: [] as unknown as T[] };
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

describe("PostgresCitasRepository.registrarAuditoria — recuperación de 42883 con SAVEPOINT", () => {
  it("nunca lanza, y la transacción queda recuperada para la query siguiente del request (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession();
    const repo = new PostgresCitasRepository(session);

    await expect(
      repo.registrarAuditoria({
        organizationId: "org-1",
        actorUserId: "staff-1",
        action: "servicio.tarifa_actualizada",
        entityType: "servicio",
        entityId: "servicio-1",
        campo: "priceCents",
        antes: "35000",
        despues: "40000",
      }),
    ).resolves.toBeUndefined();

    // La secuencia real DEBE incluir el SAVEPOINT antes del INSERT y su
    // recuperación (ROLLBACK TO SAVEPOINT + RELEASE SAVEPOINT).
    expect(session.calls).toContain("savepoint sp_citas_audit_log_write");
    expect(session.calls).toContain("rollback to savepoint sp_citas_audit_log_write");
    expect(session.calls).toContain("release savepoint sp_citas_audit_log_write");

    // La transacción quedó recuperada -- una query posterior (el resto del handler /
    // el commit final del request) NO ve 25P02.
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("sin el SAVEPOINT, la misma secuencia SÍ deriva en 25P02 (prueba de que el bug sería real)", async () => {
    const session = new AbortAwareFakeSession();
    await expect(
      (async () => {
        // Reproduce el código SIN SAVEPOINT: la llamada a la función falla,
        // aborted=true, y la query "siguiente del request" se ejecuta directo,
        // sin recuperar la transacción.
        try {
          await session.query("select citas.record_audit_log($1,$2,$3,$4,$5,$6,$7);", []);
        } catch {
          // el código sin SAVEPOINT no hacía nada aquí -- solo dejaba `aborted` en true.
        }
        return session.query("select 1 as siguiente_query_del_request;");
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});

describe("PostgresCitasRepository.listAuditoria — recuperación de 42P01 con SAVEPOINT", () => {
  it("tabla sin migrar: devuelve disponible:false (nunca lanza) y deja la transacción recuperada para la query siguiente", async () => {
    const session = new AbortAwareFakeSession();
    const repo = new PostgresCitasRepository(session);

    await expect(repo.listAuditoria("org-1", {}, { limit: 25, offset: 0 })).resolves.toEqual({
      disponible: false,
      items: [],
      total: 0,
      nextOffset: null,
    });

    // Misma pareja SAVEPOINT/ROLLBACK TO SAVEPOINT que la escritura, con su propio
    // nombre de savepoint de lectura -- confirma que el fix de LECTURA usa el
    // mecanismo real, no solo que el resultado final coincida.
    expect(session.calls).toContain("savepoint sp_citas_audit_log_read");
    expect(session.calls).toContain("rollback to savepoint sp_citas_audit_log_read");
    expect(session.calls).toContain("release savepoint sp_citas_audit_log_read");

    // La transacción quedó recuperada -- una query posterior (el resto del handler
    // del GET /admin/auditoria) NO ve 25P02.
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("sin el SAVEPOINT, la misma secuencia SÍ deriva en 25P02 (prueba de que el bug de lectura sería real)", async () => {
    const session = new AbortAwareFakeSession();
    await expect(
      (async () => {
        try {
          await session.query("select count(*)::text as total from citas.audit_log where organization_id = $1;", []);
        } catch {
          // reproduce el código sin recuperación: no hace nada con el error.
        }
        return session.query("select 1 as siguiente_query_del_request;");
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});
