// Onboarding P0: una organizacion de licitaciones en prueba (con o sin fecha de fin, vencida o no) recibe ingesta, recordatorios y alertas
// (listActiveOrganizations). Antes la consulta filtraba status = 'active' y toda cuenta nueva (nace 'trial') quedaba fuera del cron.
import { describe, expect, it } from "vitest";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000a1701";

describe("licitaciones: listActiveOrganizations incluye la prueba", () => {
  it("usa status in ('active','trial') y no lee trial_ends_at (funciona igual sin la 0046)", async () => {
    const db = new AbortAwareFakeSession([{ match: /from core\.organization where vertical = 'licitaciones'/, respond: () => [{ id: ORG }] }]);
    await expect(new PostgresLicitacionesRepository(db).listActiveOrganizations()).resolves.toEqual([{ id: ORG }]);
    const sql = db.calls.join("\n");
    expect(sql).toContain("status in ('active', 'trial')");
    expect(sql).not.toContain("trial_ends_at");
  });
});
