// Repositorio de fichas de agente: cada fuente falla por separado con una sesion que reproduce el estado ABORTADO real de
// una transaccion (AbortAwareFakeSession); una plana no sirve.
import { describe, expect, it } from "vitest";
import { PostgresFichasAgenteRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("PostgresFichasAgenteRepository", () => {
  it("MISMA transaccion: una fuente sin migrar no tumba a las demas (ni antes ni despues)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /get_fichas_conciliados_for_superadmin/, respond: () => pgError("42883", "function core.get_fichas_conciliados_for_superadmin(uuid) does not exist") },
      { match: /get_fichas_documentos_extraidos_for_superadmin/, respond: () => [{ documentos: "2", requisitos: "4", licitaciones: "2", razon: null }] },
      { match: /get_fichas_voz_por_vertical_for_superadmin/, respond: () => [{ vertical: "restaurantes", minutos_voz: "5.000", costo_micro_usd: "1200000", eventos: "2" }] },
    ]);
    const repo = new PostgresFichasAgenteRepository(session);
    await expect(repo.documentosExtraidos("u1")).resolves.toEqual({ ok: true, data: { documentos: 2, requisitos: 4, licitaciones: 2, razon: null } });
    await expect(repo.conciliados("u1")).resolves.toEqual({ ok: false, razon: "no_migrado" });
    // Sin SAVEPOINT esta consulta fallaria con 25P02 (transaccion abortada) y el COMMIT daria ROLLBACK.
    await expect(repo.vozPorVertical("u1")).resolves.toEqual({ ok: true, data: [{ vertical: "restaurantes", minutosVoz: 5, costoMicroUsd: 1_200_000, eventos: 2 }] });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBe(1);
  });

  it("un error SQL que no es de migracion queda en 'error' (no se enmascara como no_migrado) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /get_fichas_actividad_diaria_for_superadmin/, respond: () => pgError("57014", "canceling statement due to statement timeout") },
      { match: /get_fichas_modelos_por_rol_for_superadmin/, respond: () => [] },
    ]);
    const repo = new PostgresFichasAgenteRepository(session);
    await expect(repo.actividadDiaria("u1", "2026-09-24", "2026-09-30")).resolves.toEqual({ ok: false, razon: "error" });
    await expect(repo.modelosPorRol("u1", "2026-09-01", "2026-09-30")).resolves.toEqual({ ok: true, data: [] });
  });

  it("cero filas en una fuente de una sola fila (el SQL no reconocio al superadmin) es lectura fallida, no '0 documentos'", async () => {
    const session = new AbortAwareFakeSession([
      { match: /get_fichas_documentos_extraidos_for_superadmin/, respond: () => [] },
      { match: /get_fichas_conciliados_for_superadmin/, respond: () => [] },
    ]);
    const repo = new PostgresFichasAgenteRepository(session);
    await expect(repo.documentosExtraidos("u1")).resolves.toEqual({ ok: false, razon: "error" });
    await expect(repo.conciliados("u1")).resolves.toEqual({ ok: false, razon: "error" });
  });

  it("deja los null y la razon fuente_no_migrada tal cual (nunca los vuelve 0) y mapea bigint de texto", async () => {
    const session = new AbortAwareFakeSession([
      { match: /get_fichas_documentos_extraidos_for_superadmin/, respond: () => [{ documentos: null, requisitos: null, licitaciones: null, razon: "fuente_no_migrada" }] },
      {
        match: /get_fichas_modelos_por_rol_for_superadmin/,
        respond: () => [{ vertical: "restaurantes", role: "restaurantes:whatsapp_agent", provider_id: "p", model: "m1", lane: "interactive", llamadas: "7", fallbacks: "1", costo_micro_usd: "3400000", tokens_in: "120", tokens_out: "60" }],
      },
    ]);
    const repo = new PostgresFichasAgenteRepository(session);
    await expect(repo.documentosExtraidos("u1")).resolves.toEqual({ ok: true, data: { documentos: null, requisitos: null, licitaciones: null, razon: "fuente_no_migrada" } });
    await expect(repo.modelosPorRol("u1", "2026-09-01", "2026-09-30")).resolves.toEqual({
      ok: true,
      data: [{ vertical: "restaurantes", role: "restaurantes:whatsapp_agent", providerId: "p", model: "m1", lane: "interactive", llamadas: 7, fallbacks: 1, costoMicroUsd: 3_400_000, tokensIn: 120, tokensOut: 60 }],
    });
  });
});
