// Fix hallazgo auditoría a2 (CRÍTICO) — `InMemoryTenancyEngine.exec()` (motor usado
// por casi todos los fixtures de apps/api/tests, ver in-memory-tenancy-engine.ts)
// lanzaba SIEMPRE, sin excepción. Los 6 triggers inline de
// apps/api/.../email-dispatch.ts ahora llaman `db.exec("SAVEPOINT ...")` sobre el
// MISMO `db` que las rutas de staff obtienen de `c.get("db")` (ver
// core-auth/src/middleware.ts::dbSession) -- sin este fix, CUALQUIER test que
// ejercite una ruta de staff que dispare el drenado inline (folios/reservas/cfdi de
// hoteles, appointments-lifecycle de citas, vencimientos de despachos) fallaría con
// "exec() no soportado" en vez de exercitar el fix real.
import { describe, expect, it } from "vitest";
import { InMemoryTenancyEngine } from "../src/in-memory-tenancy-engine.ts";

describe("InMemoryTenancyEngine.exec() — soporte de SAVEPOINT", () => {
  it("SAVEPOINT/RELEASE SAVEPOINT/ROLLBACK TO SAVEPOINT son no-ops seguros (mayúsculas/minúsculas)", async () => {
    const engine = new InMemoryTenancyEngine();
    await engine.withAppSession({ userId: null }, async (db) => {
      await expect(db.exec("SAVEPOINT sp_inline_email_dispatch")).resolves.toBeUndefined();
      await expect(db.exec("release savepoint sp_inline_email_dispatch")).resolves.toBeUndefined();
      await expect(db.exec("Rollback To Savepoint sp_inline_email_dispatch")).resolves.toBeUndefined();
    });
  });

  it("sigue rechazando cualquier otro exec() (alcance angosto a propósito, no una regresión del fix)", async () => {
    const engine = new InMemoryTenancyEngine();
    await engine.withAppSession({ userId: null }, async (db) => {
      await expect(db.exec("begin")).rejects.toThrow(/no soportado/);
      await expect(db.exec("commit")).rejects.toThrow(/no soportado/);
    });
  });
});
