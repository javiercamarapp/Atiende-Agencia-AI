// D-04 (migracion 014): las funciones despachos.efos_* corren dentro de la transaccion
// compartida del request (la ingesta de CFDI sigue con insertInvoice/createReview despues).
// REGLA DURA de compatibilidad: contra la base SIN migrar el 42883/42P01 debe degradar a
// "lista no disponible" SIN dejar la transaccion abortada. AbortAwareFakeSession reproduce el
// estado 25P02 de Postgres real (una sesion falsa plana NO lo reproduce).
import { describe, expect, it } from "vitest";
import { PostgresDespachosRepository } from "../src/postgres-repository.ts";
import { InMemoryDespachosRepository } from "../src/in-memory-repository.ts";
import { EfosUnavailableError } from "../src/errors.ts";
import type { EfosContribuyente } from "../src/cfdi/efos.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const CONSULTAR_RE = /from despachos\.efos_consultar/i;
const ESTADO_RE = /from despachos\.efos_estado/i;
const AFECTADOS_RE = /from despachos\.efos_invoices_afectados/i;
const INGESTAR_RE = /despachos\.efos_ingestar_periodo/i;

function pgError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}
const undefinedFunction = () => pgError("42883", "function despachos.efos_consultar(text[]) does not exist");
const undefinedInnerFunction = () => pgError("42883", "function core.has_property_access(uuid) does not exist");
const undefinedTable = () => pgError("42P01", 'relation "despachos.efos_contribuyente" does not exist');

const FILA = { out_periodo: "2026-06", out_rfc: "AAA010101AA1", out_nombre: "X", out_situacion: "definitivo", out_oficio_presuncion: null, out_fecha_presuncion_sat: null, out_fecha_desvirtuado_sat: null, out_fecha_definitivo_sat: "2026-06-15", out_fecha_sentencia_favorable_sat: null };

describe("PostgresDespachosRepository.consultarEfos", () => {
  it("coincidencia: mapea la fila y la edicion vigente", async () => {
    const repo = new PostgresDespachosRepository(new AbortAwareFakeSession([{ match: CONSULTAR_RE, respond: () => [FILA] }]));
    const r = await repo.consultarEfos(["AAA010101AA1"]);
    expect(r.estado).toBe("disponible");
    expect(r.periodoLista).toBe("2026-06");
    expect(r.coincidencias[0]).toMatchObject({ rfc: "AAA010101AA1", situacion: "definitivo", fechaDefinitivoSat: "2026-06-15" });
  });

  it("sin coincidencias pero con lista vigente -> disponible y limpio; sin lista -> no_disponible", async () => {
    const conLista = new PostgresDespachosRepository(new AbortAwareFakeSession([{ match: CONSULTAR_RE, respond: () => [] }, { match: ESTADO_RE, respond: () => [{ out_periodo: "2026-06" }] }]));
    expect(await conLista.consultarEfos(["ZZZ999999ZZ9"])).toEqual({ estado: "disponible", periodoLista: "2026-06", coincidencias: [] });
    const sinLista = new PostgresDespachosRepository(new AbortAwareFakeSession([{ match: CONSULTAR_RE, respond: () => [] }, { match: ESTADO_RE, respond: () => [] }]));
    expect((await sinLista.consultarEfos(["ZZZ999999ZZ9"])).estado).toBe("no_disponible");
  });

  it("REGLA DURA (42883, base sin migrar): degrada a no_disponible y el SAVEPOINT deja la sesion utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: CONSULTAR_RE, respond: undefinedFunction }, { match: /select 1/, respond: () => [{ ok: 1 }] }]);
    const repo = new PostgresDespachosRepository(session);
    expect((await repo.consultarEfos(["AAA010101AA1"])).estado).toBe("no_disponible");
    // Prueba real: la consulta POSTERIOR (el insertInvoice del mismo request) NO falla con 25P02.
    expect(await session.query("select 1")).toEqual({ rows: [{ ok: 1 }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error NO recuperable (42501) se repropaga, no se enmascara como lista no disponible", async () => {
    const repo = new PostgresDespachosRepository(new AbortAwareFakeSession([{ match: CONSULTAR_RE, respond: () => pgError("42501", "efos_consultar: requiere staff de despachos") }]));
    await expect(repo.consultarEfos(["AAA010101AA1"])).rejects.toMatchObject({ code: "42501" });
  });

  it("un 42883 de una funcion INTERNA (no despachos.efos_*) se repropaga, no se enmascara", async () => {
    const repo = new PostgresDespachosRepository(new AbortAwareFakeSession([{ match: CONSULTAR_RE, respond: undefinedInnerFunction }]));
    await expect(repo.consultarEfos(["AAA010101AA1"])).rejects.toMatchObject({ code: "42883" });
  });

  it("lista de RFC vacia no toca la base", async () => {
    const session = new AbortAwareFakeSession([]);
    expect((await new PostgresDespachosRepository(session).consultarEfos([])).estado).toBe("no_disponible");
    expect(session.calls).toHaveLength(0);
  });
});

describe("PostgresDespachosRepository.estadoEfos / listarInvoicesEfosAfectados / ingestarListaEfos", () => {
  it("estadoEfos mapea la edicion vigente y degrada con 42P01 sin abortar la sesion", async () => {
    const ok = new PostgresDespachosRepository(new AbortAwareFakeSession([{ match: ESTADO_RE, respond: () => [{ out_periodo: "2026-06", out_filas: 12, out_ingestado_en: "2026-07-01 10:00:00+00" }] }]));
    expect(await ok.estadoEfos()).toEqual({ estado: "disponible", periodo: "2026-06", filas: 12, ingestadoEn: "2026-07-01 10:00:00+00" });
    const session = new AbortAwareFakeSession([{ match: ESTADO_RE, respond: undefinedTable }, { match: /select 1/, respond: () => [] }]);
    expect((await new PostgresDespachosRepository(session).estadoEfos()).estado).toBe("no_disponible");
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("listarInvoicesEfosAfectados mapea filas y degrada a vacio 'no_disponible' en la base vieja", async () => {
    const fila = { out_invoice_id: "i1", out_folio_fiscal: "f1", out_rfc_emisor: "AAA010101AA1", out_emisor_nombre: null, out_fecha: "2026-07-10", out_total: "116.00", out_situacion: "definitivo", out_periodo_lista: "2026-06" };
    const ok = new PostgresDespachosRepository(new AbortAwareFakeSession([{ match: AFECTADOS_RE, respond: () => [fila] }]));
    expect(await ok.listarInvoicesEfosAfectados("p1")).toEqual({ estado: "disponible", items: [{ invoiceId: "i1", folioFiscal: "f1", rfcEmisor: "AAA010101AA1", emisorNombre: null, fecha: "2026-07-10", total: 116, situacion: "definitivo", periodoLista: "2026-06" }] });
    const session = new AbortAwareFakeSession([{ match: AFECTADOS_RE, respond: undefinedFunction }, { match: /select 1/, respond: () => [] }]);
    expect(await new PostgresDespachosRepository(session).listarInvoicesEfosAfectados("p1")).toEqual({ estado: "no_disponible", items: [] });
    await expect(session.query("select 1")).resolves.toBeDefined();
  });

  it("ingestarListaEfos devuelve el resultado de la funcion y, sin migracion 014, lanza EfosUnavailableError dejando la sesion utilizable", async () => {
    const fila: EfosContribuyente = { rfc: "AAA010101AA1", nombre: "X", situacion: "presunto", oficioPresuncion: null, fechaPresuncionSat: "2026-05-30", fechaDesvirtuadoSat: null, fechaDefinitivoSat: null, fechaSentenciaFavorableSat: null };
    const ok = new PostgresDespachosRepository(new AbortAwareFakeSession([{ match: INGESTAR_RE, respond: () => [{ r: "insertada" }] }]));
    expect(await ok.ingestarListaEfos("2026-06", "a".repeat(64), [fila])).toBe("insertada");
    const session = new AbortAwareFakeSession([{ match: INGESTAR_RE, respond: undefinedFunction }, { match: /select 1/, respond: () => [] }]);
    await expect(new PostgresDespachosRepository(session).ingestarListaEfos("2026-06", "a".repeat(64), [fila])).rejects.toBeInstanceOf(EfosUnavailableError);
    await expect(session.query("select 1")).resolves.toBeDefined();
  });
});

describe("InMemoryDespachosRepository (EFOS)", () => {
  const fila = (rfc: string, situacion: EfosContribuyente["situacion"]): EfosContribuyente => ({ rfc, nombre: "N", situacion, oficioPresuncion: null, fechaPresuncionSat: null, fechaDesvirtuadoSat: null, fechaDefinitivoSat: null, fechaSentenciaFavorableSat: null });

  it("sin ingesta: no_disponible; ingesta idempotente y la edicion mas reciente manda", async () => {
    const repo = new InMemoryDespachosRepository();
    expect((await repo.consultarEfos(["AAA010101AA1"])).estado).toBe("no_disponible");
    expect(await repo.ingestarListaEfos("2026-05", "a".repeat(64), [fila("AAA010101AA1", "presunto")])).toBe("insertada");
    expect(await repo.ingestarListaEfos("2026-05", "a".repeat(64), [fila("AAA010101AA1", "presunto")])).toBe("sin_cambios");
    expect(await repo.ingestarListaEfos("2026-06", "b".repeat(64), [fila("AAA010101AA1", "definitivo")])).toBe("insertada");
    expect(await repo.ingestarListaEfos("2026-06", "c".repeat(64), [fila("AAA010101AA1", "desvirtuado")])).toBe("reemplazada");
    const r = await repo.consultarEfos([" aaa010101aa1"]);
    expect(r.periodoLista).toBe("2026-06");
    expect(r.coincidencias[0]!.situacion).toBe("desvirtuado");
    expect(await repo.estadoEfos()).toMatchObject({ estado: "disponible", periodo: "2026-06", filas: 1 });
  });

  it("rechaza lista vacia y RFC duplicados", async () => {
    const repo = new InMemoryDespachosRepository();
    await expect(repo.ingestarListaEfos("2026-06", "a".repeat(64), [])).rejects.toThrow();
    await expect(repo.ingestarListaEfos("2026-06", "a".repeat(64), [fila("AAA010101AA1", "presunto"), fila("AAA010101AA1", "definitivo")])).rejects.toThrow();
  });
});
