// emitirNotificacion: contrato del productor compartido. Usa AbortAwareFakeSession (reproduce el estado
// abortado 25P02 de una transaccion real) -- una sesion falsa plana NO demostraria que el fallback contra
// la base sin migrar deja la transaccion del request utilizable.
import { describe, expect, it } from "vitest";
import { emitirNotificacion } from "../src/notificaciones/productor.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-00000000a001";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const emit = /select core\.emit_notification/;

describe("emitirNotificacion", () => {
  it("emite con los datos del catalogo (no del llamador) y dentro de un SAVEPOINT", async () => {
    let params: unknown[] = [];
    const session = new AbortAwareFakeSession([{ match: emit, respond: () => [{ emit_notification: 3 }] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      if (emit.test(sql)) params = p ?? [];
      return original(sql, p);
    }) as typeof session.query;

    const r = await emitirNotificacion(session, { evento: "hoteles.ticket.sla_vencido", organizationId: ORG, propertyId: null, clave: "prop-1:2026-10-01", parametros: { cantidad: 2 } });

    expect(r).toEqual({ estado: "emitida", destinatarios: 3 });
    expect(params[2]).toBe("hoteles.ticket.sla_vencido");
    expect(params[4]).toBe("atencion");
    expect(params[5]).toBe("Tickets de huéspedes con SLA vencido");
    expect(params[6]).toBe("Escalados: 2.");
    expect(params[7]).toBe("/hoteles/{orgSlug}/tickets");
    expect(params[10]).toBe("hoteles.ticket.sla_vencido:prop-1:2026-10-01");
    expect(params[11]).toEqual(["gm", "frontdesk"]);
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("release savepoint sp_fallback_"))).toBe(true);
  });

  it("0 filas = sin_nuevas (dedupe, sin destinatarios o tope), no es un error", async () => {
    const session = new AbortAwareFakeSession([{ match: emit, respond: () => [{ emit_notification: 0 }] }]);
    expect(await emitirNotificacion(session, { evento: "hoteles.aprobacion.expirada", organizationId: ORG, clave: "x", parametros: { cantidad: 1 } })).toEqual({ estado: "sin_nuevas", destinatarios: 0 });
  });

  it("base sin migrar: no_disponible y la transaccion queda utilizable (sin 25P02 en la consulta siguiente)", async () => {
    const session = new AbortAwareFakeSession([
      { match: emit, respond: () => pgError("42883", "function core.emit_notification(uuid, uuid, text) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const r = await emitirNotificacion(session, { evento: "hoteles.aprobacion.expirada", organizationId: ORG, clave: "x", parametros: { cantidad: 1 } });
    expect(r.estado).toBe("no_disponible");
    // Si el helper hubiera dejado la transaccion abortada, esta consulta de negocio fallaria con 25P02.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("tabla o columna inexistente (42P01/42703) tambien degrada a no_disponible", async () => {
    for (const code of ["42P01", "42703"]) {
      const session = new AbortAwareFakeSession([{ match: emit, respond: () => pgError(code, "boom") }]);
      expect((await emitirNotificacion(session, { evento: "hoteles.aprobacion.expirada", organizationId: ORG, clave: "x", parametros: { cantidad: 1 } })).estado).toBe("no_disponible");
    }
  });

  it("otro error de Postgres NO se enmascara como no_disponible: estado error con el SQLSTATE y la sesion sigue usable", async () => {
    const session = new AbortAwareFakeSession([
      { match: emit, respond: () => pgError("42501", "el usuario no pertenece a la organizacion") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const r = await emitirNotificacion(session, { evento: "hoteles.aprobacion.expirada", organizationId: ORG, clave: "x", parametros: { cantidad: 1 } });
    expect(r.estado).toBe("error");
    expect(r.detalle).toContain("42501");
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("rechaza antes de tocar la base: evento fuera de catalogo, clave invalida, ambito/organizacion incoherentes", async () => {
    const session = new AbortAwareFakeSession([]);
    expect((await emitirNotificacion(session, { evento: "no.existe", organizationId: ORG, clave: "x" })).estado).toBe("invalida");
    expect((await emitirNotificacion(session, { evento: "hoteles.aprobacion.expirada", organizationId: ORG, clave: "tiene espacios", parametros: { cantidad: 1 } })).estado).toBe("invalida");
    expect((await emitirNotificacion(session, { evento: "hoteles.aprobacion.expirada", organizationId: null, clave: "x", parametros: { cantidad: 1 } })).estado).toBe("invalida");
    expect((await emitirNotificacion(session, { evento: "superadmin.cfo.alerta", organizationId: ORG, clave: "x", parametros: { regla: "margen_bajo", cantidad: 1 } })).estado).toBe("invalida");
    expect(session.calls).toEqual([]);
  });

  it("sin PII: un parametro con espacios, correo o texto libre se rechaza antes de la base", async () => {
    const session = new AbortAwareFakeSession([]);
    for (const regla of ["Juan Perez", "juan@example.com sa", "x".repeat(41), "<script>"]) {
      const r = await emitirNotificacion(session, { evento: "superadmin.cfo.alerta", organizationId: null, clave: "x", parametros: { regla, cantidad: 1 } });
      expect(r.estado, regla).toBe("invalida");
    }
    expect(session.calls).toEqual([]);
  });

  it("falta un parametro de la plantilla: invalida (no emite un texto con la llave sin resolver)", async () => {
    const session = new AbortAwareFakeSession([]);
    const r = await emitirNotificacion(session, { evento: "hoteles.aprobacion.expirada", organizationId: ORG, clave: "x" });
    expect(r.estado).toBe("invalida");
  });
});
