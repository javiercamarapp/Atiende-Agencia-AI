// No-bloqueante de revisión (PR #158, ronda 1): `resolveProviderCalendarRefreshToken`
// (ver el comentario de cabecera del método en `../src/postgres-repository.ts`)
// atrapaba CUALQUIER error de `citas.get_provider_calendar_refresh_token` (Vault no
// disponible, criterio honesto ya establecido) con un `try/catch` simple, SIN
// `SAVEPOINT`, dentro del `withAppSession` propio del resolver
// (`apps/api/src/production/deps.ts`). Con la defensa de `managed-postgres-
// engine.ts` de este PR, eso pasaba de "skip silencioso" a
// `AbortedTransactionCommitError` -- mismo defecto, mismo fix
// (`runWithSavepointFallback`) que `postgres-repository-google-sync-invalid.spec.ts`
// ya cubre para `markAppointmentGoogleSyncInvalid`.
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const PROVIDER_ID = "00000000-0000-0000-0000-0000000000dd";
const SECRET_ID = "00000000-0000-0000-0000-0000000000ee";

function vaultRpcMissing(): Error & { code: string } {
  const err = new Error("function citas.get_provider_calendar_refresh_token(uuid) does not exist") as Error & { code: string };
  err.code = "42883";
  return err;
}

describe("PostgresCitasRepository.resolveProviderCalendarRefreshToken — SAVEPOINT contra Vault no disponible", () => {
  it("Vault no disponible (cualquier error del RPC): SAVEPOINT recupera la sesión, devuelve null, NUNCA lanza", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from citas\.provider_calendar_accounts/, respond: () => [{ google_refresh_token_secret_id: SECRET_ID }] },
      { match: /citas\.get_provider_calendar_refresh_token/, respond: () => vaultRpcMissing() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const result = await repo.resolveProviderCalendarRefreshToken(PROVIDER_ID);

    expect(result).toBeNull();
    // El SAVEPOINT sí corrió -- sin esto, la transacción del request/cron quedaría
    // abortada para cualquier consulta posterior (ver la prueba de control abajo).
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
    // La sesión sigue utilizable después -- una consulta normal posterior no debe
    // fallar con 25P02.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("sin cuenta conectada (sin secretId): devuelve null sin siquiera consultar Vault", async () => {
    const session = new AbortAwareFakeSession([{ match: /from citas\.provider_calendar_accounts/, respond: () => [{ google_refresh_token_secret_id: null }] }]);
    const repo = new PostgresCitasRepository(session);

    expect(await repo.resolveProviderCalendarRefreshToken(PROVIDER_ID)).toBeNull();
  });

  it("Vault disponible: devuelve el refresh token real, nunca corre el fallback", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from citas\.provider_calendar_accounts/, respond: () => [{ google_refresh_token_secret_id: SECRET_ID }] },
      { match: /citas\.get_provider_calendar_refresh_token/, respond: () => [{ get_provider_calendar_refresh_token: "rt_real_123" }] },
    ]);
    const repo = new PostgresCitasRepository(session);

    expect(await repo.resolveProviderCalendarRefreshToken(PROVIDER_ID)).toBe("rt_real_123");
  });

  it("prueba de que el bug era real: la MISMA secuencia SIN SAVEPOINT (catch simple) deja la sesión abortada para la siguiente consulta del request/cron", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from citas\.provider_calendar_accounts/, respond: () => [{ google_refresh_token_secret_id: SECRET_ID }] },
      { match: /citas\.get_provider_calendar_refresh_token/, respond: () => vaultRpcMissing() },
    ]);

    await expect(
      (async () => {
        try {
          await session.query(`select citas.get_provider_calendar_refresh_token($1) as get_provider_calendar_refresh_token;`, [SECRET_ID]);
        } catch {
          // catch simple -- exactamente el patrón roto que este fix corrige.
        }
        return session.query(`select 1;`, []);
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});
