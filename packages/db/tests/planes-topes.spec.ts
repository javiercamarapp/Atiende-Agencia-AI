// Medidor de mensajes y avisos de prueba (PL-16): contrato del puerto TypeScript. Usa AbortAwareFakeSession (reproduce el estado
// abortado 25P02 de una transaccion real): una sesion falsa plana NO demostraria que el fallback contra la base sin migrar deja
// la transaccion del request utilizable. La logica de umbrales/zona horaria vive en SQL y se prueba contra Postgres real en
// scripts/verify-planes-topes-prueba.
import { describe, expect, it } from "vitest";
import { decidirEnvio, leerUsoOrganizacion, listarUsoSuperadmin, reclamarAvisosPrueba, registrarMensaje } from "../src/planes-topes.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-00000000a101";
const USER = "00000000-0000-0000-0000-00000000c101";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const check = /message_quota_check/;
const record = /message_usage_record/;
const usage = /message_usage_for_org/;
const list = /superadmin_list_message_usage/;
const claim = /trial_notice_claim/;
const siguiente = { match: /select 1/, respond: () => [{ ok: 1 }] };

describe("decidirEnvio", () => {
  it("devuelve la decision de la base", async () => {
    const session = new AbortAwareFakeSession([{ match: check, respond: () => [{ r: { permitir: false, motivo: "tope_mensajes_plan", usado: 1000, limite: 1000 } }] }]);
    expect(await decidirEnvio(session, { organizationId: ORG, proactivo: true })).toEqual({ disponible: true, permitir: false, motivo: "tope_mensajes_plan", usado: 1000, limite: 1000 });
  });

  it("base sin migrar: PERMITE el envio (nunca se deja a un cliente sin respuesta por un medidor ausente) y la transaccion queda usable", async () => {
    for (const code of ["42883", "42P01", "42703"]) {
      const session = new AbortAwareFakeSession([{ match: check, respond: () => pgError(code, "function core.message_quota_check(uuid, boolean, boolean, timestamp with time zone) does not exist") }, siguiente]);
      const r = await decidirEnvio(session, { organizationId: ORG, proactivo: true });
      expect(r.disponible).toBe(false);
      expect(r.permitir).toBe(true);
      await expect(session.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
      expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    }
  });

  it("otro error de Postgres NO se enmascara", async () => {
    const session = new AbortAwareFakeSession([{ match: check, respond: () => pgError("42501", "solo sesion de sistema") }, siguiente]);
    await expect(decidirEnvio(session, { organizationId: ORG, proactivo: false })).rejects.toMatchObject({ code: "42501" });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});

describe("registrarMensaje", () => {
  it("mapea el cruce de umbral y el excedente", async () => {
    const session = new AbortAwareFakeSession([{ match: record, respond: () => [{ r: { registrado: true, periodo: "2026-10-01", cruce: "excedido", usado: 1001, limite: 1000, accion: "avisar", excedente: 1, slug: "hotel-a" } }] }]);
    expect(await registrarMensaje(session, { organizationId: ORG, refTipo: "wa_outbox_citas", refId: "m1" })).toEqual({
      disponible: true, registrado: true, periodo: "2026-10-01", cruce: "excedido", usado: 1001, limite: 1000, accion: "avisar", excedente: 1, slug: "hotel-a",
    });
  });

  it("base sin migrar: no cuenta nada, no lanza y la transaccion queda usable", async () => {
    const session = new AbortAwareFakeSession([{ match: record, respond: () => pgError("42883", "function core.message_usage_record(uuid, text, text, timestamp with time zone, boolean, boolean, text) does not exist") }, siguiente]);
    const r = await registrarMensaje(session, { organizationId: ORG, refTipo: "wa_outbox_citas", refId: "m1" });
    expect(r).toMatchObject({ disponible: false, registrado: false, cruce: "ninguno" });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});

describe("lecturas", () => {
  it("leerUsoOrganizacion: NULL de la base (no miembro) -> uso null; base sin migrar -> no disponible", async () => {
    const ajeno = new AbortAwareFakeSession([{ match: usage, respond: () => [{ r: null }] }]);
    expect(await leerUsoOrganizacion(ajeno, USER, ORG)).toEqual({ disponible: true, uso: null });
    const vieja = new AbortAwareFakeSession([{ match: usage, respond: () => pgError("42883", "function core.message_usage_for_org(uuid, uuid) does not exist") }, siguiente]);
    expect(await leerUsoOrganizacion(vieja, USER, ORG)).toEqual({ disponible: false });
    await expect(vieja.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("leerUsoOrganizacion mapea el documento", async () => {
    const doc = {
      organizationId: ORG, slug: "hotel-a", vertical: "hoteles", periodo: "2026-10-01", zonaHoraria: "America/Merida",
      mensajes: { usado: 801, limite: 1000, accion: "pausar", excedente: 0, proactivosOmitidos: 2 },
      plan: { id: "pl16-test", nombre: "Plan" },
      prueba: { activa: true, terminaEn: "2026-11-10T18:00:00+00:00", diasRestantes: 7 },
    };
    const session = new AbortAwareFakeSession([{ match: usage, respond: () => [{ r: doc }] }]);
    const r = await leerUsoOrganizacion(session, USER, ORG);
    expect(r.disponible && r.uso).toMatchObject({ slug: "hotel-a", vertical: "hoteles", periodo: "2026-10-01", zonaHoraria: "America/Merida", mensajes: { usado: 801, limite: 1000, accion: "pausar", proactivosOmitidos: 2 }, plan: { id: "pl16-test" }, prueba: { activa: true, diasRestantes: 7, terminaEn: "2026-11-10T18:00:00.000Z" } });
  });

  it("listarUsoSuperadmin: base sin migrar -> no disponible", async () => {
    const session = new AbortAwareFakeSession([{ match: list, respond: () => pgError("42883", "function core.superadmin_list_message_usage(uuid, integer) does not exist") }]);
    expect(await listarUsoSuperadmin(session, USER)).toEqual({ disponible: false });
  });

  it("reclamarAvisosPrueba: base sin migrar -> sin avisos, sin error", async () => {
    const session = new AbortAwareFakeSession([{ match: claim, respond: () => pgError("42P01", "relation core.trial_notice_log does not exist") }]);
    expect(await reclamarAvisosPrueba(session)).toEqual({ disponible: false, avisos: [] });
  });
});
