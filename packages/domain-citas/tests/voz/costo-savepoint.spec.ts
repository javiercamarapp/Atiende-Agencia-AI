// Costo por llamada de la voz de citas contra `core.usage_cost_event` con la REGLA DURA de la base sin migrar: AbortAwareFakeSession reproduce el estado
// ABORTADO de una transaccion (tras un error toda consulta lanza 25P02 salvo ROLLBACK TO SAVEPOINT). Una sesion falsa plana NO sirve.
import { describe, expect, it } from "vitest";
import { eventosCostoLlamada } from "@atiende/voice-core";
import { InMemoryCostoVozRepository, PostgresCostoVozRepository } from "../../src/voz/costo-repositorio.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

const O = "00000000-0000-0000-0000-0000000000a0";
const P = "00000000-0000-0000-0000-0000000000a1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const eventos = eventosCostoLlamada({
  vertical: "citas",
  llamadaId: "llamada-1",
  organizationId: O,
  propertyId: P,
  ocurridoEn: "2031-06-01T18:00:00Z",
  tramos: [
    { escalon: "gemini-3.8-live", duracionS: 30, costoReportadoMicroUsd: 0 },
    { escalon: "cascada-openrouter", duracionS: 60, costoReportadoMicroUsd: 0 },
  ],
});

const despues = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };

describe("PostgresCostoVozRepository", () => {
  it("escribe UN evento por escalon con los argumentos de core.record_usage_cost_event", async () => {
    const vistos: unknown[][] = [];
    const session = new AbortAwareFakeSession([{ match: /core\.record_usage_cost_event/i, respond: () => [{ nuevo: true }] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      if (/record_usage_cost_event/i.test(sql)) vistos.push(params ?? []);
      return original(sql, params);
    }) as typeof session.query;
    const r = await new PostgresCostoVozRepository(session).registrarCostoLlamada(eventos);
    expect(r).toEqual({ disponible: true, registrados: 2, repetidos: 0 });
    expect(vistos.map((p) => [p[0], p[1], p[3], p[4], p[5], p[9], p[10]])).toEqual([
      [O, P, "voz", "gemini-3.8-live", "segundo", "voz_citas", "llamada-1:gemini-3.8-live"],
      [O, P, "voz", "cascada-openrouter", "segundo", "voz_citas", "llamada-1:cascada-openrouter"],
    ]);
  });

  it("un reintento (la funcion devuelve false por idempotencia) cuenta como repetido, no como nuevo", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.record_usage_cost_event/i, respond: () => [{ nuevo: false }] }]);
    expect(await new PostgresCostoVozRepository(session).registrarCostoLlamada(eventos)).toEqual({ disponible: true, registrados: 0, repetidos: 2 });
  });

  for (const [codigo, texto] of [
    ["42883", "function core.record_usage_cost_event(uuid, uuid, timestamp with time zone, text, text, text, numeric, bigint, boolean, text, text) does not exist"],
    ["42P01", 'relation "core.usage_cost_event" does not exist'],
    ["42703", 'column "x" does not exist'],
  ] as const) {
    it(`base sin migrar (${codigo}): costo 'no disponible aun' y la sesion SIGUE viva (SAVEPOINT, sin 25P02)`, async () => {
      const session = new AbortAwareFakeSession([{ match: /core\.record_usage_cost_event/i, respond: () => pgError(codigo, texto) }, despues]);
      const r = await new PostgresCostoVozRepository(session).registrarCostoLlamada(eventos);
      expect(r).toEqual({ disponible: false, registrados: 0, repetidos: 0 });
      await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
      expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    });
  }

  it("un error que NO es de migracion pendiente (sesion de staff, 42501) se repropaga y tambien deja la sesion utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.record_usage_cost_event/i, respond: () => pgError("42501", "record_usage_cost_event: solo sesion de sistema") }, despues]);
    await expect(new PostgresCostoVozRepository(session).registrarCostoLlamada(eventos)).rejects.toMatchObject({ code: "42501" });
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});

describe("InMemoryCostoVozRepository", () => {
  it("es idempotente por ref_tipo + ref_id y puede simular la base sin migrar", async () => {
    const repo = new InMemoryCostoVozRepository();
    expect(await repo.registrarCostoLlamada(eventos)).toEqual({ disponible: true, registrados: 2, repetidos: 0 });
    expect(await repo.registrarCostoLlamada(eventos)).toEqual({ disponible: true, registrados: 0, repetidos: 2 });
    repo.disponible = false;
    expect((await repo.registrarCostoLlamada(eventos)).disponible).toBe(false);
  });
});

describe("citas sin sucursal propia", () => {
  it("una llamada sin sucursal manda property_id NULL a la funcion (la base lo acepta y fija la vertical desde la organizacion)", async () => {
    const vistos: unknown[][] = [];
    const session = new AbortAwareFakeSession([{ match: /core\.record_usage_cost_event/i, respond: () => [{ nuevo: true }] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      if (/record_usage_cost_event/i.test(sql)) vistos.push(params ?? []);
      return original(sql, params);
    }) as typeof session.query;
    const sinSucursal = eventosCostoLlamada({ vertical: "citas", llamadaId: "llamada-2", organizationId: O, propertyId: null, ocurridoEn: "2031-06-01T18:00:00Z", tramos: [{ escalon: "gemini-3.8-live", duracionS: 20, costoReportadoMicroUsd: 0 }] });
    await new PostgresCostoVozRepository(session).registrarCostoLlamada(sinSucursal);
    expect(vistos[0]![1]).toBeNull();
    expect(vistos[0]![9]).toBe("voz_citas");
  });
});
