// f2-orden-total-bitacoras -- orden TOTAL determinista para `despachos.audit_log`
// (008_despachos_audit_log.sql), mismo patrón que
// packages/domain-rentas/tests/audit-log-orden-determinista.spec.ts (PR #173).
//
// A diferencia de rentas.audit_log en PR #173, `despachos.audit_log` NO tiene hoy
// ningún consumidor de lectura paginada (se buscó explícitamente -- ver el
// comentario de cabecera de migrations/011_despachos_audit_log_orden_total_
// lectura_paginada.sql), así que este spec no reproduce un bug real observado en
// producción; confirma que `listAuditLogPage` (agregado en este mismo PR) nace con
// orden total desde el día uno, en vez de repetir el bug que rentas sí tuvo que
// corregir después.
import { describe, expect, it, vi } from "vitest";
import { InMemoryDespachosRepository } from "../src/in-memory-repository.ts";
import { PostgresDespachosRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG_ID = "org-1";

describe("InMemoryDespachosRepository.listAuditLogPage — desempate determinista dentro del mismo milisegundo", () => {
  it("5 filas escritas en el MISMO instante (reloj congelado) quedan en orden EXACTO de registro inverso, nunca al azar", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
      const repo = new InMemoryDespachosRepository();

      for (let i = 1; i <= 5; i += 1) {
        repo.registrarAuditLogParaPruebas({ organizationId: ORG_ID, actorUserId: "staff-1", action: `accion-${i}` });
      }

      // Confirma la premisa del bug: las 5 filas SÍ comparten `createdAtMs`.
      const timestamps = new Set(repo.auditLog.map((r) => r.createdAtMs));
      expect(timestamps.size).toBe(1);

      const pagina = await repo.listAuditLogPage(ORG_ID, { limit: 50, offset: 0 });
      expect(pagina.total).toBe(5);
      expect(pagina.items.map((i) => i.action)).toEqual(["accion-5", "accion-4", "accion-3", "accion-2", "accion-1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("paginación estable con offset dentro del mismo instante: ninguna fila se repite ni se pierde entre páginas", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
      const repo = new InMemoryDespachosRepository();
      for (let i = 1; i <= 6; i += 1) {
        repo.registrarAuditLogParaPruebas({ organizationId: ORG_ID, actorUserId: "staff-1", action: `v${i}` });
      }

      const pagina1 = await repo.listAuditLogPage(ORG_ID, { limit: 3, offset: 0 });
      const pagina2 = await repo.listAuditLogPage(ORG_ID, { limit: 3, offset: 3 });
      const todas = [...pagina1.items, ...pagina2.items].map((i) => i.action);
      expect(todas).toEqual(["v6", "v5", "v4", "v3", "v2", "v1"]);
      expect(new Set(todas).size).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("orden estable en 2 corridas con datos idénticos (afirma el EFECTO, no la implementación)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
      const repo = new InMemoryDespachosRepository();
      for (let i = 1; i <= 4; i += 1) {
        repo.registrarAuditLogParaPruebas({ organizationId: ORG_ID, actorUserId: "staff-1", action: `x${i}` });
      }
      const corrida1 = (await repo.listAuditLogPage(ORG_ID, { limit: 50, offset: 0 })).items.map((i) => i.action);
      const corrida2 = (await repo.listAuditLogPage(ORG_ID, { limit: 50, offset: 0 })).items.map((i) => i.action);
      expect(corrida1).toEqual(corrida2);
      expect(corrida1).toEqual(["x4", "x3", "x2", "x1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

function pgUndefinedColumnSeq(): Error & { code: string } {
  const err = new Error('column "seq" does not exist') as Error & { code: string };
  err.code = "42703";
  return err;
}

describe("PostgresDespachosRepository.listAuditLogPage — esquema intermedio (008 aplicada, 011 no): degrada el order by, nunca lanza", () => {
  it("un 42703 en 'seq' degrada a 'order by created_at desc' y devuelve las filas reales, sin dejar la transacción abortada", async () => {
    const filaReal = {
      id: "fila-1",
      actor_user_id: "staff-1",
      action: "cierre.periodo.cerrado",
      payload: { route: "/despachos/p1/cierre" },
      created_at: "2026-09-19T12:00:00.000Z",
    };

    const session = new AbortAwareFakeSession([
      { match: /^select count\(\*\)::text as total from despachos\.audit_log/, respond: () => [{ total: "1" }] },
      {
        match: /order by created_at desc, seq desc/,
        respond: () => pgUndefinedColumnSeq(),
      },
      {
        match: /select id, actor_user_id, action, payload[\s\S]*order by created_at desc limit/,
        respond: () => [filaReal],
      },
      { match: /^select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresDespachosRepository(session);

    const pagina = await repo.listAuditLogPage("org-1", { limit: 25, offset: 0 });

    expect(pagina.total).toBe(1);
    expect(pagina.items).toEqual([
      {
        id: "fila-1",
        actorUserId: "staff-1",
        action: "cierre.periodo.cerrado",
        payload: { route: "/despachos/p1/cierre" },
        createdAt: "2026-09-19T12:00:00.000Z",
      },
    ]);

    expect(session.calls).toContain("savepoint sp_despachos_audit_log_read_order");
    expect(session.calls).toContain("rollback to savepoint sp_despachos_audit_log_read_order");
    expect(session.calls).toContain("release savepoint sp_despachos_audit_log_read_order");

    // La transacción sigue utilizable después (sin 25P02).
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("sin 42703 (011 ya aplicada): usa 'order by created_at desc, seq desc' directo, sin ningún SAVEPOINT anidado", async () => {
    const filaReal = {
      id: "fila-1",
      actor_user_id: "staff-1",
      action: "cierre.periodo.cerrado",
      payload: {},
      created_at: "2026-09-19T12:00:00.000Z",
    };
    const session = new AbortAwareFakeSession([
      { match: /^select count\(\*\)::text as total from despachos\.audit_log/, respond: () => [{ total: "1" }] },
      { match: /order by created_at desc, seq desc/, respond: () => [filaReal] },
    ]);
    const repo = new PostgresDespachosRepository(session);

    const pagina = await repo.listAuditLogPage("org-1", { limit: 25, offset: 0 });
    expect(pagina.items).toHaveLength(1);
    expect(session.calls).not.toContain("rollback to savepoint sp_despachos_audit_log_read_order");
  });
});
