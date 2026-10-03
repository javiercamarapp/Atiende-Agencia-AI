// Repositorio de metricas, ficha y onboarding por organizacion (0050): cada fuente falla por separado con una sesion que reproduce el
// estado ABORTADO real de una transaccion (AbortAwareFakeSession); una plana no sirve.
import { describe, expect, it } from "vitest";
import { InMemoryOrgFichaRepository, PostgresOrgFichaRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("PostgresOrgFichaRepository", () => {
  it("MISMA transaccion: la ficha sin migrar no tumba a las metricas que se leen despues (SAVEPOINT por fuente)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /get_org_ficha_for_superadmin/, respond: () => pgError("42883", "function core.get_org_ficha_for_superadmin(uuid, uuid, date) does not exist") },
      {
        match: /get_orgs_metricas_for_superadmin/,
        respond: () => [{ organization_id: "o1", operaciones_30d: "12", operaciones_razon: null, llm_30d_micro_usd: "3500000", eventos_30d_micro_usd: null, plan_id: "p1", plan_nombre: "Plan 1", plan_razon: null }],
      },
    ]);
    const repo = new PostgresOrgFichaRepository(session);
    await expect(repo.ficha("u1", "o1", "2026-09-30")).resolves.toEqual({ ok: false, razon: "no_migrado" });
    // Sin SAVEPOINT esta consulta fallaria con 25P02 (transaccion abortada) y el COMMIT daria ROLLBACK de todo el request.
    await expect(repo.metricas("u1", "2026-09-30")).resolves.toEqual({
      ok: true,
      data: [{ organizationId: "o1", operaciones30d: 12, operacionesRazon: null, llm30dMicroUsd: 3_500_000, eventos30dMicroUsd: null, planId: "p1", planNombre: "Plan 1", planRazon: null }],
    });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBe(1);
  });

  it("un error SQL que no es de migracion deja ESA fuente en 'error' (no se enmascara como no_migrado) y la sesion viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /get_orgs_onboarding_resumen_for_superadmin/, respond: () => pgError("57014", "canceling statement due to statement timeout") },
      { match: /get_org_onboarding_for_superadmin/, respond: () => [{ paso: "primera_operacion", titulo: "Primera operación real", estado: "no_se_pudo_medir", razon: "sin_fuente" }] },
    ]);
    const repo = new PostgresOrgFichaRepository(session);
    await expect(repo.onboardingResumen("u1")).resolves.toEqual({ ok: false, razon: "error" });
    // Un paso no medible llega tal cual (no_se_pudo_medir + razon): jamas se convierte en 'pendiente'.
    await expect(repo.onboarding("u1", "o1")).resolves.toEqual({ ok: true, data: [{ paso: "primera_operacion", titulo: "Primera operación real", estado: "no_se_pudo_medir", razon: "sin_fuente" }] });
  });

  it("la ficha de una organizacion inexistente (cero filas) es data null, no un error", async () => {
    const session = new AbortAwareFakeSession([{ match: /get_org_ficha_for_superadmin/, respond: () => [] }]);
    await expect(new PostgresOrgFichaRepository(session).ficha("u1", "o1", "2026-09-30")).resolves.toEqual({ ok: true, data: null });
  });

  it("el aviso de sistema devuelve los ids a avisar (sin emitir nada) y degrada sin la 0050", async () => {
    const ok = new AbortAwareFakeSession([{ match: /avisar_organizaciones_listas_for_system/, respond: () => [{ organization_id: "o1" }, { organization_id: "o2" }] }]);
    await expect(new PostgresOrgFichaRepository(ok).avisarListasForSystem()).resolves.toEqual({ ok: true, data: ["o1", "o2"] });
    expect(ok.calls.some((c) => /emit_notification/.test(c))).toBe(false);
    const viejo = new AbortAwareFakeSession([{ match: /avisar_organizaciones_listas_for_system/, respond: () => pgError("42883", "function core.avisar_organizaciones_listas_for_system() does not exist") }]);
    await expect(new PostgresOrgFichaRepository(viejo).avisarListasForSystem()).resolves.toEqual({ ok: false, razon: "no_migrado" });
    // Con un error que NO es de migracion (p. ej. timeout) responde 'error', no 'no_migrado'.
    const lento = new AbortAwareFakeSession([{ match: /avisar_organizaciones_listas_for_system/, respond: () => pgError("57014", "statement timeout") }]);
    await expect(new PostgresOrgFichaRepository(lento).avisarListasForSystem()).resolves.toEqual({ ok: false, razon: "error" });
  });
});

describe("InMemoryOrgFichaRepository", () => {
  it("un caller que no es superadmin recibe cero filas (misma semantica que el SQL) y sin sembrar responde no_migrado", async () => {
    const repo = new InMemoryOrgFichaRepository();
    await expect(repo.metricas("u1", "2026-09-30")).resolves.toEqual({ ok: false, razon: "no_migrado" });
    repo.seed({ metricas: { ok: true, data: [{ organizationId: "o1", operaciones30d: 1, operacionesRazon: null, llm30dMicroUsd: 0, eventos30dMicroUsd: 0, planId: null, planNombre: null, planRazon: null }] } });
    await expect(repo.metricas("intruso", "2026-09-30")).resolves.toEqual({ ok: true, data: [] });
    repo.seedSuperadmin("sa");
    expect((await repo.metricas("sa", "2026-09-30")).ok && (await repo.metricas("sa", "2026-09-30"))).toMatchObject({ data: [{ organizationId: "o1" }] });
  });
});
