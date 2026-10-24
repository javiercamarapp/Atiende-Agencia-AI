// C-01 -- botones Confirmar/Cancelar/Reagendar del recordatorio 24h: antes el webhook
// solo procesaba `text.body` y el toque se descartaba. Se ejercita de punta a punta
// por `handleInboundWhatsAppMessage` (dedupe -> lock -> botón -> outbox) sobre el
// repositorio en memoria, más la compatibilidad con la base sin migrar contra
// `PostgresCitasRepository` + `AbortAwareFakeSession` (reproduce el estado abortado
// 25P02; una sesión falsa plana NO sirve).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { runConfirmacionCitaCore } from "../src/reminders.ts";
import { appointmentReminderButtons, buildAppointmentButtonId, parseAppointmentButtonId } from "../src/whatsapp/appointment-button-ids.ts";
import { formatAppointmentWhen } from "../src/whatsapp/appointment-buttons.ts";
import { createDefaultConversationGuard, handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { buildCitasFixture, nextWeekdayDateStr } from "./fixtures.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

// El guard "ese horario ya paso" usa el reloj real: las fechas fijas de este archivo (septiembre de 2026 / 2027) se evaluan con un reloj fijo anterior a ellas.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const PHONE_WA = "+5219981234567"; // remitente de Meta (con +52 1)
const PHONE_STORED = "9981234567"; // `normalizePhone`: últimos 10 dígitos

function llmSpy() {
  const spy = vi.fn(async (_args: Parameters<WhatsAppTurnHandler["handleInboundMessage"]>[0]) => ({ reply: "respuesta del agente LLM", appointmentId: null, propertyId: null }));
  return { handler: { handleInboundMessage: spy } as WhatsAppTurnHandler, spy };
}

async function bookPendingAppointment(fixture: ReturnType<typeof buildCitasFixture>) {
  // Próximo martes 10:00 hora de Mérida: siempre en el futuro real y dentro del horario L-V 9-17.
  const startsAt = zonedTimeToUtc(nextWeekdayDateStr(new Date(), 2), "10:00", "America/Merida").toISOString();
  return createAppointment(fixture.repo, {
    organizationId: fixture.organizationId,
    providerId: fixture.providerId,
    serviceId: fixture.serviceId,
    customerName: "María López",
    customerPhone: PHONE_STORED,
    startsAt,
    source: "web",
  });
}

async function tap(
  fixture: ReturnType<typeof buildCitasFixture>,
  handler: WhatsAppTurnHandler,
  messageId: string,
  buttonId: string,
  title: string,
  phone = PHONE_WA,
  organizationId = fixture.organizationId,
) {
  return handleInboundWhatsAppMessage(fixture.repo, handler, createDefaultConversationGuard({}), {
    organizationId,
    messageId,
    phone,
    body: title,
    phoneNumberId: "1234567890",
    interactive: { kind: "button_reply", id: buttonId, title },
  });
}

describe("ids de botón del recordatorio", () => {
  it("round-trip: cada botón embebe la cita y el parseo es estricto", () => {
    const id = randomUUID();
    const buttons = appointmentReminderButtons(id);
    expect(buttons.map((b) => b.title)).toEqual(["Confirmar", "Cancelar", "Reagendar"]);
    expect(buttons.every((b) => b.title.length <= 20 && b.id.length <= 256)).toBe(true);
    expect(parseAppointmentButtonId(buildAppointmentButtonId("cancelar", id))).toEqual({ action: "cancelar", appointmentId: id });
    // formatos que NO emite este módulo -> null (caen al camino de texto)
    for (const bad of ["btn_0", "cita:confirmar:no-es-uuid", `cita:borrar:${id}`, `xcita:confirmar:${id}`, `cita:confirmar:${id}:extra`, ""]) {
      expect(parseAppointmentButtonId(bad)).toBeNull();
    }
  });

  it("el recordatorio 24h encola los botones con el id de ESA cita", async () => {
    const fixture = buildCitasFixture();
    const now = new Date("2026-09-13T16:00:00.000Z");
    const apt = await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "María",
      customerPhone: PHONE_STORED,
      startsAt: zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString(),
      source: "web",
    });
    await runConfirmacionCitaCore(fixture.repo, fixture.organizationId, now);
    const payload = fixture.repo.getOutbox()[0]!.payload as { buttons: { id: string; title: string }[] };
    expect(payload.buttons).toEqual(appointmentReminderButtons(apt.id));
  });
});

describe("formatAppointmentWhen -- zona horaria America/Merida", () => {
  it("una cita a las 22:30 de Mérida (04:30 UTC del día siguiente) se muestra con el día y la hora LOCALES", () => {
    const text = formatAppointmentWhen("2026-10-01T04:30:00.000Z", "America/Merida");
    expect(text).toContain("30 de septiembre");
    expect(text).toMatch(/10:30/);
    expect(text).not.toMatch(/4:30/);
    expect(text).not.toContain("1 de octubre");
  });

  it("la misma cita en otra zona (UTC) cambia de día: confirma que la zona del negocio es la que manda", () => {
    expect(formatAppointmentWhen("2026-10-01T04:30:00.000Z", "UTC")).toContain("1 de octubre");
  });
});

describe("botón Confirmar", () => {
  it("confirma la cita pending, responde determinista (sin LLM) y encola la respuesta con la hora de Mérida", async () => {
    const fixture = buildCitasFixture();
    const apt = await bookPendingAppointment(fixture);
    const { handler, spy } = llmSpy();

    const outcome = await tap(fixture, handler, "wamid.c1", buildAppointmentButtonId("confirmar", apt.id), "Confirmar");

    expect(outcome.ok).toBe(true);
    expect(outcome.reply).toContain("quedó confirmada");
    expect(outcome.reply).toMatch(/10:00/);
    expect(spy).not.toHaveBeenCalled();
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id))?.status).toBe("confirmed");
    const reply = fixture.repo.getOutbox().find((m) => m.eventType === "whatsapp.inbound_reply")!;
    expect((reply.payload as { body: string }).body).toContain("confirmada");
  });

  it("anti-replay: volver a tocar el botón (mensaje nuevo) responde 'ya estaba confirmada' sin repetir el efecto", async () => {
    const fixture = buildCitasFixture();
    const apt = await bookPendingAppointment(fixture);
    const { handler } = llmSpy();
    const id = buildAppointmentButtonId("confirmar", apt.id);

    await tap(fixture, handler, "wamid.r1", id, "Confirmar");
    const second = await tap(fixture, handler, "wamid.r2", id, "Confirmar");

    expect(second.reply).toContain("ya estaba confirmada");
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id))?.status).toBe("confirmed");
  });

  it("reintento del webhook (MISMO id de mensaje): se acusa sin reprocesar ni duplicar la respuesta", async () => {
    const fixture = buildCitasFixture();
    const apt = await bookPendingAppointment(fixture);
    const { handler, spy } = llmSpy();
    const id = buildAppointmentButtonId("confirmar", apt.id);

    await tap(fixture, handler, "wamid.dup", id, "Confirmar");
    const retry = await tap(fixture, handler, "wamid.dup", id, "Confirmar");

    expect(retry).toEqual({ ok: true, retryable: false });
    expect(fixture.repo.getOutbox().filter((m) => m.eventType === "whatsapp.inbound_reply")).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("base sin la migración 025: respuesta honesta, la cita NO se marca confirmada, nunca lanza", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.customerConfirmMigrationPending = true;
    const apt = await bookPendingAppointment(fixture);
    const { handler } = llmSpy();

    const outcome = await tap(fixture, handler, "wamid.nm", buildAppointmentButtonId("confirmar", apt.id), "Confirmar");

    expect(outcome.ok).toBe(true);
    expect(outcome.reply).toContain("no pude registrar la confirmación");
    expect(outcome.reply).not.toContain("quedó confirmada");
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id))?.status).toBe("pending");
  });
});

describe("botón Cancelar", () => {
  it("cancela la cita sin pasar por el fast-path ARCO ni el LLM y es idempotente al re-tocar", async () => {
    const fixture = buildCitasFixture();
    const apt = await bookPendingAppointment(fixture);
    const { handler, spy } = llmSpy();
    const id = buildAppointmentButtonId("cancelar", apt.id);

    const first = await tap(fixture, handler, "wamid.x1", id, "Cancelar");
    expect(first.reply).toContain("quedó cancelada");
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id))?.status).toBe("cancelled");
    expect(fixture.repo.dataRightsRequests).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();

    const second = await tap(fixture, handler, "wamid.x2", id, "Cancelar");
    expect(second.reply).toContain("ya estaba cancelada");
  });

  it("tocar Confirmar sobre una cita ya cancelada no la resucita", async () => {
    const fixture = buildCitasFixture();
    const apt = await bookPendingAppointment(fixture);
    const { handler } = llmSpy();
    await tap(fixture, handler, "wamid.k1", buildAppointmentButtonId("cancelar", apt.id), "Cancelar");

    const stale = await tap(fixture, handler, "wamid.k2", buildAppointmentButtonId("confirmar", apt.id), "Confirmar");

    expect(stale.reply).toContain("ya estaba cancelada");
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id))?.status).toBe("cancelled");
  });
});

describe("botón Reagendar", () => {
  it("pasa al agente con un texto que nombra la cita (no el título crudo del botón)", async () => {
    const fixture = buildCitasFixture();
    const apt = await bookPendingAppointment(fixture);
    const { handler, spy } = llmSpy();

    const outcome = await tap(fixture, handler, "wamid.g1", buildAppointmentButtonId("reagendar", apt.id), "Reagendar");

    expect(outcome.reply).toBe("respuesta del agente LLM");
    expect(spy).toHaveBeenCalledTimes(1);
    const messages = spy.mock.calls[0]![0].messages;
    expect(messages[messages.length - 1]).toMatchObject({ role: "user" });
    expect(messages[messages.length - 1]!.content).toMatch(/^Quiero reagendar mi cita del .*10:00/);
    // la cita sigue intacta: reagendar la decide el agente con herramientas, no el toque
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id))?.status).toBe("pending");
  });
});

describe("titularidad, aislamiento y estados", () => {
  it("otro teléfono tocando el botón de una cita ajena: respuesta genérica, sin cambios", async () => {
    const fixture = buildCitasFixture();
    const apt = await bookPendingAppointment(fixture);
    const { handler, spy } = llmSpy();

    const outcome = await tap(fixture, handler, "wamid.o1", buildAppointmentButtonId("cancelar", apt.id), "Cancelar", "+5219987654321");

    expect(outcome.reply).toContain("No encontré esa cita");
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id))?.status).toBe("pending");
    expect(spy).not.toHaveBeenCalled();
  });

  it("cross-tenant: el id de una cita de la organización A tocado en la organización B responde lo mismo y no cambia nada", async () => {
    const fixture = buildCitasFixture();
    const apt = await bookPendingAppointment(fixture);
    const otherOrg = randomUUID();
    fixture.repo.seedOrganization({ id: otherOrg, slug: "otra-clinica", name: "Otra Clínica" });
    const { handler } = llmSpy();

    const outcome = await tap(fixture, handler, "wamid.t1", buildAppointmentButtonId("cancelar", apt.id), "Cancelar", PHONE_WA, otherOrg);

    expect(outcome.reply).toContain("No encontré esa cita");
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id))?.status).toBe("pending");
  });

  it("un id de cita inexistente responde igual que una cita ajena", async () => {
    const fixture = buildCitasFixture();
    await bookPendingAppointment(fixture);
    const { handler } = llmSpy();
    const outcome = await tap(fixture, handler, "wamid.n1", buildAppointmentButtonId("confirmar", randomUUID()), "Confirmar");
    expect(outcome.reply).toContain("No encontré esa cita");
  });

  it("una cita cuyo horario ya pasó no se confirma ni se cancela por un botón viejo", async () => {
    const fixture = buildCitasFixture();
    const apt = await bookPendingAppointment(fixture);
    fixture.repo.seedAppointment({ ...apt, startsAt: "2020-01-07T16:00:00.000Z", endsAt: "2020-01-07T16:30:00.000Z" });
    const { handler } = llmSpy();

    for (const [i, action] of (["confirmar", "cancelar"] as const).entries()) {
      const outcome = await tap(fixture, handler, `wamid.p${i}`, buildAppointmentButtonId(action, apt.id), action);
      expect(outcome.reply).toContain("ya pasó");
    }
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id))?.status).toBe("pending");
  });
});

describe("compatibilidad con mensajes anteriores al cambio", () => {
  it("un botón con id posicional (btn_0, recordatorio ya enviado antes del deploy) sigue como texto normal: el título llega al agente", async () => {
    const fixture = buildCitasFixture();
    await bookPendingAppointment(fixture);
    const { handler, spy } = llmSpy();

    const outcome = await tap(fixture, handler, "wamid.l1", "btn_0", "Confirmar");

    expect(outcome.reply).toBe("respuesta del agente LLM");
    const messages = spy.mock.calls[0]![0].messages;
    expect(messages[messages.length - 1]!.content).toBe("Confirmar");
  });

  it("un mensaje de texto normal no cambia de comportamiento", async () => {
    const fixture = buildCitasFixture();
    const { handler, spy } = llmSpy();
    const outcome = await handleInboundWhatsAppMessage(fixture.repo, handler, createDefaultConversationGuard({}), {
      organizationId: fixture.organizationId,
      messageId: "wamid.txt",
      phone: PHONE_WA,
      body: "Hola",
      phoneNumberId: "1234567890",
    });
    expect(outcome.reply).toBe("respuesta del agente LLM");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// PostgresCitasRepository.confirmAppointmentByCustomerAsSystem contra una sesión que
// reproduce el estado ABORTADO de Postgres (25P02): la base sin migrar NO debe dejar
// la transacción compartida del turno inutilizable.
// ---------------------------------------------------------------------------
const ORG = "00000000-0000-0000-0000-0000000000d1";
const APT = "00000000-0000-0000-0000-0000000000d2";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function appointmentRow(status: string) {
  return {
    id: APT,
    organization_id: ORG,
    property_id: null,
    provider_id: "00000000-0000-0000-0000-0000000000d3",
    service_id: "00000000-0000-0000-0000-0000000000d4",
    customer_id: "00000000-0000-0000-0000-0000000000d5",
    starts_at: "2030-01-01T16:00:00.000Z",
    ends_at: "2030-01-01T16:30:00.000Z",
    status,
    source: "web",
    notes: null,
    dedupe_fingerprint: null,
    idempotency_key: null,
    reminder_24h_sent_at: null,
    created_at: "2029-12-01T00:00:00.000Z",
    google_event_id: null,
    google_sync_status: "skipped",
    google_sync_attempts: 0,
    google_sync_next_retry_at: null,
    google_sync_error: null,
  };
}

describe("PostgresCitasRepository.confirmAppointmentByCustomerAsSystem (AbortAwareFakeSession)", () => {
  const RPC = /citas\.system_confirm_appointment_by_customer/;

  it("camino feliz: devuelve la cita confirmada", async () => {
    const session = new AbortAwareFakeSession([{ match: RPC, respond: () => [{ result: appointmentRow("confirmed") }] }]);
    const result = await new PostgresCitasRepository(session).confirmAppointmentByCustomerAsSystem(ORG, APT, PHONE_STORED);
    expect(result.outcome).toBe("confirmed");
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(false);
  });

  it("REGLA DURA: función inexistente (42883, migración 025 pendiente) -> `unavailable` y la sesión compartida sigue utilizable (nunca 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: RPC, respond: () => pgError("42883", "function citas.system_confirm_appointment_by_customer(uuid, uuid, text) does not exist") },
      { match: /select 1/, respond: () => [] },
    ]);
    const result = await new PostgresCitasRepository(session).confirmAppointmentByCustomerAsSystem(ORG, APT, PHONE_STORED);
    expect(result).toEqual({ outcome: "unavailable" });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("errores de negocio AT404/AT409 de la función SQL se mapean a resultados y dejan la sesión utilizable", async () => {
    for (const [code, expected] of [
      ["AT404", { outcome: "not_found" }],
      ["AT409", { outcome: "conflict_invalid_status", status: "no_confirmable" }],
    ] as const) {
      const session = new AbortAwareFakeSession([
        { match: RPC, respond: () => pgError(code, "negocio") },
        { match: /select 1/, respond: () => [] },
      ]);
      const result = await new PostgresCitasRepository(session).confirmAppointmentByCustomerAsSystem(ORG, APT, PHONE_STORED);
      expect(result).toEqual(expected);
      await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    }
  });

  it("un error de Postgres INESPERADO nunca se enmascara como 'unavailable': se repropaga (sesión ya recuperada)", async () => {
    const session = new AbortAwareFakeSession([
      { match: RPC, respond: () => pgError("57014", "canceling statement due to statement timeout") },
      { match: /select 1/, respond: () => [] },
    ]);
    await expect(new PostgresCitasRepository(session).confirmAppointmentByCustomerAsSystem(ORG, APT, PHONE_STORED)).rejects.toMatchObject({ code: "57014" });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});
