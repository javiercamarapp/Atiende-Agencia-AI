// Onboarding P0: una organizacion de licitaciones en prueba vigente recibe ingesta, recordatorios y alertas (listActiveOrganizations).
// Antes la consulta filtraba status = 'active' y toda cuenta nueva (nace 'trial') quedaba fuera del cron de convocatorias.
import { describe, expect, it } from "vitest";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000a1701";

describe("licitaciones: listActiveOrganizations incluye la prueba vigente", () => {
  it("usa la regla de prueba vigente", async () => {
    const vistas: string[] = [];
    const db = new AbortAwareFakeSession([{ match: /from core\.organization where vertical = 'licitaciones'/, respond: () => [{ id: ORG }] }]);
    const original = db.query.bind(db);
    db.query = (async (q: string, p?: unknown[]) => {
      vistas.push(q);
      return original(q, p);
    }) as typeof db.query;
    await expect(new PostgresLicitacionesRepository(db).listActiveOrganizations()).resolves.toEqual([{ id: ORG }]);
    expect(vistas.join("\n")).toContain("status = 'trial' and (trial_ends_at is null or trial_ends_at > now())");
  });

  it("base sin la 0046 (42703): cae a status in ('active','trial') con SAVEPOINT", async () => {
    let intentos = 0;
    const db = new AbortAwareFakeSession([
      {
        match: /from core\.organization where vertical = 'licitaciones'/,
        respond: () => {
          intentos += 1;
          if (intentos === 1) return Object.assign(new Error('column "trial_ends_at" does not exist'), { code: "42703" });
          return [{ id: ORG }];
        },
      },
    ]);
    await expect(new PostgresLicitacionesRepository(db).listActiveOrganizations()).resolves.toEqual([{ id: ORG }]);
    expect(db.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    expect(db.calls.some((c) => c.includes("status in ('active', 'trial')"))).toBe(true);
  });
});
