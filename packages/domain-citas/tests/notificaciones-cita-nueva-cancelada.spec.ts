// Regla de notificaciones: una cita agendada por un canal (agente/agenda publica) y una cancelada por el cliente/agente emiten la
// notificacion in-app del catalogo por el productor compartido (`citas.cita.nueva` / `citas.cita.cancelada`): una por cita (clave =
// id), acotadas a la sucursal, sin PII, y SIN romper la operacion ni la transaccion del request contra la base sin migrar (SAVEPOINT).
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const CITA = "00000000-0000-4000-8000-0000000000c1";
const EMITIR = /core\.emit_notification/i;
const CREAR = /citas\.create_appointment_idempotent/i;
const CANCELAR_AGENTE = /citas\.cancel_appointment_idempotent/i;
const LEER_CITA = /from citas\.appointments where id/i;
const CANCELAR_PANEL = /citas\.cancel_appointment_from_panel/i;
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente/i, respond: () => [{ ok: 1 }] };

function fila(status: string, source = "whatsapp") {
  return {
    id: CITA, organization_id: ORG, property_id: PROP, provider_id: "p1", service_id: "s1", customer_id: "c1", starts_at: "2026-10-02T10:00:00.000Z", ends_at: "2026-10-02T10:30:00.000Z",
    status, source, notes: "Ana Perez pidio tinte", dedupe_fingerprint: null, idempotency_key: null, reminder_24h_sent_at: null, created_at: "2026-10-01T10:00:00.000Z",
    google_event_id: null, google_sync_status: "skipped", google_sync_attempts: 0, google_sync_next_retry_at: null, google_sync_error: null,
  };
}
const NUEVA = (source: "whatsapp" | "manual") => ({ organizationId: ORG, propertyId: PROP, providerId: "p1", serviceId: "s1", customerId: "c1", startsAt: "2026-10-02T10:00:00.000Z", endsAt: "2026-10-02T10:30:00.000Z", status: "pending" as const, source, notes: null });

function conRegistro(handlers: FakeSessionHandler[]) {
  const session = new AbortAwareFakeSession(handlers);
  const vistos: unknown[][] = [];
  const original = session.query.bind(session);
  session.query = (async (sql: string, params?: unknown[]) => {
    if (EMITIR.test(sql)) vistos.push(params ?? []);
    return original(sql, params);
  }) as typeof session.query;
  return { session, vistos };
}

describe("citas.cita.nueva", () => {
  it("una cita creada por un canal emite UN aviso con la sucursal, la clave de la cita y sin PII", async () => {
    const { session, vistos } = conRegistro([{ match: CREAR, respond: () => [{ create_appointment_idempotent: fila("pending") }] }, { match: EMITIR, respond: () => [{ emit_notification: 2 }] }]);
    const r = await new PostgresCitasRepository(session).createAppointmentIdempotent(NUEVA("whatsapp"), "fp", null);
    expect(r.outcome).toBe("created");
    expect(vistos).toHaveLength(1);
    expect(vistos[0]![0]).toBe(ORG);
    expect(vistos[0]![1]).toBe(PROP);
    expect(vistos[0]![2]).toBe("citas.cita.nueva");
    expect(vistos[0]![7]).toBe("/citas/{orgSlug}/agenda");
    expect(vistos[0]![10]).toBe(`citas.cita.nueva:${CITA}`);
    expect(vistos[0]![11]).toEqual(["staff"]);
    expect(JSON.stringify(vistos[0])).not.toMatch(/Ana|tinte/);
  });

  it("una cita capturada a mano (manual) no avisa", async () => {
    const { session, vistos } = conRegistro([{ match: CREAR, respond: () => [{ create_appointment_idempotent: fila("pending", "manual") }] }, { match: EMITIR, respond: () => [{ emit_notification: 1 }] }]);
    await new PostgresCitasRepository(session).createAppointmentIdempotent(NUEVA("manual"), "fp", null);
    expect(vistos).toHaveLength(0);
  });

  it("base sin migrar (42883 al emitir): la cita se crea y la MISMA sesion sigue viva (SAVEPOINT, sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: CREAR, respond: () => [{ create_appointment_idempotent: fila("pending") }] },
      { match: EMITIR, respond: () => Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" }) },
      SIGUIENTE,
    ]);
    const r = await new PostgresCitasRepository(session).createAppointmentIdempotent(NUEVA("whatsapp"), "fp", null);
    expect(r.outcome).toBe("created");
    await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});

describe("citas.cita.cancelada", () => {
  it("la cancelacion por el cliente/agente emite UN aviso con la clave de la cita", async () => {
    const { session, vistos } = conRegistro([{ match: LEER_CITA, respond: () => [fila("confirmed")] }, { match: CANCELAR_AGENTE, respond: () => [{ result: fila("cancelled") }] }, { match: EMITIR, respond: () => [{ emit_notification: 1 }] }]);
    const r = await new PostgresCitasRepository(session).cancelAppointmentIdempotent(ORG, CITA);
    expect(r.outcome).toBe("cancelled");
    expect(vistos).toHaveLength(1);
    expect(vistos[0]![2]).toBe("citas.cita.cancelada");
    expect(vistos[0]![10]).toBe(`citas.cita.cancelada:${CITA}`);
    expect(vistos[0]![1]).toBe(PROP);
  });

  it("la cancelacion hecha por el propio staff desde el panel no avisa", async () => {
    const { session, vistos } = conRegistro([{ match: CANCELAR_PANEL, respond: () => [{ result: fila("cancelled") }] }, { match: EMITIR, respond: () => [{ emit_notification: 1 }] }]);
    expect((await new PostgresCitasRepository(session).cancelAppointmentFromPanel(ORG, CITA, "u1")).outcome).toBe("cancelled");
    expect(vistos).toHaveLength(0);
  });

  it("cancelar una cita ya cancelada (reintento) no vuelve a avisar", async () => {
    // La funcion real devuelve la fila con status 'cancelled' tanto si esta llamada la cancelo como si ya lo estaba (no-op): lo que las
    // distingue es el estado previo leido antes de llamarla.
    const { session, vistos } = conRegistro([{ match: LEER_CITA, respond: () => [fila("cancelled")] }, { match: CANCELAR_AGENTE, respond: () => [{ result: fila("cancelled") }] }, { match: EMITIR, respond: () => [{ emit_notification: 1 }] }]);
    const r = await new PostgresCitasRepository(session).cancelAppointmentIdempotent(ORG, CITA);
    expect(r.outcome).toBe("cancelled");
    expect(vistos).toHaveLength(0);
  });

  it("base sin migrar (42883 al emitir): la cancelacion se devuelve y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: LEER_CITA, respond: () => [fila("confirmed")] },
      { match: CANCELAR_AGENTE, respond: () => [{ result: fila("cancelled") }] },
      { match: EMITIR, respond: () => Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" }) },
      SIGUIENTE,
    ]);
    expect((await new PostgresCitasRepository(session).cancelAppointmentIdempotent(ORG, CITA)).outcome).toBe("cancelled");
    await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});
