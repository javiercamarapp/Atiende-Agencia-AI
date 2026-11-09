// REGLA DURA de compatibilidad con la base sin migrar (migración 025): con AbortAwareFakeSession (reproduce el estado abortado 25P02 de una transacción real, no una
// sesión falsa plana) cada operación nueva del repositorio degrada a "no disponible aún" DENTRO de un SAVEPOINT y deja la transacción utilizable; y los SQLSTATE propios
// de la 025 (CF001..CF004) se traducen a errores de dominio tipados (409 en la ruta).
import { describe, expect, it } from "vitest";
import {
  ConciliacionCfdiCanceladoError,
  ConciliacionConflictoError,
  ConciliacionNoDisponibleError,
  ConciliacionPilotoApagadoError,
  ConciliacionSignoInvertidoError,
  ConciliacionTopeCfdiExcedidoError,
  PostgresConciliacionPersistidaRepository,
  traducirErrorConciliacion,
} from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const pgError = (code: string, msg: string) => Object.assign(new Error(msg), { code });
const SIGUIENTE = { match: /^select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
const usable = (s: AbortAwareFakeSession) => expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
const UUID = "00000000-0000-0000-0000-000000000001";

describe("PostgresConciliacionPersistidaRepository -- base sin la migración 025", () => {
  it("leerPropuestas: columna inexistente (42703) -> no disponible, sin transacción abortada", async () => {
    const s = new AbortAwareFakeSession([{ match: /select propuestas from despachos\.conciliacion_sesion/, respond: () => pgError("42703", 'column "propuestas" does not exist') }, SIGUIENTE]);
    expect(await new PostgresConciliacionPersistidaRepository(s).leerPropuestas(UUID)).toEqual({ estado: "no_disponible", datos: null });
    expect(s.calls.some((c) => c.startsWith("rollback to savepoint sp_conc_"))).toBe(true);
    await usable(s);
  });
  it("autoconfirmarNivel1Activo: columna inexistente -> false (apagado), sin transacción abortada", async () => {
    const s = new AbortAwareFakeSession([{ match: /conciliacion_autoconfirmar_nivel1/, respond: () => pgError("42703", "column does not exist") }, SIGUIENTE]);
    expect(await new PostgresConciliacionPersistidaRepository(s).autoconfirmarNivel1Activo(UUID)).toBe(false);
    await usable(s);
  });
  it.each([
    ["guardarPropuestas", /conciliacion_sesion_propuestas_guardar/, (r: PostgresConciliacionPersistidaRepository) => r.guardarPropuestas(UUID, UUID, { version: 1, calculadoEn: "x", propuestas: [], multiLinea: [], ambiguas: [], sinConciliar: [] })],
    ["asegurarSesion", /conciliacion_sesion_asegurar/, (r: PostgresConciliacionPersistidaRepository) => r.asegurarSesion(UUID, "2026-07", null)],
    ["confirmarAutopiloto", /conciliacion_autopiloto_confirmar/, (r: PostgresConciliacionPersistidaRepository) => r.confirmarAutopiloto(UUID, UUID, [{ movimientoId: UUID, invoiceId: UUID, confianza: 100 }])],
    ["configurarAutoconfirmarNivel1", /insert into despachos\.property_config/, (r: PostgresConciliacionPersistidaRepository) => r.configurarAutoconfirmarNivel1(UUID, UUID, true)],
  ])("%s -> ConciliacionNoDisponibleError y la transacción sigue utilizable (sin 25P02)", async (_n, match, llamar) => {
    const s = new AbortAwareFakeSession([{ match, respond: () => pgError("42883", "function despachos.conciliacion_x(uuid) does not exist") }, SIGUIENTE]);
    await expect(llamar(new PostgresConciliacionPersistidaRepository(s))).rejects.toBeInstanceOf(ConciliacionNoDisponibleError);
    expect(s.calls.some((c) => c.startsWith("rollback to savepoint sp_conc_"))).toBe(true);
    await usable(s);
  });
  it("un error que NO es 'migración pendiente' se propaga (no se enmascara)", async () => {
    const real = pgError("40P01", "deadlock detected");
    const s = new AbortAwareFakeSession([{ match: /conciliacion_sesion_asegurar/, respond: () => real }, SIGUIENTE]);
    await expect(new PostgresConciliacionPersistidaRepository(s).asegurarSesion(UUID, "2026-07", null)).rejects.toBe(real);
    await usable(s);
  });
});

describe("traducirErrorConciliacion: SQLSTATE propios de la 025 -> 409 tipado", () => {
  it.each([
    ["CF001", ConciliacionCfdiCanceladoError],
    ["CF002", ConciliacionTopeCfdiExcedidoError],
    ["CF003", ConciliacionSignoInvertidoError],
    ["CF004", ConciliacionPilotoApagadoError],
  ])("%s", (code, Clase) => {
    const t = traducirErrorConciliacion(pgError(code, "conciliacion_match: x"));
    expect(t).toBeInstanceOf(Clase);
    expect(t).toBeInstanceOf(ConciliacionConflictoError); // la ruta lo traduce a 409
  });
});
