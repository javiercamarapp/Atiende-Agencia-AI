// C-05 -- panel Resumen: conteos de hoy/semana/pendientes/no-shows/clientes nuevos. Casos de borde de
// ZONA HORARIA con America/Merida (UTC-6, sin horario de verano): el "hoy" y la semana son los del
// negocio, nunca los del servidor/UTC.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeCitasResumen } from "../src/resumen.ts";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import type { AppointmentRecord, AppointmentStatus } from "../src/types.ts";
import { buildCitasFixture } from "./fixtures.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const TZ = "America/Merida";

function seed(fixture: ReturnType<typeof buildCitasFixture>, startsAt: string, status: AppointmentStatus = "confirmed"): AppointmentRecord {
  const apt: AppointmentRecord = {
    id: randomUUID(),
    organizationId: fixture.organizationId,
    propertyId: null,
    providerId: fixture.providerId,
    serviceId: fixture.serviceId,
    customerId: randomUUID(),
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
    status,
    source: "web",
    notes: null,
    dedupeFingerprint: null,
    idempotencyKey: null,
    reminder24hSentAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    googleEventId: null,
    googleSyncStatus: "skipped",
    googleSyncAttempts: 0,
    googleSyncNextRetryAt: null,
    googleSyncError: null,
  };
  fixture.repo.seedAppointment(apt);
  return apt;
}

describe("computeCitasResumen -- zona America/Merida", () => {
  // Miércoles 30-sep-2026 05:00Z = martes 29-sep 23:00 hora de Mérida.
  const NOW = new Date("2026-09-30T05:00:00.000Z");

  it("el 'hoy' es el día LOCAL: 22:30 de Mérida (04:30Z del día siguiente) cuenta hoy; 00:30 local (06:30Z) ya es mañana", async () => {
    const fixture = buildCitasFixture();
    seed(fixture, "2026-09-30T04:30:00.000Z"); // 22:30 del 29 local -> HOY
    seed(fixture, "2026-09-30T06:30:00.000Z"); // 00:30 del 30 local -> mañana
    seed(fixture, "2026-09-29T05:59:00.000Z"); // 23:59 del 28 local -> ayer

    const r = await computeCitasResumen(fixture.repo, fixture.organizationId, TZ, NOW);

    expect(r.today.date).toBe("2026-09-29");
    expect(r.today.total).toBe(1);
  });

  it("la semana es lunes-domingo LOCAL: 23:59 del domingo local anterior queda FUERA, 23:59 del lunes local entra", async () => {
    const fixture = buildCitasFixture();
    seed(fixture, "2026-09-28T05:59:00.000Z"); // 23:59 del domingo 27 local -> semana anterior
    seed(fixture, "2026-09-29T05:59:00.000Z"); // 23:59 del lunes 28 local -> esta semana
    seed(fixture, "2026-10-05T05:59:00.000Z"); // 23:59 del domingo 4-oct local -> esta semana
    seed(fixture, "2026-10-05T06:00:00.000Z"); // 00:00 del lunes 5-oct local -> la siguiente

    const r = await computeCitasResumen(fixture.repo, fixture.organizationId, TZ, NOW);

    expect(r.week.fromDate).toBe("2026-09-28");
    expect(r.week.toDate).toBe("2026-10-04");
    expect(r.week.total).toBe(2);
  });

  it("estando en DOMINGO local la semana sigue siendo la que empezó el lunes anterior (no la siguiente)", async () => {
    const fixture = buildCitasFixture();
    seed(fixture, "2026-09-28T15:00:00.000Z"); // lunes 28 local
    const domingoLocal = new Date("2026-10-04T20:00:00.000Z"); // domingo 4-oct 14:00 local

    const r = await computeCitasResumen(fixture.repo, fixture.organizationId, TZ, domingoLocal);

    expect(r.week.fromDate).toBe("2026-09-28");
    expect(r.week.toDate).toBe("2026-10-04");
    expect(r.week.total).toBe(1);
  });

  it("las canceladas no cuentan como agendadas, pero el desglose por estado las conserva", async () => {
    const fixture = buildCitasFixture();
    seed(fixture, "2026-09-29T16:00:00.000Z", "confirmed");
    seed(fixture, "2026-09-29T17:00:00.000Z", "cancelled");
    seed(fixture, "2026-09-29T18:00:00.000Z", "pending");

    const r = await computeCitasResumen(fixture.repo, fixture.organizationId, TZ, NOW);

    expect(r.today.total).toBe(2);
    expect(r.today.byStatus).toEqual({ pending: 1, confirmed: 1, completed: 0, cancelled: 1, no_show: 0 });
  });

  it("pendientes por confirmar: solo `pending` FUTURAS dentro de 30 días (ni pasadas, ni más lejanas, ni confirmadas)", async () => {
    const fixture = buildCitasFixture();
    seed(fixture, "2026-10-02T16:00:00.000Z", "pending"); // cuenta
    seed(fixture, "2026-10-20T16:00:00.000Z", "pending"); // cuenta (dentro de 30 días)
    seed(fixture, "2026-09-25T16:00:00.000Z", "pending"); // pasada
    seed(fixture, "2026-11-15T16:00:00.000Z", "pending"); // más allá de 30 días
    seed(fixture, "2026-10-03T16:00:00.000Z", "confirmed"); // no pendiente

    const r = await computeCitasResumen(fixture.repo, fixture.organizationId, TZ, NOW);

    expect(r.pendingToConfirm).toBe(2);
  });

  it("no-shows: solo los de los últimos 30 días", async () => {
    const fixture = buildCitasFixture();
    seed(fixture, "2026-09-20T16:00:00.000Z", "no_show"); // cuenta
    seed(fixture, "2026-09-01T16:00:00.000Z", "no_show"); // cuenta (29 días)
    seed(fixture, "2026-08-25T16:00:00.000Z", "no_show"); // fuera de la ventana
    seed(fixture, "2026-09-20T17:00:00.000Z", "completed");

    const r = await computeCitasResumen(fixture.repo, fixture.organizationId, TZ, NOW);

    expect(r.noShowsLast30Days).toBe(2);
  });

  it("clientes nuevos: solo los dados de alta en los últimos 30 días y de ESTA organización", async () => {
    const fixture = buildCitasFixture();
    const nuevo = await fixture.repo.upsertCustomer(fixture.organizationId, "9990000001", "Cliente Nuevo", null);
    const viejo = await fixture.repo.upsertCustomer(fixture.organizationId, "9990000002", "Cliente Viejo", null);
    fixture.repo.customerCreatedAt.set(nuevo.id, "2026-09-20T00:00:00.000Z");
    fixture.repo.customerCreatedAt.set(viejo.id, "2026-07-01T00:00:00.000Z");
    const otraOrg = randomUUID();
    fixture.repo.seedOrganization({ id: otraOrg, slug: "otra", name: "Otra" });
    const ajeno = await fixture.repo.upsertCustomer(otraOrg, "9990000003", "Ajeno", null);
    fixture.repo.customerCreatedAt.set(ajeno.id, "2026-09-25T00:00:00.000Z");

    const r = await computeCitasResumen(fixture.repo, fixture.organizationId, TZ, NOW);

    expect(r.newCustomersLast30Days).toBe(1);
  });

  it("aislamiento: las citas de otra organización nunca cuentan", async () => {
    const fixture = buildCitasFixture();
    const otra = buildCitasFixture(fixture.repo);
    seed(otra, "2026-09-29T16:00:00.000Z");

    const r = await computeCitasResumen(fixture.repo, fixture.organizationId, TZ, NOW);

    expect(r.today.total).toBe(0);
    expect(r.week.total).toBe(0);
  });

  it("un negocio sin ninguna cita responde ceros, nunca error", async () => {
    const fixture = buildCitasFixture();
    const r = await computeCitasResumen(fixture.repo, fixture.organizationId, TZ, NOW);
    expect(r.today.total).toBe(0);
    expect(r.pendingToConfirm).toBe(0);
    expect(r.noShowsLast30Days).toBe(0);
    expect(r.newCustomersLast30Days).toBe(0);
  });
});

describe("PostgresCitasRepository -- conteos del Resumen (AbortAwareFakeSession)", () => {
  it("countAppointmentsByStatus rellena con 0 los estados ausentes e ignora estados desconocidos", async () => {
    const session = new AbortAwareFakeSession([{ match: /from citas\.appointments/, respond: () => [{ status: "pending", count: "3" }, { status: "no_show", count: "1" }, { status: "raro", count: "9" }] }]);
    const result = await new PostgresCitasRepository(session).countAppointmentsByStatus("org", "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z");
    expect(result).toEqual({ pending: 3, confirmed: 0, completed: 0, cancelled: 0, no_show: 1 });
  });

  it("un error real de Postgres NO se traga: se propaga para que el handler responda 5xx (la transacción es del request, no hay fallback que ocultar)", async () => {
    const err = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const session = new AbortAwareFakeSession([{ match: /from citas\.appointments/, respond: () => err }]);
    await expect(new PostgresCitasRepository(session).countAppointmentsByStatus("org", "a", "b")).rejects.toMatchObject({ code: "57014" });
  });

  it("countAppointmentsCreatedBySource rellena con 0 los canales ausentes, ignora canales desconocidos y excluye canceladas en el SQL", async () => {
    const session = new AbortAwareFakeSession([{ match: /from citas\.appointments/, respond: () => [{ source: "whatsapp", count: "4" }, { source: "voice", count: "2" }, { source: "fax", count: "9" }] }]);
    const result = await new PostgresCitasRepository(session).countAppointmentsCreatedBySource("org", "2026-09-02T00:00:00Z");
    expect(result).toEqual({ voice: 2, whatsapp: 4, web: 0, manual: 0 });
    expect(session.calls[0]).toMatch(/created_at >= \$2 and status <> 'cancelled'/);
  });

  it("countAppointmentsCreatedBySource propaga un error real de Postgres", async () => {
    const err = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const session = new AbortAwareFakeSession([{ match: /from citas\.appointments/, respond: () => err }]);
    await expect(new PostgresCitasRepository(session).countAppointmentsCreatedBySource("org", "a")).rejects.toMatchObject({ code: "57014" });
  });
});

describe("computeCitasResumen -- citas creadas por canal (UNI-RES-citas)", () => {
  const NOW = new Date("2026-09-30T05:00:00.000Z");

  it("cuenta por canal las citas NO canceladas creadas en 30 días; excluye canceladas, fuera de ventana y otras organizaciones", async () => {
    const fixture = buildCitasFixture();
    const crea = (source: AppointmentRecord["source"], createdAt: string, status: AppointmentStatus = "confirmed", organizationId = fixture.organizationId) => {
      const base = seed(fixture, "2026-10-02T15:00:00.000Z", status);
      fixture.repo.seedAppointment({ ...base, source, createdAt, organizationId }); // mismo id: reemplaza la fila que sembró `seed`
    };
    crea("whatsapp", "2026-09-20T10:00:00.000Z");
    crea("whatsapp", "2026-09-25T10:00:00.000Z", "pending");
    crea("whatsapp", "2026-09-25T10:00:00.000Z", "cancelled"); // cancelada: no cuenta
    crea("whatsapp", "2026-08-01T10:00:00.000Z"); // fuera de los 30 días
    crea("voice", "2026-09-28T10:00:00.000Z");
    crea("whatsapp", "2026-09-28T10:00:00.000Z", "confirmed", randomUUID()); // otra organización

    const r = await computeCitasResumen(fixture.repo, fixture.organizationId, TZ, NOW);

    expect(r.createdBySourceLast30Days).toEqual({ voice: 1, whatsapp: 2, web: 0, manual: 0 });
  });
});
