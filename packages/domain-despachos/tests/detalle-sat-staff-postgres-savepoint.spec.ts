// REGLA DURA de compatibilidad con la base sin migrar para el camino del STAFF (verificacion manual en el SAT, dentro de la
// transaccion compartida del request): registrarDetalleSatInvoice usa despachos.invoice_estado_sat_detalle_registrar (027) y, si
// no existe, cae DENTRO de un SAVEPOINT a despachos.invoice_estado_sat_registrar (018). AbortAwareFakeSession reproduce el
// estado abortado 25P02 de una transaccion real.
import { describe, expect, it } from "vitest";
import { EstadoSatInvalidoError, InvoiceNoEncontradoError, PostgresDespachosRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const DETALLE = { esCancelable: "Cancelable con aceptación", estatusCancelacion: "En proceso", codigoEstatus: "S - ok", validacionEfos: "200" } as const;
const SIGUIENTE = { match: /^select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
const usable = (s: AbortAwareFakeSession) => expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe("PostgresDespachosRepository.registrarDetalleSatInvoice", () => {
  it("base sin la 027 (42883): cae a la funcion de la 018 dentro de un SAVEPOINT y la transaccion sigue utilizable (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /invoice_estado_sat_detalle_registrar/, respond: () => pgError("42883", "function despachos.invoice_estado_sat_detalle_registrar(uuid, uuid, text, text, text, text, text) does not exist") },
      { match: /invoice_estado_sat_registrar\(/, respond: () => [] },
      SIGUIENTE,
    ]);
    const r = await new PostgresDespachosRepository(session).registrarDetalleSatInvoice("p1", "i1", "vigente", DETALLE);
    expect(r).toEqual({ cancelacionEnProcesoNueva: false });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_despachos_invoice_sat_detalle"))).toBe(true);
    expect(session.calls.some((c) => /invoice_estado_sat_registrar\(/.test(c))).toBe(true);
    await usable(session);
  });

  it("base migrada (027): registra el detalle y reporta la cancelacion en proceso nueva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /invoice_estado_sat_detalle_registrar/, respond: () => [{ out_cancelacion_en_proceso_nueva: true }] },
      SIGUIENTE,
    ]);
    expect(await new PostgresDespachosRepository(session).registrarDetalleSatInvoice("p1", "i1", "vigente", DETALLE)).toEqual({ cancelacionEnProcesoNueva: true });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(false);
    await usable(session);
  });

  it("P0002 se traduce a InvoiceNoEncontradoError y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /invoice_estado_sat_detalle_registrar/, respond: () => pgError("P0002", "invoice_estado_sat_detalle_registrar: invoice no encontrado") },
      SIGUIENTE,
    ]);
    // P0002 no es "migracion pendiente": el error se propaga (traducido) sin ejecutar el camino anterior.
    await expect(new PostgresDespachosRepository(session).registrarDetalleSatInvoice("p1", "i1", "vigente", DETALLE)).rejects.toBeInstanceOf(InvoiceNoEncontradoError);
    expect(session.calls.some((c) => /invoice_estado_sat_registrar\(/.test(c))).toBe(false);
  });

  it("22023 se traduce a EstadoSatInvalidoError sin el prefijo de la funcion", async () => {
    const session = new AbortAwareFakeSession([
      { match: /invoice_estado_sat_detalle_registrar/, respond: () => pgError("22023", "invoice_estado_sat_detalle_registrar: estado invalido") },
    ]);
    const err = await new PostgresDespachosRepository(session).registrarDetalleSatInvoice("p1", "i1", "vigente", DETALLE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EstadoSatInvalidoError);
    expect((err as Error).message).not.toMatch(/^invoice_estado_sat_detalle_registrar:/);
  });

  it("sin la 027 ni la 018 (42883 en ambas): EstadoSatNoDisponibleError y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /invoice_estado_sat_detalle_registrar/, respond: () => pgError("42883", "function despachos.invoice_estado_sat_detalle_registrar does not exist") },
      { match: /invoice_estado_sat_registrar\(/, respond: () => pgError("42883", "function despachos.invoice_estado_sat_registrar does not exist") },
      SIGUIENTE,
    ]);
    await expect(new PostgresDespachosRepository(session).registrarDetalleSatInvoice("p1", "i1", "vigente", DETALLE)).rejects.toThrow();
    await usable(session);
  });
});
