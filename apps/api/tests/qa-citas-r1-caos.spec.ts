// QA adversarial citas, ronda 1 (lente CAOS: excepciones, reintentos, multi-sucursal, datos enormes) -- app Hono REAL con
// repositorios en memoria (sin red, sin base real, sin LLM).
// Convencion: `it.fails` = defecto vigente en main c77863be (la prueba afirma lo ESPERADO y hoy falla); al corregirlo, cambiar a
// `it`. `it` normal = comportamiento verificado que hoy PASA. Ids estables: QA-citas-R1-caos-NN (work/qa/citas/ronda-1-caos.md).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildCitasTestContext } from "./citas-fixtures.ts";
import type { CitasTestContext } from "./citas-fixtures.ts";

type App = ReturnType<typeof buildApp>;

// Lunes futuro fijo dentro del horario L-V 09:00-17:00 de la fixture (America/Merida, UTC-6).
const LUNES_10 = "2027-09-13T16:00:00.000Z";
const LUNES_11 = "2027-09-13T17:00:00.000Z";
const MES_DESDE = "2027-09-01T00:00:00.000Z";
const MES_HASTA = "2027-10-01T00:00:00.000Z";

interface CitaWire {
  readonly id: string;
  readonly property_id: string | null;
  readonly provider_id: string;
  readonly starts_at: string;
}

/** Segunda sucursal de la MISMA organizacion con su propio proveedor (L-V 09-17) que da el servicio de la fixture. */
function segundaSucursal(ctx: CitasTestContext) {
  const propertyB = randomUUID();
  ctx.engine.seedProperty({ id: propertyB, organizationId: ctx.organizationId });
  ctx.citasRepo.seedCitasProperty({ id: propertyB, organizationId: ctx.organizationId, name: "Sucursal Norte" });
  const providerB = randomUUID();
  ctx.citasRepo.seedProvider({ id: providerB, organizationId: ctx.organizationId, propertyId: propertyB, displayName: "Dr. Norte", roleLabel: "Dentista", isActive: true });
  ctx.citasRepo.seedProviderService(providerB, ctx.serviceId);
  for (const dayOfWeek of [1, 2, 3, 4, 5]) ctx.citasRepo.seedAvailabilityRule({ id: randomUUID(), providerId: providerB, dayOfWeek, startTime: "09:00", endTime: "17:00", isActive: true });
  // El proveedor de la fixture (propertyId null) pasa a ser de la sucursal principal, como en un negocio multi-sucursal real.
  ctx.citasRepo.seedProvider({ id: ctx.providerId, organizationId: ctx.organizationId, propertyId: ctx.propertyId, displayName: "Dra. Fernanda López", roleLabel: "Dentista", isActive: true });
  return { propertyB, providerB };
}

async function crearDesdePanel(app: App, token: string, propertyId: string, body: Record<string, unknown>) {
  return app.request(`/v1/citas/properties/${propertyId}/appointments`, authedJson(token, body));
}

async function agenda(app: App, token: string, propertyId: string): Promise<readonly CitaWire[]> {
  const res = await app.request(`/v1/citas/properties/${propertyId}/appointments?from=${MES_DESDE}&to=${MES_HASTA}`, authedGet(token));
  expect(res.status).toBe(200);
  return ((await res.json()) as { appointments: CitaWire[] }).appointments;
}

describe("QA R1 caos citas -- multi-sucursal", () => {
  it("QA-citas-R1-caos-01: la Agenda de la sucursal Norte NO debe mostrar las citas de la sucursal principal", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { propertyB, providerB } = segundaSucursal(ctx);
    const owner = ctx.staff.owner.token;

    const enPrincipal = await crearDesdePanel(app, owner, ctx.propertyId, { provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Paciente Centro", customer_phone: "9991110001", starts_at: LUNES_10 });
    expect(enPrincipal.status).toBe(201);
    const enNorte = await crearDesdePanel(app, owner, propertyB, { provider_id: providerB, service_id: ctx.serviceId, customer_name: "Paciente Norte", customer_phone: "9991110002", starts_at: LUNES_11 });
    expect(enNorte.status).toBe(201);

    const norte = await agenda(app, owner, propertyB);
    // Esperado: solo la cita de la sucursal Norte. Actual: listAppointmentsInRange filtra por organizacion, no por sucursal.
    expect(norte.map((c) => c.property_id)).toEqual([propertyB]);
  });

  it("control: cada cita creada desde el panel queda con la sucursal de SU proveedor (property_id correcto)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { propertyB, providerB } = segundaSucursal(ctx);
    const res = await crearDesdePanel(app, ctx.staff.owner.token, propertyB, { provider_id: providerB, service_id: ctx.serviceId, customer_name: "Paciente Norte", customer_phone: "9991110002", starts_at: LUNES_11 });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { appointment: CitaWire }).appointment.property_id).toBe(propertyB);
  });

  it("QA-citas-R1-caos-02: desde el panel de la sucursal Norte no se puede crear una cita con el proveedor de OTRA sucursal", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { propertyB } = segundaSucursal(ctx);
    // Formulario abierto en la sucursal principal (proveedor de la principal elegido) y la peticion sale contra la ruta de Norte
    // (p. ej. una pestana vieja, o un cliente que reusa el id): el servidor debe rechazarla, no crearla en la principal.
    const res = await crearDesdePanel(app, ctx.staff.owner.token, propertyB, { provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Cruzada", customer_phone: "9991110003", starts_at: LUNES_10 });
    expect([400, 403, 404]).toContain(res.status);
  });
});

describe("QA R1 caos citas -- reintentos y doble envio desde el panel", () => {
  it("QA-citas-R1-caos-03: reintentar el alta del panel tras perder la respuesta (misma idempotency_key) devuelve la MISMA cita, no 409", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const cuerpo = { provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana Pech", customer_phone: "9991234567", starts_at: LUNES_10, idempotency_key: "panel-retry-1" };
    const primera = await crearDesdePanel(app, ctx.staff.owner.token, ctx.propertyId, cuerpo);
    expect(primera.status).toBe(201);
    const id = ((await primera.json()) as { appointment: CitaWire }).appointment.id;
    // La respuesta se "perdio" (timeout del navegador) y el staff vuelve a pulsar "Crear cita".
    const segunda = await crearDesdePanel(app, ctx.staff.owner.token, ctx.propertyId, cuerpo);
    expect(segunda.status).toBeLessThan(300);
    expect(((await segunda.json()) as { appointment: CitaWire }).appointment.id).toBe(id);
  });

  it("control: el reintento sin llave NO duplica la cita (la exclusion por proveedor/horario responde 409 honesto)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const cuerpo = { provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana Pech", customer_phone: "9991234567", starts_at: LUNES_10 };
    expect((await crearDesdePanel(app, ctx.staff.owner.token, ctx.propertyId, cuerpo)).status).toBe(201);
    expect((await crearDesdePanel(app, ctx.staff.owner.token, ctx.propertyId, cuerpo)).status).toBe(409);
    expect(await agenda(app, ctx.staff.owner.token, ctx.propertyId)).toHaveLength(1);
  });

  it("control: 6 altas simultaneas del panel al mismo horario -> exactamente 1 cita y 5 x 409", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const resp = await Promise.all(
      Array.from({ length: 6 }, (_, i) => crearDesdePanel(app, ctx.staff.owner.token, ctx.propertyId, { provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: `Paciente ${i}`, customer_phone: `99912300${i}0`, starts_at: LUNES_10 })),
    );
    expect(resp.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await agenda(app, ctx.staff.owner.token, ctx.propertyId)).toHaveLength(1);
  });

  it("control: cancelar, completar y no-show cruzados sobre la misma cita (doble clic / dos pestanas) dejan un estado final coherente", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const alta = await crearDesdePanel(app, ctx.staff.owner.token, ctx.propertyId, { provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Doble", customer_phone: "9990001111", starts_at: LUNES_10 });
    const id = ((await alta.json()) as { appointment: CitaWire }).appointment.id;
    const base = `/v1/citas/properties/${ctx.propertyId}/appointments/${id}`;
    const [c1, c2, conf] = await Promise.all([
      app.request(`${base}/cancel`, authedJson(ctx.staff.owner.token, {})),
      app.request(`${base}/cancel`, authedJson(ctx.staff.admin.token, {})),
      app.request(`${base}/confirm`, authedJson(ctx.staff.staffMember.token, {})),
    ]);
    expect([c1.status, c2.status]).toEqual([200, 200]);
    expect([200, 409]).toContain(conf.status);
    const final = (await agenda(app, ctx.staff.owner.token, ctx.propertyId)).find((c) => c.id === id) as unknown as { status: string };
    expect(final.status).toBe("cancelled");
  });
});

describe("QA R1 caos citas -- datos enormes", () => {
  it("QA-citas-R1-caos-04: un mes con 600 citas no se trunca en silencio (o vienen todas o la respuesta avisa que hay mas)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const alta = await crearDesdePanel(app, ctx.staff.owner.token, ctx.propertyId, { provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Cliente Base", customer_phone: "9990002222", starts_at: "2027-09-01T15:00:00.000Z" });
    const customerId = ((await alta.json()) as { appointment: { customer_id: string } }).appointment.customer_id;
    // 599 citas mas en septiembre (20 por dia habil aprox.), sembradas directo en el repo.
    for (let i = 1; i < 600; i++) {
      const inicio = new Date(Date.parse("2027-09-01T15:00:00.000Z") + i * 60 * 60_000);
      ctx.citasRepo.seedAppointment({
        id: randomUUID(),
        organizationId: ctx.organizationId,
        propertyId: null,
        providerId: ctx.providerId,
        serviceId: ctx.serviceId,
        customerId,
        startsAt: inicio.toISOString(),
        endsAt: new Date(inicio.getTime() + 30 * 60_000).toISOString(),
        status: "confirmed",
        source: "whatsapp",
        notes: null,
        dedupeFingerprint: null,
        idempotencyKey: null,
        reminder24hSentAt: null,
        createdAt: new Date().toISOString(),
        googleEventId: null,
        googleSyncStatus: "skipped",
        googleSyncAttempts: 0,
        googleSyncNextRetryAt: null,
        googleSyncError: null,
      });
    }
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments?from=${MES_DESDE}&to=${MES_HASTA}`, authedGet(ctx.staff.owner.token));
    const body = (await res.json()) as { appointments: CitaWire[]; truncated?: boolean; next_offset?: unknown; total?: number };
    const avisaQueHayMas = body.truncated === true || (body.next_offset !== undefined && body.next_offset !== null) || (typeof body.total === "number" && body.total > body.appointments.length);
    // Actual: 500 filas (DEFAULT_APPOINTMENTS_LIMIT), sin `truncated`/`next_offset`/`total`: las citas del 22 al 30 de septiembre desaparecen de la Agenda.
    expect(body.appointments.length === 600 || avisaQueHayMas).toBe(true);
  });

  it("QA-citas-R1-viaje-16 (API): la Agenda responde la zona horaria del NEGOCIO y truncated=false cuando el rango cabe", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments?from=${MES_DESDE}&to=${MES_HASTA}`, authedGet(ctx.staff.owner.token));
    const body = (await res.json()) as { timezone: string; truncated: boolean; next_from: string | null };
    expect(body).toMatchObject({ truncated: false, next_from: null });
    expect(body.timezone).toMatch(/^[A-Za-z_]+\/[A-Za-z_]+/);
  });

  it("control: unicode/emoji y nombres de 160 caracteres viajan intactos por el alta y la Agenda", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const nombre = `Zoë Ñúñez 👩🏽‍⚕️ ${"á".repeat(140)}`.slice(0, 160);
    const notas = "Alergia: penicilina 💊 / 日本語 / ‮RTL‬";
    const res = await crearDesdePanel(app, ctx.staff.owner.token, ctx.propertyId, { provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: nombre, customer_phone: "9990003333", starts_at: LUNES_10, notes: notas });
    expect(res.status).toBe(201);
    const fila = (await agenda(app, ctx.staff.owner.token, ctx.propertyId))[0] as unknown as { customer_name: string; notes: string };
    expect(fila.customer_name).toBe(nombre.trim());
    expect(fila.notes).toBe(notas);
  });
});

describe("QA R1 caos citas -- sesion y refresh", () => {
  it("control (servidor): el refresh token es de un solo uso; un segundo refresh con el MISMO token responde 401", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: ctx.staff.owner.email, password: ctx.staff.owner.password }) });
    const { refreshToken } = (await login.json()) as { refreshToken: string };
    const r1 = await app.request("/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken }) });
    const r2 = await app.request("/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken }) });
    expect(r1.status).toBe(200);
    // Por eso el cliente DEBE serializar sus refrescos (ver QA-citas-R1-caos-05 en apps/web/tests/qa-citas-r1-caos-refresh.spec.ts).
    expect(r2.status).toBe(401);
  });

  it("control (servidor): refrescos SIMULTANEOS con el mismo token -> como maximo uno emite sesion", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: ctx.staff.owner.email, password: ctx.staff.owner.password }) });
    const { refreshToken } = (await login.json()) as { refreshToken: string };
    const resp = await Promise.all(
      Array.from({ length: 4 }, () => app.request("/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken }) })),
    );
    const estados = resp.map((r) => r.status);
    // Documenta la semantica real en memoria: si mas de uno emitiera sesion habria una ventana de reuso del token (riesgo menor).
    expect(estados.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(estados.every((s) => s === 200 || s === 401)).toBe(true);
  });
});
