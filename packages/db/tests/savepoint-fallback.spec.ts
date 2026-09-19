// runWithSavepointFallback — corrector prioritario (auditoría a1, causa raíz común
// de los hallazgos CRITICO/ALTO): ver el comentario de cabecera de
// `../src/savepoint-fallback.ts` para el porqué completo. Estos tests prueban el
// helper en aislamiento, contra `AbortAwareFakeSession` (ver `./support/aborting-
// fake-session.ts`) -- el doble que SÍ reproduce 25P02/estado abortado, a diferencia
// del `fakeSession` plano que ya existía en este archivo hermano
// (`postgres-core-repository-org-admin-fallback.spec.ts`).
import { describe, expect, it } from "vitest";
import { runWithSavepointFallback } from "../src/savepoint-fallback.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message = "boom"): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("runWithSavepointFallback", () => {
  it("camino primario sin error: SAVEPOINT + RELEASE SAVEPOINT, nunca corre el fallback", async () => {
    const session = new AbortAwareFakeSession([]);
    let fallbackRan = false;

    const result = await runWithSavepointFallback({
      session,
      primary: async () => "ok",
      isRecoverable: () => true,
      fallback: async () => {
        fallbackRan = true;
        return "fallback";
      },
    });

    expect(result).toBe("ok");
    expect(fallbackRan).toBe(false);
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("release savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(false);
  });

  it("error recuperable: ROLLBACK TO SAVEPOINT deja la sesión utilizable ANTES de correr el fallback (sin esto, el fallback fallaría con 25P02)", async () => {
    const session = new AbortAwareFakeSession([{ match: /select 1/, respond: () => [] }]);
    const calls: string[] = [];

    const result = await runWithSavepointFallback({
      session,
      primary: async () => {
        throw pgError("23514");
      },
      isRecoverable: (err) => (err as { code?: string })?.code === "23514",
      fallback: async () => {
        // Si el ROLLBACK TO SAVEPOINT no hubiera corrido antes, esta query real
        // fallaría con 25P02 -- demuestra que la sesión sí quedó recuperada.
        calls.push("fallback-query");
        await session.query("select 1;");
        return "fallback-result";
      },
    });

    expect(result).toBe("fallback-result");
    expect(calls).toEqual(["fallback-query"]);
    const savepointName = session.calls.find((c) => c.startsWith("savepoint sp_fallback_"))!.replace("savepoint ", "");
    expect(session.calls).toContain(`rollback to savepoint ${savepointName}`);
    expect(session.calls).toContain(`release savepoint ${savepointName}`);
  });

  it("error NO recuperable: se repropaga tal cual, DESPUÉS de recuperar la sesión (para que un catch exterior en el mismo lote la siga usando)", async () => {
    const session = new AbortAwareFakeSession([{ match: /select 1/, respond: () => [] }]);
    let fallbackRan = false;

    await expect(
      runWithSavepointFallback({
        session,
        primary: async () => {
          throw pgError("57P01", "admin shutdown");
        },
        isRecoverable: (err) => (err as { code?: string })?.code === "23514",
        fallback: async () => {
          fallbackRan = true;
          return "no debería correr";
        },
      }),
    ).rejects.toMatchObject({ code: "57P01" });

    expect(fallbackRan).toBe(false);
    // La sesión quedó recuperada (ROLLBACK TO SAVEPOINT corrió) aunque el error se
    // repropague -- una consulta posterior sobre la MISMA sesión debe funcionar.
    const session2 = session; // misma instancia, misma transacción simulada
    await expect(session2.query("select 1;")).resolves.toBeTruthy();
  });

  it("prueba de que el bug era real: SIN SAVEPOINT, la misma secuencia (error + consulta de respaldo) deriva en 25P02", async () => {
    const session = new AbortAwareFakeSession([{ match: /fn_que_no_existe/, respond: () => pgError("42883") }]);
    await expect(
      (async () => {
        try {
          await session.query("select core.fn_que_no_existe();");
        } catch {
          // catch simple, SIN savepoint -- exactamente el patrón roto que el
          // hallazgo de la auditoría describe.
        }
        return session.query("select 1 as fallback;");
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });

  it("aísla una fila venenosa de un lote: isRecoverable siempre true + fallback relanza el mismo error, la sesión queda utilizable para la SIGUIENTE fila", async () => {
    const session = new AbortAwareFakeSession([{ match: /select 1/, respond: () => [] }]);

    await expect(
      runWithSavepointFallback({
        session,
        primary: async () => {
          throw pgError("23514", "fila venenosa");
        },
        isRecoverable: () => true,
        fallback: async (err) => {
          throw err;
        },
      }),
    ).rejects.toMatchObject({ code: "23514" });

    // La "siguiente fila" del lote reutiliza la MISMA sesión/transacción -- debe
    // poder correr consultas normales sin 25P02.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("sin transacción abierta (SAVEPOINT -> 25P01): corre primary/fallback directo, sin SAVEPOINT ni ROLLBACK TO SAVEPOINT", async () => {
    const session = new AbortAwareFakeSession([]);
    session.noActiveTransaction = true;

    const result = await runWithSavepointFallback({
      session,
      primary: async () => {
        throw pgError("23514");
      },
      isRecoverable: (err) => (err as { code?: string })?.code === "23514",
      fallback: async () => "fallback-sin-transaccion",
    });

    expect(result).toBe("fallback-sin-transaccion");
    // El helper SÍ intenta el SAVEPOINT (así detecta 25P01), pero nunca llega a
    // RELEASE/ROLLBACK TO SAVEPOINT -- no hay nada que liberar/revertir.
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(false);
    expect(session.calls.some((c) => c.startsWith("release savepoint"))).toBe(false);
  });
});
