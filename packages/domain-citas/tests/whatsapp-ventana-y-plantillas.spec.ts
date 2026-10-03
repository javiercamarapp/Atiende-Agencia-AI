// PL-31 -- ventana de 24 h de Meta y plantillas HSM por organizacion en los avisos proactivos de citas. Reloj simulado (`now`), sin red.
import { describe, expect, it, vi } from "vitest";
import { createAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { runListaEsperaCore, runOptimizadorCore, runConfirmacionCitaCore } from "../src/reminders.ts";
import { VENTANA_SEGURA_MS, armarParametrosPlantilla, decidirEnvioProactivo, variantesTelefonoEntrante } from "../src/whatsapp/proactivo.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import { buildCitasFixture } from "./fixtures.ts";

const NOW = new Date("2026-09-14T18:00:00.000Z");
const TELEFONO = "5219981110001";
const PLANTILLA = { name: "recordatorio_cita_24h", language: "es_MX", variables: ["nombre", "fecha", "hora"] } as const;

function hace(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

async function negocioConCita(opts: { readonly email?: string } = {}) {
  const fixture = buildCitasFixture();
  fixture.repo.habilitarPlantillasYVentanaWhatsapp();
  const startsAt = zonedTimeToUtc("2026-09-15", "09:00", "America/Merida");
  const apt = await createAppointment(fixture.repo, {
    organizationId: fixture.organizationId,
    providerId: fixture.providerId,
    serviceId: fixture.serviceId,
    customerName: "Ana Perez",
    customerPhone: TELEFONO,
    ...(opts.email ? { customerEmail: opts.email } : {}),
    startsAt: startsAt.toISOString(),
    source: "web",
  });
  return { ...fixture, appointmentId: apt.id };
}

const salidas = (repo: InMemoryCitasRepository, channel: "whatsapp" | "email") => repo.getOutbox().filter((o) => o.channel === channel);

describe("armarParametrosPlantilla", () => {
  it("ordena los valores segun las variables de la plantilla", () => {
    expect(armarParametrosPlantilla(["hora", "nombre"], { nombre: "Ana", hora: "09:00", fecha: "x" })).toEqual(["09:00", "Ana"]);
  });
  it("falta una variable, queda vacia o hay mas de 10: null (no se manda una plantilla incompleta)", () => {
    expect(armarParametrosPlantilla(["nombre", "hora"], { nombre: "Ana" })).toBeNull();
    expect(armarParametrosPlantilla(["nombre"], { nombre: "   " })).toBeNull();
    expect(armarParametrosPlantilla(Array.from({ length: 11 }, (_, i) => `v${i}`), {})).toBeNull();
  });
  it("sanea saltos de linea y recorta a 1024", () => {
    expect(armarParametrosPlantilla(["n"], { n: "Ana\nPerez\t  X" })).toEqual(["Ana Perez X"]);
    expect(armarParametrosPlantilla(["n"], { n: "x".repeat(2000) })?.[0]).toHaveLength(1024);
  });
});

describe("variantesTelefonoEntrante", () => {
  it("de los 10 digitos que guarda citas.customers saca los formatos del wa_id de Meta (+521..., +52...), cada uno una vez", () => {
    const v = variantesTelefonoEntrante("9981110001");
    expect(v).toEqual(expect.arrayContaining(["+5219981110001", "+529981110001", "5219981110001", "9981110001"]));
    expect(new Set(v).size).toBe(v.length);
    expect(v.length).toBeLessThanOrEqual(8);
  });
  it("un telefono con lada y '+' conserva su formato original", () => {
    expect(variantesTelefonoEntrante("+5219981110001")).toContain("+5219981110001");
  });
});

describe("decidirEnvioProactivo", () => {
  const base = { phone: TELEFONO, evento: "appointment.reminder_24h", valores: { nombre: "Ana", fecha: "martes", hora: "09:00" }, now: NOW };

  it("base sin la migracion 0048 (undefined): comportamiento anterior, texto libre sin plantilla", async () => {
    const repo = new InMemoryCitasRepository();
    expect(await decidirEnvioProactivo(repo, { ...base, organizationId: "org-a" })).toEqual({ canal: "whatsapp" });
  });

  it("dentro de la ventana (cliente escribio hace 2 h): texto libre aunque haya plantilla aprobada", async () => {
    const repo = new InMemoryCitasRepository();
    repo.habilitarPlantillasYVentanaWhatsapp();
    repo.seedPlantillaWhatsappAprobada("org-a", "appointment.reminder_24h", PLANTILLA);
    repo.seedEntradaWhatsapp("org-a", TELEFONO, hace(2 * 3600_000));
    expect(await decidirEnvioProactivo(repo, { ...base, organizationId: "org-a" })).toEqual({ canal: "whatsapp" });
  });

  it("margen de seguridad: a las 23 h exactas ya cuenta como fuera de la ventana", async () => {
    const repo = new InMemoryCitasRepository();
    repo.habilitarPlantillasYVentanaWhatsapp();
    repo.seedEntradaWhatsapp("org-a", TELEFONO, hace(VENTANA_SEGURA_MS));
    expect(await decidirEnvioProactivo(repo, { ...base, organizationId: "org-a" })).toEqual({ canal: "sin_plantilla" });
  });

  it("fuera de la ventana con plantilla aprobada: type template con las variables en el orden del catalogo", async () => {
    const repo = new InMemoryCitasRepository();
    repo.habilitarPlantillasYVentanaWhatsapp();
    repo.seedPlantillaWhatsappAprobada("org-a", "appointment.reminder_24h", PLANTILLA);
    repo.seedEntradaWhatsapp("org-a", TELEFONO, hace(48 * 3600_000));
    expect(await decidirEnvioProactivo(repo, { ...base, organizationId: "org-a" })).toEqual({ canal: "whatsapp", template: { name: "recordatorio_cita_24h", language: "es_MX", params: ["Ana", "martes", "09:00"] } });
  });

  it("nunca escribio y sin plantilla: sin_plantilla", async () => {
    const repo = new InMemoryCitasRepository();
    repo.habilitarPlantillasYVentanaWhatsapp();
    expect(await decidirEnvioProactivo(repo, { ...base, organizationId: "org-a" })).toEqual({ canal: "sin_plantilla" });
  });

  it("cross-tenant: la plantilla aprobada de la org B no se usa para la org A", async () => {
    const repo = new InMemoryCitasRepository();
    repo.habilitarPlantillasYVentanaWhatsapp();
    repo.seedPlantillaWhatsappAprobada("org-b", "appointment.reminder_24h", PLANTILLA);
    expect(await decidirEnvioProactivo(repo, { ...base, organizationId: "org-a" })).toEqual({ canal: "sin_plantilla" });
    expect((await decidirEnvioProactivo(repo, { ...base, organizationId: "org-b" })).canal).toBe("whatsapp");
  });

  it("la plantilla pide una variable que el evento no sabe calcular: sin_plantilla (nunca una plantilla incompleta)", async () => {
    const repo = new InMemoryCitasRepository();
    repo.habilitarPlantillasYVentanaWhatsapp();
    repo.seedPlantillaWhatsappAprobada("org-a", "appointment.reminder_24h", { ...PLANTILLA, variables: ["nombre", "doctor"] });
    expect(await decidirEnvioProactivo(repo, { ...base, organizationId: "org-a" })).toEqual({ canal: "sin_plantilla" });
  });

  it("los valores se calculan solo cuando hay plantilla que llenar", async () => {
    const repo = new InMemoryCitasRepository();
    repo.habilitarPlantillasYVentanaWhatsapp();
    repo.seedEntradaWhatsapp("org-a", TELEFONO, hace(3600_000));
    const valores = vi.fn(async () => ({ nombre: "Ana" }));
    await decidirEnvioProactivo(repo, { ...base, organizationId: "org-a", valores });
    expect(valores).not.toHaveBeenCalled();
  });
});

describe("recordatorio de 24 h (runConfirmacionCitaCore)", () => {
  it("fuera de la ventana y SIN plantilla: 0 WhatsApp y 1 correo en el outbox, estado honesto y sin evento de 'sin canal'", async () => {
    const n = await negocioConCita({ email: "ana@example.com" });
    const resumen = await runConfirmacionCitaCore(n.repo, n.organizationId, NOW);
    expect(salidas(n.repo, "whatsapp")).toHaveLength(0);
    expect(salidas(n.repo, "email")).toHaveLength(1);
    expect(resumen).toMatchObject({ sent: 0, sentEmail: 1, skippedSinPlantilla: 1, failedReminderEvents: [] });
  });

  it("fuera de la ventana, sin plantilla y sin correo: nada sale, queda pendiente para reintentar, cuenta sin_plantilla y NO se marca enviado", async () => {
    const n = await negocioConCita();
    const resumen = await runConfirmacionCitaCore(n.repo, n.organizationId, NOW);
    expect(n.repo.getOutbox()).toHaveLength(0);
    expect(resumen).toMatchObject({ sent: 0, sentEmail: 0, skippedSinPlantilla: 1, failedReminderEvents: [] });
    expect((await runConfirmacionCitaCore(n.repo, n.organizationId, NOW)).processed).toBe(1);
  });

  it("fuera de la ventana CON plantilla aprobada: WhatsApp con template (evento + variables) ademas del texto de respaldo", async () => {
    const n = await negocioConCita();
    n.repo.seedPlantillaWhatsappAprobada(n.organizationId, "appointment.reminder_24h", PLANTILLA);
    await runConfirmacionCitaCore(n.repo, n.organizationId, NOW);
    const [wa] = salidas(n.repo, "whatsapp");
    const payload = wa!.payload as { template: { name: string; language: string; params: string[] }; body: string; buttons: unknown[] };
    expect(payload.template).toMatchObject({ name: "recordatorio_cita_24h", language: "es_MX" });
    expect(payload.template.params[0]).toBe("Ana Perez");
    expect(payload.template.params).toHaveLength(3);
    expect(payload.body.length).toBeGreaterThan(0);
  });

  it("DENTRO de la ventana: texto libre con botones y sin template", async () => {
    const n = await negocioConCita();
    n.repo.seedPlantillaWhatsappAprobada(n.organizationId, "appointment.reminder_24h", PLANTILLA);
    n.repo.seedEntradaWhatsapp(n.organizationId, TELEFONO, hace(3600_000));
    await runConfirmacionCitaCore(n.repo, n.organizationId, NOW);
    const payload = salidas(n.repo, "whatsapp")[0]!.payload as Record<string, unknown>;
    expect("template" in payload).toBe(false);
    expect(Array.isArray(payload.buttons)).toBe(true);
  });

  it("base SIN la migracion 0048: comportamiento anterior (WhatsApp de texto libre, sin template)", async () => {
    const fixture = buildCitasFixture();
    const startsAt = zonedTimeToUtc("2026-09-15", "09:00", "America/Merida");
    await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "Ana", customerPhone: TELEFONO, startsAt: startsAt.toISOString(), source: "web" });
    const resumen = await runConfirmacionCitaCore(fixture.repo, fixture.organizationId, NOW);
    expect(resumen).toMatchObject({ sent: 1, skippedSinPlantilla: 0 });
    expect("template" in (salidas(fixture.repo, "whatsapp")[0]!.payload as object)).toBe(false);
  });
});

describe("lista de espera", () => {
  function conLista(opts: { readonly email?: string } = {}) {
    const fixture = buildCitasFixture();
    fixture.repo.habilitarPlantillasYVentanaWhatsapp();
    if (opts.email) void fixture.repo.upsertCustomer(fixture.organizationId, TELEFONO, "Ana", opts.email);
    const waitlistId = fixture.repo.seedWaitlistEntry({ organizationId: fixture.organizationId, customerPhone: TELEFONO, customerName: "Ana", providerId: fixture.providerId, serviceId: null, preferredDateFrom: null, preferredDateTo: null, preferredTimeWindow: "any" });
    return { ...fixture, waitlistId };
  }
  const evento = (providerId: string) => ({ providerId, startsAt: "2026-09-16T16:00:00.000Z" });

  it("oferta fuera de la ventana, sin plantilla y sin correo: no sale nada y NO gasta un intento del cliente", async () => {
    const n = conLista();
    const r = await runOptimizadorCore(n.repo, n.organizationId, "America/Merida", evento(n.providerId));
    expect(r).toEqual({ matched: false, reason: "sin_plantilla" });
    expect(n.repo.getOutbox()).toHaveLength(0);
    expect(n.repo.getWaitlistEntry(n.waitlistId)?.notifiedCount).toBe(0);
  });

  it("oferta fuera de la ventana, sin plantilla y con correo: 0 WhatsApp y 1 correo", async () => {
    const n = conLista({ email: "ana@example.com" });
    const r = await runOptimizadorCore(n.repo, n.organizationId, "America/Merida", evento(n.providerId));
    expect(r).toMatchObject({ matched: true, channel: "correo" });
    expect(salidas(n.repo, "whatsapp")).toHaveLength(0);
    expect(salidas(n.repo, "email")).toHaveLength(1);
    expect(n.repo.getWaitlistEntry(n.waitlistId)?.notifiedCount).toBe(1);
  });

  it("oferta fuera de la ventana CON plantilla aprobada: WhatsApp con template", async () => {
    const n = conLista();
    n.repo.seedPlantillaWhatsappAprobada(n.organizationId, "waitlist.slot_offered", { name: "hueco_lista_espera", language: "es_MX", variables: ["nombre", "negocio"] });
    const r = await runOptimizadorCore(n.repo, n.organizationId, "America/Merida", evento(n.providerId));
    expect(r.matched).toBe(true);
    const payload = salidas(n.repo, "whatsapp")[0]!.payload as { template: { name: string; params: string[] } };
    expect(payload.template).toMatchObject({ name: "hueco_lista_espera", params: ["Ana", "Clínica Dental Sonrisas"] });
  });

  it("broadcast del staff: sin plantilla y sin correo cuenta skippedSinPlantilla; con correo avisa por correo", async () => {
    const sin = conLista();
    expect(await runListaEsperaCore(sin.repo, sin.organizationId, {})).toMatchObject({ notified: 0, skippedSinPlantilla: 1 });
    expect(sin.repo.getOutbox()).toHaveLength(0);
    const con = conLista({ email: "ana@example.com" });
    expect(await runListaEsperaCore(con.repo, con.organizationId, {})).toMatchObject({ notified: 1, skippedSinPlantilla: 0 });
    expect(salidas(con.repo, "email")).toHaveLength(1);
    expect(salidas(con.repo, "whatsapp")).toHaveLength(0);
  });
});

describe("PostgresCitasRepository: base sin la migracion 0048 (AbortAwareFakeSession)", () => {
  const pg42883 = (fn: string) => Object.assign(new Error(`function ${fn}(uuid, text) does not exist`), { code: "42883" });

  it("resolveWhatsappTemplate y lastInboundWhatsappAt devuelven undefined, avisan UNA vez y dejan la sesion utilizable (SAVEPOINT)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new AbortAwareFakeSession([
      { match: /core\.whatsapp_plantilla_resolver/, respond: () => pg42883("core.whatsapp_plantilla_resolver") },
      { match: /citas\.ultimo_mensaje_entrante/, respond: () => pg42883("citas.ultimo_mensaje_entrante") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresCitasRepository(session);
    expect(await repo.resolveWhatsappTemplate("org-a", "appointment.reminder_24h")).toBeUndefined();
    expect(await repo.lastInboundWhatsappAt("org-a", "+5219981110001")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
    warn.mockRestore();
  });

  it("con la migracion: mapea la plantilla aprobada y la ultima entrada, y manda solo hashes (nunca el telefono)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /core\.whatsapp_plantilla_resolver/, respond: () => [{ nombre: "recordatorio_cita_24h", idioma: "es_MX", variables: ["nombre", "hora"] }] },
      { match: /citas\.ultimo_mensaje_entrante/, respond: () => [{ ultimo: new Date("2026-09-14T10:00:00.000Z") }] },
    ]);
    const spy = vi.spyOn(session, "query");
    const repo = new PostgresCitasRepository(session);
    expect(await repo.resolveWhatsappTemplate("org-a", "appointment.reminder_24h")).toEqual({ name: "recordatorio_cita_24h", language: "es_MX", variables: ["nombre", "hora"] });
    expect(await repo.lastInboundWhatsappAt("org-a", "+5219981110001")).toBe("2026-09-14T10:00:00.000Z");
    const hashes = spy.mock.calls.find((c) => String(c[0]).includes("ultimo_mensaje_entrante"))![1]![1] as string[];
    expect(hashes.length).toBeGreaterThanOrEqual(3);
    expect(hashes.length).toBeLessThanOrEqual(8);
    expect(hashes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("5219981110001");
  });

  it("nunca escribio: la funcion devuelve null y se traduce a null (no a undefined)", async () => {
    const session = new AbortAwareFakeSession([{ match: /citas\.ultimo_mensaje_entrante/, respond: () => [{ ultimo: null }] }]);
    expect(await new PostgresCitasRepository(session).lastInboundWhatsappAt("org-a", "5219981110001")).toBeNull();
  });
});
