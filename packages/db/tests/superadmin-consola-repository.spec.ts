// Repositorio de la consola: cada fuente falla por separado con una sesion que reproduce el estado ABORTADO real de
// una transaccion (AbortAwareFakeSession); una plana no sirve.
import { describe, expect, it } from "vitest";
import { PostgresConsolaRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("PostgresConsolaRepository", () => {
  it("MISMA transaccion: una fuente sin migrar no tumba a las demas (ni antes ni despues)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /get_consola_costo_historico_for_superadmin/, respond: () => pgError("42883", "function core.get_consola_costo_historico_for_superadmin(uuid) does not exist") },
      { match: /get_consola_organizaciones_for_superadmin/, respond: () => [{ vertical: "restaurantes", total: "2", demo: "1", activas: "2" }] },
      { match: /get_consola_alcance_for_superadmin/, respond: () => [{ sucursales_activas: "3", staff_con_membresia: "4", superadmins: "1", usuarios_con_acceso: "4" }] },
    ]);
    const repo = new PostgresConsolaRepository(session);
    await expect(repo.organizaciones("u1")).resolves.toEqual({ ok: true, data: [{ vertical: "restaurantes", total: 2, demo: 1, activas: 2 }] });
    await expect(repo.costoHistorico("u1")).resolves.toEqual({ ok: false, razon: "no_migrado" });
    // Sin SAVEPOINT esta consulta fallaria con 25P02 (transaccion abortada) y el COMMIT daria ROLLBACK.
    await expect(repo.alcance("u1")).resolves.toEqual({ ok: true, data: { sucursalesActivas: 3, staffConMembresia: 4, superadmins: 1, usuariosConAcceso: 4 } });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBe(1);
  });

  it("un error SQL que no es de migracion deja ESA fuente en 'error' (no se enmascara como no_migrado) y la sesion viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /get_consola_conversaciones_wa_for_superadmin/, respond: () => pgError("57014", "canceling statement due to statement timeout") },
      { match: /get_consola_organizaciones_for_superadmin/, respond: () => [] },
    ]);
    const repo = new PostgresConsolaRepository(session);
    await expect(repo.conversacionesWa("u1")).resolves.toEqual({ ok: false, razon: "error" });
    await expect(repo.organizaciones("u1")).resolves.toEqual({ ok: true, data: [] });
  });

  it("cero filas en alcance (el SQL no reconocio al superadmin) es una lectura fallida, no '0 usuarios'", async () => {
    const session = new AbortAwareFakeSession([{ match: /get_consola_alcance_for_superadmin/, respond: () => [] }]);
    await expect(new PostgresConsolaRepository(session).alcance("u1")).resolves.toEqual({ ok: false, razon: "error" });
  });

  it("mapea bigint/numeric de texto a numero y deja los null como null", async () => {
    const session = new AbortAwareFakeSession([
      { match: /get_consola_operaciones_for_superadmin/, respond: () => [{ vertical: "despachos", dia: null, cantidad: null, razon: "sin_fuente" }, { vertical: "citas", dia: "2026-09-30", cantidad: "7", razon: null }] },
      { match: /get_consola_costo_historico_for_superadmin/, respond: () => [{ fuente: "voz", costo_micro_usd: "300000", tokens_in: null, tokens_out: null, eventos: "2", minutos_voz: "2.000" }] },
    ]);
    const repo = new PostgresConsolaRepository(session);
    await expect(repo.operaciones("u1", "2026-09-30", "2026-09-30")).resolves.toEqual({
      ok: true,
      data: [{ vertical: "despachos", dia: null, cantidad: null, razon: "sin_fuente" }, { vertical: "citas", dia: "2026-09-30", cantidad: 7, razon: null }],
    });
    await expect(repo.costoHistorico("u1")).resolves.toEqual({ ok: true, data: [{ fuente: "voz", costoMicroUsd: 300000, tokensIn: null, tokensOut: null, eventos: 2, minutosVoz: 2 }] });
  });
});
