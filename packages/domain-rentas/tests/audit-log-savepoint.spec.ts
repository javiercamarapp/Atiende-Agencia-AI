// r5 -- bitácora de auditoría del staff: regresión para
// `PostgresRentasRepository.registrarAuditoria` Y (no bloqueante #1 de revisión r5)
// `.listAuditoria`. Un doble de prueba de `TenantDbSession` que SÍ modela el
// comportamiento real de Postgres (mismo patrón EXACTO que
// domain-restaurantes/tests/upsert-customer-savepoint.spec.ts y
// domain-citas/tests/upsert-customer-savepoint.spec.ts): una vez que una consulta
// dentro de una transacción lanza un error, CUALQUIER consulta posterior sin haber
// pasado por `ROLLBACK TO SAVEPOINT` falla con 25P02 "current transaction is
// aborted...". Una sesión falsa plana (que solo registra llamadas, sin modelar el
// aborto) NO puede reproducir el bug real que este fix corrige -- ver el comentario
// de cabecera de esos dos archivos.
//
// Escenario real que esto reproduce (escritura): `rentas.record_audit_log` no
// existe todavía en la base (SQLSTATE 42883, base sin migrar -- ver AGENTS.md de
// esta fase). La acción de negocio (p.ej. `UPDATE rentas.tarifa_base`) YA CORRIÓ y
// tuvo éxito ANTES de llamar a `registrarAuditoria`, en la MISMA transacción de
// request (`ManagedPostgresEngine.withAppSession`). Sin el SAVEPOINT de este fix, el
// 42883 de la bitácora deja la transacción ABORTADA -- y el `commit` final del
// request (aquí simulado con una query cualquiera después) fallaría con 25P02,
// revirtiendo la acción de negocio que ya se había completado con éxito.
//
// Escenario real que esto reproduce (lectura, `listAuditoria`, corrección de
// revisión r5 -- no bloqueante #1): la tabla `rentas.audit_log` todavía no existe
// (SQLSTATE 42P01, base sin migrar) cuando el staff abre la pantalla de Auditoría.
// El código de lectura era correcto por inspección (usa SAVEPOINT / ROLLBACK TO
// SAVEPOINT igual que la escritura), pero no tenía NINGÚN test con
// `AbortAwareFakeSession`: `apps/api/tests/rentas-auditoria.spec.ts` corre contra el
// repo en memoria (que siempre devuelve `disponible:true`) y
// `packages/domain-rentas/tests/audit-log-savepoint.spec.ts` solo cubría
// `registrarAuditoria`.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresRentasRepository } from "../src/postgres-repository.ts";

function pgUndefinedFunction(): Error & { code: string } {
  const err = new Error('function rentas.record_audit_log(uuid, text, text, uuid, text, text, text) does not exist') as Error & { code: string };
  err.code = "42883";
  return err;
}

function pgUndefinedTable(): Error & { code: string } {
  const err = new Error('relation "rentas.audit_log" does not exist') as Error & { code: string };
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
    if (normalized.startsWith("select rentas.record_audit_log")) {
      this.aborted = true;
      throw pgUndefinedFunction();
    }
    // `listAuditoria` -- la tabla todavía no existe (base sin migrar): el `count(*)`
    // es la PRIMERA query de la lectura, así que basta con que ella falle para
    // reproducir el mismo aborto de transacción que la escritura.
    if (normalized.startsWith("select count(*)::text as total from rentas.audit_log")) {
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

function pgUndefinedColumnSeq(): Error & { code: string } {
  const err = new Error('column "seq" does not exist') as Error & { code: string };
  err.code = "42703";
  return err;
}

/**
 * r6 -- ver migrations/022_rentas_audit_log_orden_determinista.sql. Modela el
 * esquema INTERMEDIO real que la base de producción atravesará: 021 YA aplicada
 * (`rentas.audit_log`/`rentas.record_audit_log` existen, el `count(*)` y el
 * INSERT funcionan) pero 022 NO (`seq` no existe todavía) -- a diferencia de
 * `AbortAwareFakeSession` de arriba (que modela "021 tampoco existe", 42883/
 * 42P01), aquí la tabla SÍ existe -- solo el `order by ..., seq desc` nuevo
 * falla con 42703 (`undefined_column`), y debe degradar al `order by created_at
 * desc` de antes de 022 SIN devolver `disponible:false` (la bitácora SÍ está
 * disponible, solo con el orden viejo).
 */
class SchemaParcial021SinSeqFakeSession implements TenantDbSession {
  aborted = false;
  readonly calls: string[] = [];
  readonly filasReales = [
    {
      id: "fila-1",
      actor_user_id: "staff-1",
      action: "pricing.tarifa_base.actualizada",
      entity_type: "pricing",
      entity_id: "unidad-1",
      campo: "precio_noche_centavos",
      antes: null,
      despues: "200000 MXN desde 2026-06-01",
      created_at: "2026-09-19T12:00:00.000Z",
    },
  ];

  async query<T>(sql: string, _params?: unknown[]): Promise<{ rows: T[] }> {
    const normalized = sql.trim().toLowerCase();
    this.calls.push(normalized.split("\n")[0]!);
    if (this.aborted) {
      const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
      err.code = "25P02";
      throw err;
    }
    if (normalized.startsWith("select count(*)::text as total from rentas.audit_log")) {
      // La tabla SÍ existe (021 aplicada) -- el count funciona normal, nunca
      // marca `aborted`.
      return { rows: [{ total: "1" }] as unknown as T[] };
    }
    if (normalized.includes("select id, actor_user_id, action, entity_type")) {
      if (normalized.includes("order by created_at desc, seq desc")) {
        // El order by NUEVO (022) -- `seq` no existe todavía en este esquema
        // intermedio.
        this.aborted = true;
        throw pgUndefinedColumnSeq();
      }
      if (normalized.includes("order by created_at desc limit")) {
        // El order by VIEJO (antes de 022) -- SÍ funciona, la tabla y sus
        // columnas de 021 existen todas.
        return { rows: this.filasReales as unknown as T[] };
      }
      throw new Error(`SchemaParcial021SinSeqFakeSession: order by inesperado en: ${sql}`);
    }
    if (normalized.startsWith("select 1 as siguiente_query_del_request")) {
      return { rows: [{ ok: true }] as unknown as T[] };
    }
    throw new Error(`SchemaParcial021SinSeqFakeSession: query no soportada: ${sql}`);
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
    throw new Error(`SchemaParcial021SinSeqFakeSession: exec no soportado: ${sql}`);
  }
}

describe("PostgresRentasRepository.listAuditoria — esquema intermedio (021 aplicada, 022 no): degrada el order by, nunca disponible:false", () => {
  it("un 42703 en 'seq' degrada a 'order by created_at desc' y SIGUE devolviendo disponible:true con las filas reales", async () => {
    const session = new SchemaParcial021SinSeqFakeSession();
    const repo = new PostgresRentasRepository(session);

    const pagina = await repo.listAuditoria("org-1", {}, { limit: 25, offset: 0 });

    // La bitácora SÍ está disponible -- 022 no aplicada nunca debe confundirse
    // con "021 no aplicada" (que sí devuelve disponible:false, ver el describe
    // de arriba).
    expect(pagina.disponible).toBe(true);
    expect(pagina.total).toBe(1);
    expect(pagina.items).toEqual([
      {
        id: "fila-1",
        actorUserId: "staff-1",
        action: "pricing.tarifa_base.actualizada",
        entityType: "pricing",
        entityId: "unidad-1",
        campo: "precio_noche_centavos",
        antes: null,
        despues: "200000 MXN desde 2026-06-01",
        createdAtMs: new Date("2026-09-19T12:00:00.000Z").getTime(),
      },
    ]);

    // El SAVEPOINT anidado (`sp_rentas_audit_log_read_order`, distinto del de
    // lectura general `sp_rentas_audit_log_read`) recuperó la transacción antes
    // de reintentar con el order by viejo.
    expect(session.calls).toContain("savepoint sp_rentas_audit_log_read_order");
    expect(session.calls).toContain("rollback to savepoint sp_rentas_audit_log_read_order");
    expect(session.calls).toContain("release savepoint sp_rentas_audit_log_read_order");
    // Y la transacción del request sigue utilizable después (sin 25P02).
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });
});

describe("PostgresRentasRepository.listAuditoria — recuperación de 42P01 con SAVEPOINT (no bloqueante #1 de revisión r5)", () => {
  it("tabla sin migrar: devuelve disponible:false (nunca lanza) y deja la transacción recuperada para la query siguiente", async () => {
    const session = new AbortAwareFakeSession();
    const repo = new PostgresRentasRepository(session);

    await expect(repo.listAuditoria("org-1", {}, { limit: 25, offset: 0 })).resolves.toEqual({
      disponible: false,
      items: [],
      total: 0,
      nextOffset: null,
    });

    // Misma pareja SAVEPOINT/ROLLBACK TO SAVEPOINT que la escritura, con su propio
    // nombre de savepoint de lectura (sp_rentas_audit_log_read) -- confirma que el
    // fix de LECTURA usa el mecanismo real, no solo que el resultado final coincida.
    expect(session.calls).toContain("savepoint sp_rentas_audit_log_read");
    expect(session.calls).toContain("rollback to savepoint sp_rentas_audit_log_read");
    expect(session.calls).toContain("release savepoint sp_rentas_audit_log_read");

    // La transacción quedó recuperada -- una query posterior (el resto del handler
    // del GET /admin/auditoria) NO ve 25P02.
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("sin el SAVEPOINT, la misma secuencia SÍ deriva en 25P02 (prueba de que el bug de lectura sería real)", async () => {
    const session = new AbortAwareFakeSession();
    await expect(
      (async () => {
        try {
          await session.query("select count(*)::text as total from rentas.audit_log where organization_id = $1;", []);
        } catch {
          // reproduce el código sin recuperación: no hace nada con el error.
        }
        return session.query("select 1 as siguiente_query_del_request;");
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});
