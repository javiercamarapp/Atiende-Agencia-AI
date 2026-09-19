// No-bloqueante de re-revisión (PR #158, r3): `resolveProviderCalComApiKey` y
// `resolveProviderCalDavPassword` (ver el comentario de cabecera de cada método en
// `../src/postgres-repository.ts`) eran sitios HERMANOS de
// `resolveProviderCalendarRefreshToken` -- atrapaban CUALQUIER error de
// `citas.get_provider_calendar_refresh_token` con un `try/catch` simple, SIN
// `SAVEPOINT`, dentro de la MISMA sesión que `createCalendarSyncPortResolver`
// reutiliza para varias cuentas de la misma corrida (Google, Cal.com, CalDAV -- ver
// `calendar-sync-resolver-factory.ts`). El refresh token de Google ya se corrigió en
// la ronda 1 (`postgres-repository-resolve-refresh-token-savepoint.spec.ts`); este
// archivo cubre los dos sitios que la ronda 1 dejó sin convertir, con el MISMO
// SAVEPOINT (`runWithSavepointFallback`) y la aserción de "sesión utilizable
// DESPUÉS del método" que la re-revisión pidió agregar explícitamente.
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const PROVIDER_ID = "00000000-0000-0000-0000-0000000000ff";
const SECRET_ID = "00000000-0000-0000-0000-0000000000aa";

function vaultRpcMissing(): Error & { code: string } {
  const err = new Error("function citas.get_provider_calendar_refresh_token(uuid) does not exist") as Error & { code: string };
  err.code = "42883";
  return err;
}

describe("PostgresCitasRepository.resolveProviderCalComApiKey — SAVEPOINT contra Vault no disponible", () => {
  it("Vault no disponible: SAVEPOINT recupera la sesión, devuelve null, la sesión queda utilizable DESPUÉS del método", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from citas\.provider_calcom_accounts/, respond: () => [{ calcom_api_key_secret_id: SECRET_ID }] },
      { match: /citas\.get_provider_calendar_refresh_token/, respond: () => vaultRpcMissing() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await repo.resolveProviderCalComApiKey(PROVIDER_ID);

    expect(result).toBeNull();
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
    // Aserción explícita pedida por la re-revisión (r3): la sesión sigue utilizable
    // DESPUÉS del método -- una consulta normal posterior no debe fallar con 25P02
    // (a diferencia del catch simple sin SAVEPOINT que este fix reemplaza).
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("sin cuenta conectada (sin secretId): devuelve null sin siquiera consultar Vault", async () => {
    const session = new AbortAwareFakeSession([{ match: /from citas\.provider_calcom_accounts/, respond: () => [{ calcom_api_key_secret_id: null }] }]);
    const repo = new PostgresCitasRepository(session);

    expect(await repo.resolveProviderCalComApiKey(PROVIDER_ID)).toBeNull();
  });

  it("Vault disponible: devuelve la api key real, nunca corre el fallback", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from citas\.provider_calcom_accounts/, respond: () => [{ calcom_api_key_secret_id: SECRET_ID }] },
      { match: /citas\.get_provider_calendar_refresh_token/, respond: () => [{ get_provider_calendar_refresh_token: "cal_real_123" }] },
    ]);
    const repo = new PostgresCitasRepository(session);

    expect(await repo.resolveProviderCalComApiKey(PROVIDER_ID)).toBe("cal_real_123");
  });
});

describe("PostgresCitasRepository.resolveProviderCalDavPassword — SAVEPOINT contra Vault no disponible", () => {
  it("Vault no disponible: SAVEPOINT recupera la sesión, devuelve null, la sesión queda utilizable DESPUÉS del método", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from citas\.provider_caldav_accounts/, respond: () => [{ caldav_password_secret_id: SECRET_ID }] },
      { match: /citas\.get_provider_calendar_refresh_token/, respond: () => vaultRpcMissing() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await repo.resolveProviderCalDavPassword(PROVIDER_ID);

    expect(result).toBeNull();
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("sin cuenta conectada (sin secretId): devuelve null sin siquiera consultar Vault", async () => {
    const session = new AbortAwareFakeSession([{ match: /from citas\.provider_caldav_accounts/, respond: () => [{ caldav_password_secret_id: null }] }]);
    const repo = new PostgresCitasRepository(session);

    expect(await repo.resolveProviderCalDavPassword(PROVIDER_ID)).toBeNull();
  });

  it("Vault disponible: devuelve el password real, nunca corre el fallback", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from citas\.provider_caldav_accounts/, respond: () => [{ caldav_password_secret_id: SECRET_ID }] },
      { match: /citas\.get_provider_calendar_refresh_token/, respond: () => [{ get_provider_calendar_refresh_token: "app-password-real" }] },
    ]);
    const repo = new PostgresCitasRepository(session);

    expect(await repo.resolveProviderCalDavPassword(PROVIDER_ID)).toBe("app-password-real");
  });

  it("prueba de que, incluso hoy con SAVEPOINT, un error NO reconocido (isRecoverable siempre true aquí, igual que el resolver de Google) recupera la sesión antes de repropagar -- nunca dejaría un cron/resolver posterior con 25P02", async () => {
    const otroError = new Error("timeout de red hacia Vault") as Error & { code: string };
    otroError.code = "ETIMEDOUT";
    const session = new AbortAwareFakeSession([
      { match: /from citas\.provider_caldav_accounts/, respond: () => [{ caldav_password_secret_id: SECRET_ID }] },
      { match: /citas\.get_provider_calendar_refresh_token/, respond: () => otroError },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    // isRecoverable: () => true (mismo criterio que resolveProviderCalendarRefreshToken)
    // -- cualquier error de Vault degrada a null, nunca tumba la corrida completa.
    expect(await repo.resolveProviderCalDavPassword(PROVIDER_ID)).toBeNull();
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});
