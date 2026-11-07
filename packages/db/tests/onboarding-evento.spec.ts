// Hitos de onboarding (migracion 0073): registro idempotente y lectura con SAVEPOINT. Contra una base sin la 0073 o ante un rechazo
// (42501) nunca se rompe la sesion compartida del request.
import { describe, expect, it } from "vitest";
import { hayOnboardingEvento, registrarOnboardingEvento } from "../src/onboarding-evento.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-000000000073";
const pgError = (code: string, message = "x") => Object.assign(new Error(message), { code });

describe("registrarOnboardingEvento", () => {
  it("registrado / ya_existia segun lo que devuelve la funcion SQL", async () => {
    let primera = true;
    const db = new AbortAwareFakeSession([
      {
        match: /core\.registrar_onboarding_evento/,
        respond: () => {
          const r = [{ insertado: primera }];
          primera = false;
          return r;
        },
      },
    ]);
    expect(await registrarOnboardingEvento(db, { organizationId: ORG, vertical: "restaurantes", tipo: "prueba_agente_whatsapp" })).toBe("registrado");
    expect(await registrarOnboardingEvento(db, { organizationId: ORG, vertical: "restaurantes", tipo: "prueba_agente_whatsapp" })).toBe("ya_existia");
  });

  it.each([
    ["42883", "no_migrado"],
    ["42P01", "no_migrado"],
    ["42501", "error"],
  ])("SQLSTATE %s -> %s y la sesion sigue utilizable", async (code, esperado) => {
    const db = new AbortAwareFakeSession([
      { match: /core\.registrar_onboarding_evento/, respond: () => pgError(code, "function core.registrar_onboarding_evento(uuid, text, text, uuid, jsonb) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    expect(await registrarOnboardingEvento(db, { organizationId: ORG, vertical: "restaurantes", tipo: "prueba_agente_whatsapp" })).toBe(esperado);
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});

describe("hayOnboardingEvento", () => {
  it("true/false de la lectura; null sin la 0073", async () => {
    const si = new AbortAwareFakeSession([{ match: /from core\.onboarding_evento/, respond: () => [{ hay: true }] }]);
    expect(await hayOnboardingEvento(si, ORG, "restaurantes", "prueba_agente_whatsapp")).toBe(true);
    const sinTabla = new AbortAwareFakeSession([
      { match: /from core\.onboarding_evento/, respond: () => pgError("42P01") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    expect(await hayOnboardingEvento(sinTabla, ORG, "restaurantes", "prueba_agente_whatsapp")).toBeNull();
    await expect(sinTabla.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});
