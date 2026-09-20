// f2-orden-total-bitacoras -- orden TOTAL determinista para `licitaciones.
// tender_audit_log` (007_matching_profile.sql), mismo patrón que
// packages/domain-despachos/tests/audit-log-orden-total.spec.ts /
// packages/domain-rentas/tests/audit-log-orden-determinista.spec.ts (PR #173).
//
// A diferencia de despachos/hoteles, aquí la ESCRITURA (`upsertTenderManual`/
// `recordTenderVersion`) ya existe y corre en producción -- este spec confirma
// que el `listTenderAuditLogPage` nuevo (agregado en este mismo PR, la lectura
// que faltaba) ordena esas filas con orden total desde el día uno.
import { describe, expect, it, vi } from "vitest";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG_ID = "org-1";

function baseUpsertInput(overrides: Partial<Parameters<InMemoryLicitacionesRepository["upsertTenderManual"]>[1]> = {}) {
  return {
    title: "Convocatoria de prueba",
    submissionDeadline: null,
    externalId: null,
    contractingBody: null,
    cpvCodes: [],
    budgetAmount: null,
    currency: "MXN",
    state: null,
    procedureTypeRaw: null,
    actorId: "staff-1",
    ...overrides,
  };
}

describe("InMemoryLicitacionesRepository.listTenderAuditLogPage — desempate determinista dentro del mismo milisegundo", () => {
  it("varias filas escritas en el MISMO instante (reloj congelado) quedan en orden EXACTO de registro inverso, nunca al azar", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
      const repo = new InMemoryLicitacionesRepository();

      // upsertTenderManual (creación) ya audita 2 filas (manual_upsert.created +
      // version_recorded) en el MISMO reloj congelado -- reproduce exactamente el
      // caso real que la migración 026 previene: dos escrituras de auditoría en
      // la MISMA transacción de request.
      const { tender } = await repo.upsertTenderManual(ORG_ID, baseUpsertInput());
      await repo.upsertTenderManual(ORG_ID, baseUpsertInput({ externalId: "ext-1" })); // segunda convocatoria, no debe mezclarse
      // Una actualización manual real de LA MISMA convocatoria -- agrega 2 filas más.
      await repo.upsertTenderManual(ORG_ID, baseUpsertInput({ externalId: null }));

      const entradas = repo.listTenderAuditLogForTests(tender.id);
      const timestamps = new Set(entradas.map((r) => r.createdAt));
      expect(timestamps.size).toBe(1);
      expect(entradas.length).toBeGreaterThanOrEqual(2);

      const pagina = await repo.listTenderAuditLogPage(ORG_ID, tender.id, { limit: 50, offset: 0 });
      expect(pagina.total).toBe(entradas.length);
      // Orden EXACTO inverso de registro (más reciente = escrita al último).
      const accionesEsperadas = [...entradas].reverse().map((e) => e.action);
      expect(pagina.items.map((i) => i.action)).toEqual(accionesEsperadas);
    } finally {
      vi.useRealTimers();
    }
  });

  it("paginación estable con offset dentro del mismo instante: ninguna fila se repite ni se pierde entre páginas", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
      const repo = new InMemoryLicitacionesRepository();
      const { tender } = await repo.upsertTenderManual(ORG_ID, baseUpsertInput());
      for (let i = 0; i < 2; i += 1) {
        await repo.upsertTenderManual(ORG_ID, baseUpsertInput({ title: `Convocatoria de prueba v${i}` }));
      }

      const total = (await repo.listTenderAuditLogPage(ORG_ID, tender.id, { limit: 1000, offset: 0 })).total;
      const pagina1 = await repo.listTenderAuditLogPage(ORG_ID, tender.id, { limit: 2, offset: 0 });
      const pagina2 = await repo.listTenderAuditLogPage(ORG_ID, tender.id, { limit: 2, offset: 2 });
      const idsVistos = new Set([...pagina1.items, ...pagina2.items].map((i) => i.id));
      expect(idsVistos.size).toBe(Math.min(total, pagina1.items.length + pagina2.items.length));
      expect(pagina1.items.length + pagina2.items.length).toBeLessThanOrEqual(total);
      // Ninguna fila repetida entre páginas.
      const idsP1 = new Set(pagina1.items.map((i) => i.id));
      for (const item of pagina2.items) expect(idsP1.has(item.id)).toBe(false);
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

describe("PostgresLicitacionesRepository.listTenderAuditLogPage — esquema intermedio (007 aplicada, 026 no): degrada el order by, nunca lanza", () => {
  it("un 42703 en 'seq' degrada a 'order by created_at desc' y devuelve las filas reales, sin dejar la transacción abortada", async () => {
    const filaReal = {
      id: "fila-1",
      tender_id: "tender-1",
      action: "tender.manual_upsert.created",
      actor_id: "staff-1",
      created_at: "2026-09-19T12:00:00.000Z",
    };

    const session = new AbortAwareFakeSession([
      { match: /^select count\(\*\)::text as total from licitaciones\.tender_audit_log/, respond: () => [{ total: "1" }] },
      { match: /order by created_at desc, seq desc/, respond: () => pgUndefinedColumnSeq() },
      {
        match: /select id, tender_id, action, actor_id[\s\S]*order by created_at desc limit/,
        respond: () => [filaReal],
      },
      { match: /^select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresLicitacionesRepository(session);

    const pagina = await repo.listTenderAuditLogPage(ORG_ID, "tender-1", { limit: 25, offset: 0 });

    expect(pagina.total).toBe(1);
    expect(pagina.items).toEqual([
      {
        id: "fila-1",
        tenderId: "tender-1",
        action: "tender.manual_upsert.created",
        actorId: "staff-1",
        createdAt: "2026-09-19T12:00:00.000Z",
      },
    ]);

    expect(session.calls).toContain("savepoint sp_tender_audit_log_read_order");
    expect(session.calls).toContain("rollback to savepoint sp_tender_audit_log_read_order");
    expect(session.calls).toContain("release savepoint sp_tender_audit_log_read_order");

    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("sin 42703 (026 ya aplicada): usa 'order by created_at desc, seq desc' directo, sin ningún SAVEPOINT anidado", async () => {
    const filaReal = {
      id: "fila-1",
      tender_id: "tender-1",
      action: "tender.manual_upsert.created",
      actor_id: "staff-1",
      created_at: "2026-09-19T12:00:00.000Z",
    };
    const session = new AbortAwareFakeSession([
      { match: /^select count\(\*\)::text as total from licitaciones\.tender_audit_log/, respond: () => [{ total: "1" }] },
      { match: /order by created_at desc, seq desc/, respond: () => [filaReal] },
    ]);
    const repo = new PostgresLicitacionesRepository(session);

    const pagina = await repo.listTenderAuditLogPage(ORG_ID, "tender-1", { limit: 25, offset: 0 });
    expect(pagina.items).toHaveLength(1);
    expect(session.calls).not.toContain("rollback to savepoint sp_tender_audit_log_read_order");
  });
});
