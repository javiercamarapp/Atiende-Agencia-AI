// Rn-20 -- el encolado del correo de invitacion de staff es best-effort y corre en la MISMA transaccion de la sesion de
// staff que ya persistio la invitacion: un error de Postgres al encolar NO puede dejarla abortada (25P02), o el COMMIT
// final revertiria tambien la invitacion. Se prueba contra PostgresRentasRepository real + AbortAwareFakeSession (una
// sesion falsa plana NO reproduce el estado abortado).
import { describe, expect, it, vi } from "vitest";
import { PostgresRentasRepository } from "../src/postgres-repository.ts";
import { tryEnqueueStaffInviteEmail } from "../src/staff-invite-email.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const CORREO = { asunto: "Invitación", html: "<p>hola</p>", texto: "hola" };
const IDS = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2", "00000000-0000-4000-8000-0000000000a3"] as const;

function pgError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

describe("tryEnqueueStaffInviteEmail", () => {
  it("camino feliz: encola en el outbox de email con el evento staff.invite y libera el SAVEPOINT", async () => {
    const session = new AbortAwareFakeSession([{ match: /enqueue_messaging_outbox/, respond: () => [{ enqueue_messaging_outbox: "job-1" }] }]);
    const ok = await tryEnqueueStaffInviteEmail(new PostgresRentasRepository(session), session, IDS[0], IDS[1], IDS[2], "a@b.mx", CORREO);
    expect(ok).toBe(true);
    expect(session.calls.some((c) => c.startsWith("release savepoint"))).toBe(true);
  });

  for (const [code, mensaje] of [
    ["42501", "permission denied for function enqueue_messaging_outbox"],
    ["40P01", "deadlock detected"],
    ["57014", "canceling statement due to statement timeout"],
  ] as const) {
    it(`un error real de Postgres (${code}) NO deja la transaccion abortada: la invitacion y las consultas siguientes siguen validas`, async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const session = new AbortAwareFakeSession([
        { match: /enqueue_messaging_outbox/, respond: () => pgError(code, mensaje) },
        { match: /select 1 as despues/, respond: () => [{ despues: 1 }] },
      ]);
      const ok = await tryEnqueueStaffInviteEmail(new PostgresRentasRepository(session), session, IDS[0], IDS[1], IDS[2], "a@b.mx", CORREO);
      expect(ok).toBe(false);
      // Sin SAVEPOINT esta consulta lanzaria 25P02 y el commit devolveria ROLLBACK.
      await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ despues: 1 }] });
      expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
      log.mockRestore();
    });
  }

  it("si la transaccion YA venia abortada por una causa ajena, tampoco lanza (nunca tumba la invitacion)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = new AbortAwareFakeSession([{ match: /boom/, respond: () => pgError("42P01", "relation missing") }]);
    await session.query("select boom").catch(() => undefined);
    await expect(tryEnqueueStaffInviteEmail(new PostgresRentasRepository(session), session, IDS[0], IDS[1], IDS[2], "a@b.mx", CORREO)).resolves.toBe(false);
    log.mockRestore();
  });
});
