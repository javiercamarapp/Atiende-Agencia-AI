// paridad3 L-P3-13: filtro/orden/resumen puros + el SQL real que arma PostgresLicitacionesRepository.listTendersPage / summarizeTenders.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";
import { compareTendersForList, escapeLikePattern, matchesTenderFilter, summarizeTenderRecords } from "../src/tender-list-filter.ts";
import type { TenderRecord } from "../src/types.ts";

const base = (over: Partial<TenderRecord>): TenderRecord => ({ id: "a", organizationId: "o", title: "T", submissionDeadline: null, updatedAt: "2026-01-01T00:00:00Z", status: "discovered", source: "manual", ...over });

describe("tender-list-filter (puro)", () => {
  it("escapa los comodines de LIKE para buscar literal", () => {
    expect(escapeLikePattern("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  });

  it("q busca por titulo, folio o convocante sin distinguir mayusculas", () => {
    const t = base({ title: "Compra de papel", externalId: "LA-01/2026", contractingBody: "IMSS" });
    expect(matchesTenderFilter(t, { q: "PAPEL" })).toBe(true);
    expect(matchesTenderFilter(t, { q: "la-01" })).toBe(true);
    expect(matchesTenderFilter(t, { q: "imss" })).toBe(true);
    expect(matchesTenderFilter(t, { q: "isste" })).toBe(false);
  });

  it("openOnly excluye ganadas, perdidas, canceladas y no-go; deadlineFrom excluye las sin plazo", () => {
    expect(matchesTenderFilter(base({ status: "won" }), { openOnly: true })).toBe(false);
    expect(matchesTenderFilter(base({ status: "in_progress" }), { openOnly: true })).toBe(true);
    expect(matchesTenderFilter(base({ submissionDeadline: null }), { deadlineFrom: "2026-01-01T00:00:00Z" })).toBe(false);
  });

  it("el orden desempata por id: dos filas con el mismo updatedAt quedan en un orden total", () => {
    const a = base({ id: "a" });
    const b = base({ id: "b" });
    expect([a, b].sort(compareTendersForList).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("el resumen cuenta por vencer solo entre abiertas no presentadas con plazo dentro de la ventana", () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const dia = 86_400_000;
    const r = summarizeTenderRecords(
      [
        base({ id: "1", status: "go", submissionDeadline: new Date(now + 2 * dia).toISOString() }),
        base({ id: "2", status: "submitted", submissionDeadline: new Date(now + 2 * dia).toISOString() }),
        base({ id: "3", status: "won", submissionDeadline: new Date(now + 2 * dia).toISOString() }),
        base({ id: "4", status: "go", submissionDeadline: new Date(now + 9 * dia).toISOString() }),
        base({ id: "5", status: "go", submissionDeadline: new Date(now - dia).toISOString() }),
      ],
      now,
      7,
    );
    expect(r).toMatchObject({ total: 5, open: 4, closingSoon: 1, byStatus: { go: 3, submitted: 1, won: 1 } });
  });
});

function capturing(responses: ReadonlyArray<{ rows: unknown[] }>) {
  const queue = [...responses];
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const session: TenantDbSession = {
    async query<T>(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return (queue.shift() ?? { rows: [] }) as { rows: T[] };
    },
    async exec() {},
  };
  return { session, calls };
}

describe("PostgresLicitacionesRepository.listTendersPage / summarizeTenders (SQL real)", () => {
  it("todo valor del usuario viaja como parametro (nunca en el texto SQL), con orden total y limit/offset", async () => {
    const { session, calls } = capturing([{ rows: [] }]);
    const repo = new PostgresLicitacionesRepository(session);
    await repo.listTendersPage("org-1", { limit: 50, offset: 0, q: "x'; drop table--", status: "go", source: "nl_ocds", openOnly: true, ids: ["i1"], deadlineFrom: "2026-01-01T00:00:00Z", deadlineTo: "2026-02-01T00:00:00Z" });
    const { sql, params } = calls[0]!;
    expect(sql).not.toContain("drop table");
    expect(sql).toContain("order by updated_at desc, id desc");
    expect(sql).toContain("organization_id = $1");
    expect(params[0]).toBe("org-1");
    expect(params).toContain("%x'; drop table--%");
    expect(params.slice(-2)).toEqual([50, 0]);
  });

  it("una pagina mas alla del final recupera el total real con un conteo aparte (no devuelve 0)", async () => {
    const { session, calls } = capturing([{ rows: [] }, { rows: [{ total: "251" }] }]);
    const repo = new PostgresLicitacionesRepository(session);
    const page = await repo.listTendersPage("org-1", { limit: 50, offset: 300 });
    expect(page).toEqual({ items: [], total: 251, nextOffset: null });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.sql).toContain("count(*)");
  });

  it("summarizeTenders agrega por estado y suma abiertas/por vencer solo de estados no cerrados", async () => {
    const { session } = capturing([
      {
        rows: [
          { status: "go", total: "100", closing_soon: "7" },
          { status: "won", total: "40", closing_soon: "0" },
          { status: "in_progress", total: "80", closing_soon: "5" },
        ],
      },
    ]);
    const repo = new PostgresLicitacionesRepository(session);
    const r = await repo.summarizeTenders("org-1", { nowIso: "2026-10-01T00:00:00Z", windowDays: 7 });
    expect(r).toEqual({ total: 220, open: 180, closingSoon: 12, windowDays: 7, byStatus: { go: 100, won: 40, in_progress: 80 } });
  });
});
