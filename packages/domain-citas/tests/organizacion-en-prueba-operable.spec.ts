// Onboarding P0: una organizacion de citas en prueba ('trial') opera como activa hasta su trial_ends_at. Antes `findOrganizationBySlug`
// marcaba activa solo `status = 'active'` y el panel, la reserva publica, las citas y la voz respondian 404 a toda cuenta en prueba.
// Aqui se prueba el cableado del repositorio real (SQL con la regla de @atiende/db y el SAVEPOINT contra una base sin la 0046).
import { describe, expect, it } from "vitest";
import { organizacionOperable } from "@atiende/db";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = { id: "00000000-0000-4000-8000-0000000c1701", name: "Consultorio", slug: "consultorio" };

function columnaInexistente(): Error & { code: string } {
  const err = new Error('column "trial_ends_at" does not exist') as Error & { code: string };
  err.code = "42703";
  return err;
}

describe("citas: prueba vigente = organizacion operable", () => {
  it("la consulta usa la regla de prueba vigente (trial con trial_ends_at futuro o sin fecha) y respeta is_active", async () => {
    let sql = "";
    const db = new AbortAwareFakeSession([
      {
        match: /from core\.organization where slug/,
        respond: () => [{ ...ORG, is_active: true }],
      },
    ]);
    const original = db.query.bind(db);
    db.query = (async (q: string, p?: unknown[]) => {
      if (/core\.organization/.test(q)) sql = q;
      return original(q, p);
    }) as typeof db.query;
    const repo = new PostgresCitasRepository(db);
    await expect(repo.findOrganizationBySlug("consultorio")).resolves.toEqual({ ...ORG, isActive: true });
    expect(sql).toContain("status = 'trial' and (trial_ends_at is null or trial_ends_at > now())");
  });

  it("base sin la 0046 (42703): cae a 'trial cuenta como activa' sin dejar la sesion abortada", async () => {
    let intentos = 0;
    const db = new AbortAwareFakeSession([
      {
        match: /from core\.organization where slug/,
        respond: () => (++intentos === 1 ? columnaInexistente() : [{ ...ORG, is_active: true }]),
      },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresCitasRepository(db);
    await expect(repo.findOrganizationBySlug("consultorio")).resolves.toEqual({ ...ORG, isActive: true });
    expect(db.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("organizacion suspendida o con prueba vencida: no operable", async () => {
    const db = new AbortAwareFakeSession([{ match: /from core\.organization where slug/, respond: () => [{ ...ORG, is_active: false }] }]);
    await expect(new PostgresCitasRepository(db).findOrganizationBySlug("consultorio")).resolves.toEqual({ ...ORG, isActive: false });
  });

  it("listActiveOrganizations (recordatorios) incluye organizaciones en prueba vigente", async () => {
    let sql = "";
    const db = new AbortAwareFakeSession([
      {
        match: /join citas\.tenant_config/,
        respond: () => [{ id: ORG.id, default_timezone: "America/Merida" }],
      },
    ]);
    const original = db.query.bind(db);
    db.query = (async (q: string, p?: unknown[]) => {
      if (/tenant_config/.test(q)) sql = q;
      return original(q, p);
    }) as typeof db.query;
    await expect(new PostgresCitasRepository(db).listActiveOrganizations()).resolves.toEqual([{ id: ORG.id, timezone: "America/Merida" }]);
    expect(sql).toContain("o.status = 'trial' and (o.trial_ends_at is null or o.trial_ends_at > now())");
  });
});

describe("regla organizacionOperable (TS)", () => {
  const ahora = new Date("2026-11-06T12:00:00Z");
  it.each([
    [{ status: "active" }, true],
    [{ status: "trial" }, true],
    [{ status: "trial", trialEndsAt: null }, true],
    [{ status: "trial", trialEndsAt: "2026-11-20T00:00:00Z" }, true],
    [{ status: "trial", trialEndsAt: "2026-11-01T00:00:00Z" }, false],
    [{ status: "suspended" }, false],
  ])("%j -> %s", (org, esperado) => {
    expect(organizacionOperable(org, ahora)).toBe(esperado);
  });
});
