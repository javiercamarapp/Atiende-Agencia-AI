// C-06 -- checklist de onboarding derivado de datos reales + puerta de la reserva publica. Casos de borde: negocio
// vacio, servicio sin precio, horario en otro proveedor, sucursales, proveedor inactivo, base sin migrar.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { computeOnboardingChecklist, evaluarReservaPublica } from "../src/onboarding.ts";
import { MENSAJES_CONFIG_POR_OMISION } from "../src/whatsapp/message-config.ts";
import { buildCitasFixture } from "./fixtures.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const SUC_A = randomUUID();
const SUC_B = randomUUID();

function negocioVacio() {
  const repo = new InMemoryCitasRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "vacio", name: "Vacío", defaultTimezone: "America/Merida" });
  return { repo, organizationId };
}

function estados(c: Awaited<ReturnType<typeof computeOnboardingChecklist>>): Record<string, string> {
  return Object.fromEntries(c.pasos.map((p) => [p.id, p.estado]));
}

function proveedor(organizationId: string, propertyId: string | null, isActive = true) {
  return { id: randomUUID(), organizationId, propertyId, displayName: `P-${randomUUID().slice(0, 4)}`, roleLabel: "Proveedor", isActive };
}
function servicio(organizationId: string, priceCents: number | null = 10000, isActive = true) {
  return { id: randomUUID(), organizationId, name: `S-${randomUUID().slice(0, 4)}`, durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents, isActive };
}
function regla(providerId: string, isActive = true) {
  return { id: randomUUID(), providerId, dayOfWeek: 1, startTime: "09:00", endTime: "17:00", isActive };
}

describe("computeOnboardingChecklist", () => {
  it("negocio vacio: 0 pasos completos, no listo, faltan los 4 requeridos", async () => {
    const { repo, organizationId } = negocioVacio();
    const c = await computeOnboardingChecklist(repo, organizationId, SUC_A);
    expect(c.completados).toBe(0);
    expect(c.total).toBe(9);
    expect(c.progresoPct).toBe(0);
    expect(c.listoParaRecibirCitas).toBe(false);
    expect(c.faltanParaPublicar).toEqual(["proveedor", "servicio", "asignacion", "horario"]);
  });

  it("negocio completo: todo en verde salvo lo que de verdad falta (mensaje de cancelacion y cita de prueba)", async () => {
    const f = buildCitasFixture();
    const c = await computeOnboardingChecklist(f.repo, f.organizationId, SUC_A);
    expect(c.listoParaRecibirCitas).toBe(true);
    expect(c.faltanParaPublicar).toEqual([]);
    expect(estados(c)).toEqual({
      proveedor: "completo", servicio: "completo", asignacion: "completo", horario: "completo", precio: "completo",
      whatsapp: "completo", recordatorios: "completo", cancelacion: "pendiente", cita_prueba: "pendiente",
    });
    expect(c.completados).toBe(7);
    expect(c.progresoPct).toBe(78);
  });

  it("C-15: el paso 'Conecta tu numero' lleva a la pantalla donde SE conecta; el de recordatorios, a los textos; un numero pausado no cuenta como conectado", async () => {
    const f = buildCitasFixture();
    const rutas = (c: Awaited<ReturnType<typeof computeOnboardingChecklist>>) => Object.fromEntries(c.pasos.map((p) => [p.id, p.ruta]));
    const c = await computeOnboardingChecklist(f.repo, f.organizationId, SUC_A);
    expect(rutas(c).whatsapp).toBe("agente-whatsapp");
    expect(rutas(c).recordatorios).toBe("mensajes-whatsapp");

    await f.repo.connectWhatsappNumber(f.organizationId, "109876543210987", false);
    expect(estados(await computeOnboardingChecklist(f.repo, f.organizationId, SUC_A)).whatsapp).toBe("pendiente");
    await f.repo.connectWhatsappNumber(f.organizationId, "109876543210987", true);
    expect(estados(await computeOnboardingChecklist(f.repo, f.organizationId, SUC_A)).whatsapp).toBe("completo");
    await f.repo.disconnectWhatsappNumber(f.organizationId);
    expect(estados(await computeOnboardingChecklist(f.repo, f.organizationId, SUC_A)).whatsapp).toBe("pendiente");
  });

  it("cancelacion y cita de prueba se completan con datos reales (config guardada y una cita existente)", async () => {
    const f = buildCitasFixture();
    await f.repo.saveWhatsappMessageConfig(f.organizationId, 0, "actualizado", { ...MENSAJES_CONFIG_POR_OMISION, cancellationEnabled: true });
    f.repo.seedAppointment({
      id: randomUUID(), organizationId: f.organizationId, propertyId: null, providerId: f.providerId, serviceId: f.serviceId, customerId: randomUUID(),
      startsAt: "2026-10-05T16:00:00.000Z", endsAt: "2026-10-05T16:30:00.000Z", status: "cancelled", source: "manual", notes: null, dedupeFingerprint: null,
      idempotencyKey: null, reminder24hSentAt: null, createdAt: "2026-10-01T00:00:00.000Z", googleEventId: null, googleSyncStatus: "skipped",
      googleSyncAttempts: 0, googleSyncNextRetryAt: null, googleSyncError: null,
    });
    const c = await computeOnboardingChecklist(f.repo, f.organizationId, SUC_A);
    expect(estados(c).cancelacion).toBe("completo");
    expect(estados(c).cita_prueba).toBe("completo");
    expect(c.progresoPct).toBe(100);
  });

  it("servicio sin precio: el paso precio queda pendiente con el conteo, pero no bloquea la reserva", async () => {
    const f = buildCitasFixture();
    f.repo.seedService(servicio(f.organizationId, null));
    const c = await computeOnboardingChecklist(f.repo, f.organizationId, SUC_A);
    const precio = c.pasos.find((p) => p.id === "precio")!;
    expect(precio.estado).toBe("pendiente");
    expect(precio.detalle).toBe("1 servicio sin precio");
    expect(precio.requeridoParaPublicar).toBe(false);
    expect(c.listoParaRecibirCitas).toBe(true);
  });

  it("precio 0 cuenta como precio definido (servicio gratuito)", async () => {
    const { repo, organizationId } = negocioVacio();
    repo.seedService(servicio(organizationId, 0));
    expect(estados(await computeOnboardingChecklist(repo, organizationId, SUC_A)).precio).toBe("completo");
  });

  it("proveedor y servicio sin asignar: asignacion y horario pendientes, no listo", async () => {
    const { repo, organizationId } = negocioVacio();
    repo.seedProvider(proveedor(organizationId, null));
    repo.seedService(servicio(organizationId));
    const c = await computeOnboardingChecklist(repo, organizationId, SUC_A);
    expect(c.faltanParaPublicar).toEqual(["asignacion", "horario"]);
    expect(estados(c)).toMatchObject({ proveedor: "completo", servicio: "completo", asignacion: "pendiente", horario: "pendiente" });
  });

  it("horario en un proveedor que NO ofrece el servicio: el horario no basta para publicar", async () => {
    const { repo, organizationId } = negocioVacio();
    const conServicio = proveedor(organizationId, null);
    const conHorario = proveedor(organizationId, null);
    const s = servicio(organizationId);
    repo.seedProvider(conServicio);
    repo.seedProvider(conHorario);
    repo.seedService(s);
    repo.seedProviderService(conServicio.id, s.id);
    repo.seedAvailabilityRule(regla(conHorario.id));
    const c = await computeOnboardingChecklist(repo, organizationId, SUC_A);
    expect(c.listoParaRecibirCitas).toBe(false);
    expect(c.faltanParaPublicar).toEqual(["horario"]);
    expect(c.pasos.find((p) => p.id === "horario")!.estado).toBe("pendiente");
  });

  it("reglas de horario inactivas no cuentan", async () => {
    const { repo, organizationId } = negocioVacio();
    const p = proveedor(organizationId, null);
    const s = servicio(organizationId);
    repo.seedProvider(p);
    repo.seedService(s);
    repo.seedProviderService(p.id, s.id);
    repo.seedAvailabilityRule(regla(p.id, false));
    expect((await computeOnboardingChecklist(repo, organizationId, SUC_A)).faltanParaPublicar).toEqual(["horario"]);
  });

  it("proveedor o servicio inactivos no cuentan", async () => {
    const { repo, organizationId } = negocioVacio();
    const p = proveedor(organizationId, null, false);
    const s = servicio(organizationId, 100, false);
    repo.seedProvider(p);
    repo.seedService(s);
    repo.seedProviderService(p.id, s.id);
    repo.seedAvailabilityRule(regla(p.id));
    const c = await computeOnboardingChecklist(repo, organizationId, SUC_A);
    expect(c.faltanParaPublicar).toEqual(["proveedor", "servicio", "asignacion", "horario"]);
    expect(estados(c).precio).toBe("pendiente");
  });

  it("multi-sucursal: el avance es por sucursal; un proveedor sin sucursal cuenta en todas", async () => {
    const { repo, organizationId } = negocioVacio();
    const deA = proveedor(organizationId, SUC_A);
    const s = servicio(organizationId);
    repo.seedProvider(deA);
    repo.seedService(s);
    repo.seedProviderService(deA.id, s.id);
    repo.seedAvailabilityRule(regla(deA.id));
    expect((await computeOnboardingChecklist(repo, organizationId, SUC_A)).listoParaRecibirCitas).toBe(true);
    const enB = await computeOnboardingChecklist(repo, organizationId, SUC_B);
    expect(enB.listoParaRecibirCitas).toBe(false);
    expect(enB.faltanParaPublicar).toEqual(["proveedor", "asignacion", "horario"]);
    // Un proveedor sin sucursal ya cubre a B.
    const global = proveedor(organizationId, null);
    repo.seedProvider(global);
    repo.seedProviderService(global.id, s.id);
    repo.seedAvailabilityRule(regla(global.id));
    expect((await computeOnboardingChecklist(repo, organizationId, SUC_B)).listoParaRecibirCitas).toBe(true);
  });

  it("aislamiento entre organizaciones: los datos de otra organizacion no completan pasos", async () => {
    const f = buildCitasFixture();
    const c = await computeOnboardingChecklist(f.repo, randomUUID(), SUC_A);
    expect(c.completados).toBe(0);
  });

  it("sin WhatsApp: recordatorios pendientes con el motivo; con recordatorios apagados, tambien", async () => {
    const { repo, organizationId } = negocioVacio();
    let c = await computeOnboardingChecklist(repo, organizationId, SUC_A);
    expect(c.pasos.find((p) => p.id === "recordatorios")).toMatchObject({ estado: "pendiente", detalle: "Falta conectar WhatsApp" });
    repo.seedWhatsAppConfig(organizationId, "999");
    await repo.saveWhatsappMessageConfig(organizationId, 0, "actualizado", { ...MENSAJES_CONFIG_POR_OMISION, reminderEnabled: false });
    c = await computeOnboardingChecklist(repo, organizationId, SUC_A);
    expect(c.pasos.find((p) => p.id === "recordatorios")).toMatchObject({ estado: "pendiente", detalle: "Los recordatorios están apagados" });
  });

  it("base sin migrar (026): cancelacion queda no_disponible y el resto se calcula igual, sin error", async () => {
    const f = buildCitasFixture();
    f.repo.whatsappMessageConfigDisponible = false;
    const c = await computeOnboardingChecklist(f.repo, f.organizationId, SUC_A);
    expect(estados(c).cancelacion).toBe("no_disponible");
    expect(estados(c).recordatorios).toBe("completo");
    expect(c.listoParaRecibirCitas).toBe(true);
    expect(c.completados).toBe(7);
  });
});

describe("evaluarReservaPublica", () => {
  it("negocio vacio -> no lista; completo -> lista", async () => {
    const { repo, organizationId } = negocioVacio();
    const v = await evaluarReservaPublica(repo, organizationId);
    expect(v.lista).toBe(false);
    expect(v.faltan.length).toBeGreaterThan(0);
    const f = buildCitasFixture();
    expect(await evaluarReservaPublica(f.repo, f.organizationId)).toEqual({ lista: true, faltan: [] });
  });

  it("no exige WhatsApp, precio ni cita de prueba (nada que hoy funcione se cierra)", async () => {
    const { repo, organizationId } = negocioVacio();
    const p = proveedor(organizationId, null);
    const s = servicio(organizationId, null);
    repo.seedProvider(p);
    repo.seedService(s);
    repo.seedProviderService(p.id, s.id);
    repo.seedAvailabilityRule(regla(p.id));
    expect((await evaluarReservaPublica(repo, organizationId)).lista).toBe(true);
  });

  it("coincide con computeOnboardingChecklist en todos los escenarios de combinacion", async () => {
    const escenarios: Array<(r: InMemoryCitasRepository, o: string) => void> = [
      () => undefined,
      (r, o) => r.seedProvider(proveedor(o, null)),
      (r, o) => { const p = proveedor(o, null); const s = servicio(o); r.seedProvider(p); r.seedService(s); r.seedProviderService(p.id, s.id); },
      (r, o) => { const p = proveedor(o, null); const s = servicio(o); r.seedProvider(p); r.seedService(s); r.seedProviderService(p.id, s.id); r.seedAvailabilityRule(regla(p.id)); },
    ];
    for (const armar of escenarios) {
      const { repo, organizationId } = negocioVacio();
      armar(repo, organizationId);
      const gate = await evaluarReservaPublica(repo, organizationId);
      const lista = await computeOnboardingChecklist(repo, organizationId, SUC_A);
      expect(gate.lista).toBe(lista.listoParaRecibirCitas);
    }
  });
});

describe("computeOnboardingChecklist sobre Postgres sin la migracion 026 (SAVEPOINT)", () => {
  const noTable = () => Object.assign(new Error('relation "citas.whatsapp_message_config" does not exist'), { code: "42P01" });
  const prov = { id: randomUUID(), organization_id: "o", property_id: null, display_name: "P", role_label: "x", is_active: true };
  const serv = { id: randomUUID(), organization_id: "o", name: "S", duration_minutes: 30, buffer_minutes_before: 0, buffer_minutes_after: 0, price_cents: 100, is_active: true };

  it("42P01 en la lectura de mensajes degrada a no_disponible y las lecturas posteriores siguen funcionando (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from citas\.providers p\s+join citas\.provider_services/, respond: () => [prov] },
      { match: /from citas\.providers/, respond: () => [prov] },
      { match: /from citas\.services/, respond: () => [serv] },
      { match: /from citas\.availability_rules/, respond: () => [{ id: "r", provider_id: prov.id, day_of_week: 1, start_time: "09:00", end_time: "17:00", is_active: true }] },
      { match: /from citas\.whatsapp_config/, respond: () => [{ phone_number_id: "123" }] },
      { match: /from citas\.whatsapp_message_config where/, respond: noTable },
      { match: /from citas\.appointments/, respond: () => [] },
    ]);
    const c = await computeOnboardingChecklist(new PostgresCitasRepository(session), "o", SUC_A);
    expect(c.pasos.find((p) => p.id === "cancelacion")!.estado).toBe("no_disponible");
    expect(c.pasos.find((p) => p.id === "cita_prueba")!.estado).toBe("pendiente");
    expect(c.listoParaRecibirCitas).toBe(true);
    expect(session.calls.some((x) => x.startsWith("rollback to savepoint"))).toBe(true);
  });
});
