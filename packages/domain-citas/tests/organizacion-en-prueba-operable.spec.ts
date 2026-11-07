// Onboarding P0: una organizacion de citas en prueba ('trial') opera como activa, con o sin trial_ends_at y aunque ya haya pasado (vencer
// solo se avisa, 0072). Antes `findOrganizationBySlug` marcaba activa solo `status = 'active'` y el panel, la reserva publica, las citas y
// la voz respondian 404 a toda cuenta en prueba. Aqui se prueba el cableado del repositorio real (SQL con la regla de @atiende/db).
import { describe, expect, it } from "vitest";
import { organizacionOperable } from "@atiende/db";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = { id: "00000000-0000-4000-8000-0000000c1701", name: "Consultorio", slug: "consultorio" };

describe("citas: prueba (vencida o no) = organizacion operable", () => {
  it("la consulta usa la regla (active o trial) y no lee trial_ends_at: funciona igual sin la 0046", async () => {
    const db = new AbortAwareFakeSession([{ match: /from core\.organization where slug/, respond: () => [{ ...ORG, is_active: true }] }]);
    const repo = new PostgresCitasRepository(db);
    await expect(repo.findOrganizationBySlug("consultorio")).resolves.toEqual({ ...ORG, isActive: true });
    const sql = db.calls.find((c) => /core\.organization/.test(c))!;
    expect(sql).toContain("status in ('active', 'trial')");
    expect(sql).not.toContain("trial_ends_at");
    expect(db.calls.some((c) => c.includes("savepoint"))).toBe(false);
  });

  it("organizacion suspendida: no operable", async () => {
    const db = new AbortAwareFakeSession([{ match: /from core\.organization where slug/, respond: () => [{ ...ORG, is_active: false }] }]);
    await expect(new PostgresCitasRepository(db).findOrganizationBySlug("consultorio")).resolves.toEqual({ ...ORG, isActive: false });
  });

  it("listActiveOrganizations (recordatorios) incluye organizaciones en prueba, vencida o no", async () => {
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
    expect(sql).toContain("o.status in ('active', 'trial')");
    expect(sql).not.toContain("trial_ends_at");
  });
});

describe("regla organizacionOperable (TS)", () => {
  it.each([
    [{ status: "active" }, true],
    [{ status: "trial" }, true],
    [{ status: "trial", trialEndsAt: null }, true],
    [{ status: "trial", trialEndsAt: "2026-11-20T00:00:00Z" }, true],
    // Prueba vencida: sigue operando (no hay apagado automatico; solo el aviso de 0072).
    [{ status: "trial", trialEndsAt: "2026-11-01T00:00:00Z" }, true],
    [{ status: "suspended" }, false],
  ])("%j -> %s", (org, esperado) => {
    expect(organizacionOperable(org)).toBe(esperado);
  });
});
