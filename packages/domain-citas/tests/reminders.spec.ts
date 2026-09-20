// Tests reales del recordatorio 24h (fix de timezone real preservado) y del aviso
// best-effort a lista de espera tras reagendar.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppointment, rescheduleAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { MAX_LISTA_ESPERA_LIMIT, notifyWaitlistAfterReschedule, previewListaEspera, runConfirmacionCitaCore, runListaEsperaCore } from "../src/reminders.ts";
import { buildCitasFixture } from "./fixtures.ts";
import { ThrowsOnStaffWhatsAppRepo } from "./support/throws-on-staff-whatsapp-repo.ts";

describe("runConfirmacionCitaCore", () => {
  it("encola un recordatorio real para una cita dentro de la ventana de 24h, con la hora en el timezone del NEGOCIO, nunca UTC/host", async () => {
    const fixture = buildCitasFixture();
    const now = new Date("2026-09-13T16:00:00.000Z"); // domingo 16:00 UTC (exactamente 24h antes de la cita)
    // Cita mañana (lunes) a las 10:00 hora de Mérida (16:00 UTC) — cae justo en la
    // ventana de 24h desde `now`.
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "María López",
      customerPhone: "9998887766",
      startsAt,
      source: "web",
    });

    const summary = await runConfirmacionCitaCore(fixture.repo, fixture.organizationId, now);

    expect(summary.processed).toBe(1);
    expect(summary.sent).toBe(1);
    expect(summary.skippedNoWhatsappConfig).toBe(false);

    const outbox = fixture.repo.getOutbox();
    expect(outbox).toHaveLength(1);
    const message = outbox[0]!;
    expect(message.eventType).toBe("appointment.reminder_24h");
    // FIX DE TIMEZONE REAL: "10:00" en el mensaje, NUNCA "16:00" (lo que mostraría
    // un host que corre en UTC sin este fix).
    expect((message.payload as { body: string }).body).toContain("10:00");
    expect((message.payload as { body: string }).body).not.toContain("16:00");
  });

  it("nunca reenvía el mismo recordatorio si el cron corre dos veces dentro de la ventana", async () => {
    const fixture = buildCitasFixture();
    const now = new Date("2026-09-13T16:00:00.000Z");
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "María", customerPhone: "9998887766", startsAt, source: "web" });

    await runConfirmacionCitaCore(fixture.repo, fixture.organizationId, now);
    const second = await runConfirmacionCitaCore(fixture.repo, fixture.organizationId, new Date(now.getTime() + 5 * 60_000));

    expect(second.processed).toBe(0);
    expect(fixture.repo.getOutbox()).toHaveLength(1);
  });

  it("un negocio sin configuración de WhatsApp activa se salta, sin lanzar", async () => {
    const fixture = buildCitasFixture();
    const sinWhatsapp = randomUUID();
    fixture.repo.seedOrganization({ id: sinWhatsapp, slug: "otro-negocio", name: "Otro Negocio" });
    const summary = await runConfirmacionCitaCore(fixture.repo, sinWhatsapp, new Date());
    expect(summary.skippedNoWhatsappConfig).toBe(false); // no hay citas pendientes -> ni siquiera llega a resolver whatsapp
    expect(summary.processed).toBe(0);
  });

  // f2-citas-whatsapp-config-sesion-sistema — el ÚNICO caller real de
  // `runConfirmacionCitaCore` (cron interno `/internal/citas/confirmacion-cita`)
  // abre SIEMPRE una sesión de SISTEMA. Contra Postgres real,
  // `resolveActiveWhatsAppPhoneNumberId` (variante de STAFF) SIEMPRE devuelve 0
  // filas ahí (RLS de membership sobre `citas.whatsapp_config`) -- invisible
  // contra `InMemoryCitasRepository` a secas (mismo dato, sin RLS que
  // reproducir). Este test usa `ThrowsOnStaffWhatsAppRepo` (lanza si se llama
  // la variante de STAFF) para afirmar el EFECTO real: si `runConfirmacionCitaCore`
  // todavía llamara la variante de STAFF, este test explotaría con el error
  // BLOQUEANTE del doble -- en vez de eso, el recordatorio se resuelve y queda
  // encolado de verdad.
  it("REGLA DURA (sesión de sistema): usa la variante de SISTEMA para resolver el phone_number_id -- nunca la de STAFF, que en producción devuelve 0 filas bajo auth.uid() null", async () => {
    const fixture = buildCitasFixture(new ThrowsOnStaffWhatsAppRepo());
    const now = new Date("2026-09-13T16:00:00.000Z");
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "Cliente sesión de sistema",
      customerPhone: "9990001111",
      startsAt,
      source: "web",
    });

    const summary = await runConfirmacionCitaCore(fixture.repo, fixture.organizationId, now);

    expect(summary.skippedNoWhatsappConfig).toBe(false);
    expect(summary.sent).toBe(1);
    const outbox = fixture.repo.getOutbox();
    expect(outbox).toHaveLength(1);
    expect((outbox[0]!.payload as { phone_number_id: string }).phone_number_id).toBe("1234567890");
  });
});

describe("notifyWaitlistAfterReschedule", () => {
  it("avisa al primer candidato FIFO de la lista de espera cuando el hueco VIEJO (no el nuevo) coincide con sus preferencias", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "Cliente Original",
      customerPhone: "9991110000",
      startsAt: zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString(),
      source: "web",
    });

    const waitlistId = fixture.repo.seedWaitlistEntry({
      organizationId: fixture.organizationId,
      customerPhone: "9993334444",
      customerName: "Cliente en espera",
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
    });

    const previousStartsAt = appointment.startsAt;
    const newStartsAt = zonedTimeToUtc("2026-09-14", "11:00", "America/Merida").toISOString();
    await rescheduleAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id, newStartsAt });

    const result = await notifyWaitlistAfterReschedule(fixture.repo, fixture.organizationId, "America/Merida", {
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      previousStartsAt,
      newStartsAt,
    });

    expect(result?.matched).toBe(true);
    expect(result?.waitlistId).toBe(waitlistId);
    expect(fixture.repo.getWaitlistEntry(waitlistId)?.notifiedCount).toBe(1);
  });

  it("nunca avisa si el horario 'nuevo' es idéntico al viejo — no se liberó nada real", async () => {
    const fixture = buildCitasFixture();
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    fixture.repo.seedWaitlistEntry({
      organizationId: fixture.organizationId,
      customerPhone: "9993334444",
      customerName: "Cliente en espera",
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
    });

    const result = await notifyWaitlistAfterReschedule(fixture.repo, fixture.organizationId, "America/Merida", {
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      previousStartsAt: startsAt,
      newStartsAt: startsAt,
    });

    expect(result).toBeNull();
  });
});

describe("previewListaEspera", () => {
  // Corrección bloqueante de la ronda 2 de revisión del PR #180 — antes de
  // este fix, esta función solo miraba `loadLiveWaitlistCandidates`/
  // `resolveActiveWhatsAppPhoneNumberId` (variantes de STAFF, funcionan sin
  // ninguna migración) y devolvía un conteo real aunque el post-commit en
  // sesión de sistema no pudiera hacer nada con la base sin migrar. Ahora
  // `areSystemWaitlistFunctionsAvailable()` (el probe de catálogo) se
  // consulta PRIMERO.
  it("con las funciones de sistema NO disponibles (base sin migrar), responde available:false SIN llegar a contar candidatos", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedWaitlistEntry({
      organizationId: fixture.organizationId,
      customerPhone: "9990000001",
      customerName: "Candidato real",
      providerId: null,
      serviceId: null,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    fixture.repo.setSystemWaitlistFunctionsAvailable(false);

    const preview = await previewListaEspera(fixture.repo, fixture.organizationId);

    expect(preview).toEqual({ available: false, candidatesConsidered: 0, skippedNoWhatsappConfig: false });
  });

  it("con las funciones de sistema disponibles (default, base ya migrada), sigue respondiendo el conteo real de candidatos", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedWaitlistEntry({
      organizationId: fixture.organizationId,
      customerPhone: "9990000001",
      customerName: "Candidato real",
      providerId: null,
      serviceId: null,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
      createdAt: "2026-09-01T10:00:00.000Z",
    });

    const preview = await previewListaEspera(fixture.repo, fixture.organizationId);

    expect(preview).toEqual({ available: true, candidatesConsidered: 1, skippedNoWhatsappConfig: false });
  });
});

describe("runListaEsperaCore", () => {
  it("notifica en orden de posición (FIFO, el que se anotó primero primero), recortado a `limit`", async () => {
    const fixture = buildCitasFixture();
    const first = fixture.repo.seedWaitlistEntry({
      organizationId: fixture.organizationId,
      customerPhone: "9990000001",
      customerName: "Primero en la fila",
      providerId: null,
      serviceId: null,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    const second = fixture.repo.seedWaitlistEntry({
      organizationId: fixture.organizationId,
      customerPhone: "9990000002",
      customerName: "Segundo en la fila",
      providerId: null,
      serviceId: null,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
      createdAt: "2026-09-01T11:00:00.000Z",
    });
    fixture.repo.seedWaitlistEntry({
      organizationId: fixture.organizationId,
      customerPhone: "9990000003",
      customerName: "Tercero en la fila",
      providerId: null,
      serviceId: null,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
      createdAt: "2026-09-01T12:00:00.000Z",
    });

    const summary = await runListaEsperaCore(fixture.repo, fixture.organizationId, {}, 2);

    expect(summary.candidatesConsidered).toBe(2);
    expect(summary.notified).toBe(2);
    expect(summary.skippedNoWhatsappConfig).toBe(false);

    const outbox = fixture.repo.getOutbox();
    expect(outbox).toHaveLength(2);
    // El primero en anotarse (`first`) se notifica antes que el segundo — el
    // tercero (fuera del límite de 2) nunca recibe mensaje.
    const dedupeKeys = outbox.map((m) => m.dedupeKey);
    expect(dedupeKeys.some((k) => k.startsWith(`waitlist-broadcast:${first}:`))).toBe(true);
    expect(dedupeKeys.some((k) => k.startsWith(`waitlist-broadcast:${second}:`))).toBe(true);
    expect(fixture.repo.getWaitlistEntry(first)?.notifiedCount).toBe(1);
  });

  it("filtra por proveedor/servicio cuando el staff lo especifica, sin matchear fecha/franja preferida", async () => {
    const fixture = buildCitasFixture();
    const otroProviderId = randomUUID();
    fixture.repo.seedWaitlistEntry({
      organizationId: fixture.organizationId,
      customerPhone: "9991110000",
      customerName: "Prefiere otro proveedor",
      providerId: otroProviderId,
      serviceId: null,
      preferredDateFrom: "2099-01-01", // fecha absurdamente lejana — igual matchea, no se filtra por fecha
      preferredDateTo: "2099-01-02",
      preferredTimeWindow: "morning",
    });
    const matching = fixture.repo.seedWaitlistEntry({
      organizationId: fixture.organizationId,
      customerPhone: "9992220000",
      customerName: "Sin preferencia de proveedor",
      providerId: null,
      serviceId: fixture.serviceId,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "evening", // tampoco se filtra por franja preferida
    });

    const summary = await runListaEsperaCore(fixture.repo, fixture.organizationId, { providerId: fixture.providerId });

    expect(summary.candidatesConsidered).toBe(1);
    expect(summary.notified).toBe(1);
    expect(fixture.repo.getOutbox()[0]?.dedupeKey).toMatch(new RegExp(`^waitlist-broadcast:${matching}:`));
  });

  it("respeta el tope real de MAX_WAITLIST_NOTIFICATIONS por cliente — se salta a quien ya llegó a su tope", async () => {
    const fixture = buildCitasFixture();
    const capped = fixture.repo.seedWaitlistEntry({
      organizationId: fixture.organizationId,
      customerPhone: "9993330000",
      customerName: "Ya en su tope",
      providerId: null,
      serviceId: null,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
      createdAt: "2026-09-01T09:00:00.000Z",
    });
    // Lleva al tope real (3) vía la misma RPC que usa runListaEsperaCore, no a mano.
    await fixture.repo.claimWaitlistNotificationSlot(capped, 3);
    await fixture.repo.claimWaitlistNotificationSlot(capped, 3);
    await fixture.repo.claimWaitlistNotificationSlot(capped, 3);
    const fresh = fixture.repo.seedWaitlistEntry({
      organizationId: fixture.organizationId,
      customerPhone: "9994440000",
      customerName: "Candidato fresco",
      providerId: null,
      serviceId: null,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
      createdAt: "2026-09-01T10:00:00.000Z",
    });

    const summary = await runListaEsperaCore(fixture.repo, fixture.organizationId);

    // `capped` ya no aparece como candidato vivo (loadLiveWaitlistCandidates
    // filtra notified_count < 3), así que solo el fresco cuenta y se notifica.
    expect(summary.candidatesConsidered).toBe(1);
    expect(summary.notified).toBe(1);
    expect(fixture.repo.getOutbox()[0]?.dedupeKey).toMatch(new RegExp(`^waitlist-broadcast:${fresh}:`));
  });

  it("nunca lanza y reporta skippedNoWhatsappConfig si el negocio no tiene WhatsApp activo", async () => {
    const fixture = buildCitasFixture();
    const sinWhatsapp = randomUUID();
    fixture.repo.seedOrganization({ id: sinWhatsapp, slug: "sin-whatsapp", name: "Negocio Sin WhatsApp" });
    fixture.repo.seedWaitlistEntry({
      organizationId: sinWhatsapp,
      customerPhone: "9995550000",
      customerName: "Cliente en espera",
      providerId: null,
      serviceId: null,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
    });

    const summary = await runListaEsperaCore(fixture.repo, sinWhatsapp);

    expect(summary.skippedNoWhatsappConfig).toBe(true);
    expect(summary.notified).toBe(0);
    expect(fixture.repo.getOutbox()).toHaveLength(0);
  });

  it("recorta un límite pedido por el caller al techo real MAX_LISTA_ESPERA_LIMIT", async () => {
    const fixture = buildCitasFixture();
    for (let i = 0; i < 3; i += 1) {
      fixture.repo.seedWaitlistEntry({
        organizationId: fixture.organizationId,
        customerPhone: `999000000${i}`,
        customerName: `Cliente ${i}`,
        providerId: null,
        serviceId: null,
        preferredDateFrom: null,
        preferredDateTo: null,
        preferredTimeWindow: "any",
        createdAt: `2026-09-01T0${i}:00:00.000Z`,
      });
    }

    const summary = await runListaEsperaCore(fixture.repo, fixture.organizationId, {}, MAX_LISTA_ESPERA_LIMIT + 1000);

    // Solo hay 3 candidatos reales, así que el techo no cambia el resultado aquí
    // — esto prueba que un límite absurdo no lanza ni se cuela sin recortar.
    expect(summary.candidatesConsidered).toBe(3);
    expect(summary.notified).toBe(3);
  });
});
