// Los fallbacks NUEVOS de este lote corren dentro de la ÚNICA transacción del request (webhook de WhatsApp / despachador del outbox): un error real de
// Postgres dentro de ellos NO puede dejarla abortada (25P02). Se reproduce el estado abortado con `AbortAwareFakeSession` (una sesión falsa plana no sirve).
import { describe, expect, it } from "vitest";
import { citaSigueActiva, filtrarRecordatoriosDeCitasInactivas } from "../src/cita-activa.ts";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { consumirTurnoDeRemitente } from "../src/whatsapp/inbound.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000f1";
const CITA = "00000000-0000-0000-0000-0000000000f2";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("tope por remitente (consume_api_rate_limit) con la sesion abortada", () => {
  it.each([
    ["42883", "function citas.consume_api_rate_limit does not exist"],
    ["40P01", "deadlock detected"],
    ["57014", "canceling statement due to statement timeout"],
  ])("un error %s deja pasar al paciente (fail-open) y la sesion sigue utilizable", async (code, message) => {
    const session = new AbortAwareFakeSession([
      { match: /consume_api_rate_limit/, respond: () => pgError(code, message) },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);
    await expect(consumirTurnoDeRemitente(repo, ORG, "hash")).resolves.toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("sin error, respeta el veredicto de la base (false = tope excedido)", async () => {
    const session = new AbortAwareFakeSession([{ match: /consume_api_rate_limit/, respond: () => [{ consume_api_rate_limit: false }] }]);
    await expect(consumirTurnoDeRemitente(new PostgresCitasRepository(session), ORG, "hash")).resolves.toBe(false);
  });
});

describe("revalidacion de la cita de un recordatorio con la sesion abortada", () => {
  const lecturaFalla = (code: string) => [
    { match: /from citas\.appointments/, respond: () => pgError(code, "falla simulada") },
    { match: /select 1/, respond: () => [] },
  ];

  it("si la lectura de la cita falla, el recordatorio sigue su curso (true) y la sesion queda sana", async () => {
    const session = new AbortAwareFakeSession(lecturaFalla("40P01"));
    await expect(citaSigueActiva(new PostgresCitasRepository(session), ORG, CITA)).resolves.toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("el filtro del lote no pierde los demas mensajes cuando la lectura de una cita falla", async () => {
    const session = new AbortAwareFakeSession(lecturaFalla("57014"));
    const repo = new PostgresCitasRepository(session);
    const botones = [{ id: `cita:confirmar:${CITA}`, title: "Confirmar" }];
    const items = [
      { id: "m1", attempts: 0, organizationId: ORG, payload: { to: "+521", body: "r", buttons: botones } },
      { id: "m2", attempts: 0, organizationId: ORG, payload: { to: "+522", body: "otro" } },
    ];
    const { entregables, descartados } = await filtrarRecordatoriosDeCitasInactivas(repo, items);
    expect(entregables.map((i) => i.id)).toEqual(["m1", "m2"]);
    expect(descartados).toEqual([]);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});
