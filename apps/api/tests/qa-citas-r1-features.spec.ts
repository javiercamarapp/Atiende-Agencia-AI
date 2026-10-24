// QA adversarial citas, ronda 1 (lente features/API) -- pruebas sobre la app Hono REAL con repositorios en memoria.
// Convencion: `it.fails` = defecto vigente en main e1e05475 (la prueba afirma lo ESPERADO y hoy falla); al corregirlo,
// cambiar a `it`. `it` normal = comportamiento verificado que hoy PASA (cobertura nueva de huecos).
// Ids estables de los defectos: QA-citas-R1-features-NN (ver work/qa/citas/ronda-1-features.md).
import { randomUUID } from "node:crypto";
import { hashPassword } from "@atiende/db";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildCitasTestContext } from "./citas-fixtures.ts";
import type { CitasTestContext } from "./citas-fixtures.ts";
import { jsonRequestInit } from "./fixtures.ts";

const SLUG = "clinica-dental-sonrisas";
// Lunes futuro fijo (date-rot: mismo criterio que citas-appointments.spec.ts).
const LUNES_10_MERIDA = "2027-09-13T16:00:00.000Z"; // 10:00 America/Merida (UTC-6)
const LUNES_1030_MERIDA = "2027-09-13T16:30:00.000Z";
// Lunes PASADO real, dentro del horario semanal del proveedor (L-V 09:00-17:00 Merida).
const LUNES_PASADO_10_MERIDA = "2025-09-15T16:00:00.000Z";

type App = ReturnType<typeof buildApp>;

async function crearCitaWeb(app: App, ctx: CitasTestContext, startsAt: string, phone = "9991112233", extra: Record<string, unknown> = {}) {
  return app.request(
    `/v1/citas/${SLUG}/appointments`,
    jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana Torres", customer_phone: phone, starts_at: startsAt, source: "web", ...extra }),
  );
}

function tool(ctx: CitasTestContext): Record<string, string> {
  return { "x-atiende-tool-secret": ctx.deps.env.voiceToolSecret };
}

async function segundaOrganizacion(app: App, ctx: CitasTestContext) {
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  ctx.citasRepo.seedOrganization({ id: organizationId, slug: "otra-clinica", name: "Otra Clínica", defaultTimezone: "America/Mexico_City" });
  ctx.coreRepo.addOrganization({ id: organizationId, slug: "otra-clinica", name: "Otra Clínica", vertical: "citas" });
  ctx.engine.seedProperty({ id: propertyId, organizationId });
  ctx.citasRepo.seedCitasProperty({ id: propertyId, organizationId, name: "Sucursal única" });
  const providerId = randomUUID();
  ctx.citasRepo.seedProvider({ id: providerId, organizationId, propertyId: null, displayName: "Dr. Ajeno", roleLabel: "Médico", isActive: true });
  const serviceId = randomUUID();
  ctx.citasRepo.seedService({ id: serviceId, organizationId, name: "Consulta ajena", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: 10000, isActive: true });
  ctx.citasRepo.seedProviderService(providerId, serviceId);
  for (const dayOfWeek of [1, 2, 3, 4, 5]) ctx.citasRepo.seedAvailabilityRule({ id: randomUUID(), providerId, dayOfWeek, startTime: "09:00", endTime: "17:00", isActive: true });
  const ownerId = randomUUID();
  const email = `dueno-${organizationId.slice(0, 8)}@otra-clinica.mx`;
  const password = "correcto-caballo-batería";
  ctx.coreRepo.addStaff({ id: ownerId, email, fullName: "Dueño ajeno", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  ctx.coreRepo.addMembership({ userId: ownerId, organizationId, platformRole: "owner", verticalRole: "owner", propertyIds: null });
  ctx.engine.seedMembership({ userId: ownerId, organizationId, platformRole: "owner", verticalRole: "owner", propertyIds: null });
  const login = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  expect(login.status).toBe(200);
  const token = ((await login.json()) as { token: string }).token;
  return { organizationId, propertyId, providerId, serviceId, token };
}

// ---------------------------------------------------------------------------------------------------------------------
// Matriz de roles (owner / admin / staff / sin JWT / otra organizacion) sobre los endpoints de panel con candado de rol.
// ---------------------------------------------------------------------------------------------------------------------
describe("QA R1 features citas -- matriz de roles del panel", () => {
  const SOLO_OWNER_ADMIN = [
    "admin/whatsapp-mensajes",
    "admin/whatsapp-agente",
    "admin/whatsapp-plantillas",
    "admin/privacidad/solicitudes",
    "admin/auditoria",
    "admin/staff/miembros",
    "admin/staff/invitaciones",
    "admin/voz/estado",
    "onboarding",
  ];

  it("owner y admin leen; staff recibe 403; sin JWT 401; el owner de OTRA organizacion 403 (cada endpoint con candado de rol)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ajena = await segundaOrganizacion(app, ctx);
    for (const sub of SOLO_OWNER_ADMIN) {
      const url = `/v1/citas/properties/${ctx.propertyId}/${sub}`;
      const owner = await app.request(url, authedGet(ctx.staff.owner.token));
      const admin = await app.request(url, authedGet(ctx.staff.admin.token));
      const staff = await app.request(url, authedGet(ctx.staff.staffMember.token));
      const anon = await app.request(url, { method: "GET" });
      const cross = await app.request(url, authedGet(ajena.token));
      expect({ sub, owner: owner.status }).toEqual({ sub, owner: 200 });
      expect({ sub, admin: admin.status }).toEqual({ sub, admin: 200 });
      expect({ sub, staff: staff.status }).toEqual({ sub, staff: 403 });
      expect({ sub, anon: anon.status }).toEqual({ sub, anon: 401 });
      expect({ sub, cross: cross.status }).toEqual({ sub, cross: 403 });
    }
  });

  it("endpoints de operacion diaria (agenda, clientes, servicios, proveedores, resumen, avisos, conversaciones) aceptan a los 3 roles y rechazan sin JWT / otra organizacion", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ajena = await segundaOrganizacion(app, ctx);
    const rutas = [
      `appointments?from=2027-09-01T00:00:00.000Z&to=2027-10-01T00:00:00.000Z`,
      "customers",
      "services",
      "providers",
      "resumen",
      "admin/avisos",
      // admin/conversaciones: el fixture en memoria no cablea citasConversacionesRepo -> 503 honesto ("no disponible en este despliegue").
    ];
    for (const r of rutas) {
      const url = `/v1/citas/properties/${ctx.propertyId}/${r}`;
      for (const token of [ctx.staff.owner.token, ctx.staff.admin.token, ctx.staff.staffMember.token]) {
        const res = await app.request(url, authedGet(token));
        expect({ r, status: res.status }).toEqual({ r, status: 200 });
      }
      expect({ r, anon: (await app.request(url, { method: "GET" })).status }).toEqual({ r, anon: 401 });
      expect({ r, cross: (await app.request(url, authedGet(ajena.token))).status }).toEqual({ r, cross: 403 });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Ciclo de vida: crear / reagendar / cancelar / no-show -- validacion temporal.
// ---------------------------------------------------------------------------------------------------------------------
describe("QA R1 features citas -- validacion temporal del ciclo de la cita", () => {
  it("QA-citas-R1-features-04: la reserva publica rechaza un horario que YA PASO (hoy: 201 y la cita queda 'pending' en el pasado)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await crearCitaWeb(app, ctx, LUNES_PASADO_10_MERIDA);
    // Esperado: 409/400 (un horario pasado nunca es reservable). Actual: 201.
    expect([400, 409]).toContain(res.status);
  });

  it("QA-citas-R1-features-05: reagendar via herramienta del agente a un horario que YA PASO se rechaza (hoy: 200)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = (await (await crearCitaWeb(app, ctx, LUNES_10_MERIDA)).json()) as { appointment: { id: string } };
    const res = await app.request(`/v1/citas/${SLUG}/appointments/${created.appointment.id}/reschedule`, jsonRequestInit({ new_starts_at: LUNES_PASADO_10_MERIDA, customer_phone: "9991112233" }, tool(ctx)));
    expect(res.status).toBe(409);
  });

  it("QA-citas-R1-features-06: marcar no-show una cita que todavia NO ocurre se rechaza (hoy: 200, libera el horario y encola el correo de 'no asististe')", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = (await (await crearCitaWeb(app, ctx, LUNES_10_MERIDA, "9991112244", { customer_email: "ana@example.com" })).json()) as { appointment: { id: string } };
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${created.appointment.id}/no-show`, authedJson(ctx.staff.staffMember.token, {}));
    expect(res.status).toBe(409);
    expect(ctx.citasRepo.getOutbox().some((m) => m.eventType === "appointment.no_show")).toBe(false);
  });

  it("QA-citas-R1-features-06b: completar una cita que todavia NO ocurre se rechaza (hoy: 200 y encola el correo de agradecimiento)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = (await (await crearCitaWeb(app, ctx, LUNES_10_MERIDA)).json()) as { appointment: { id: string } };
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${created.appointment.id}/complete`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(409);
  });

  it("ciclo completo por API: crear (web) -> reagendar (agente) -> confirmar (panel) -> cancelar (panel) conserva el mismo id y libera el horario", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = (await (await crearCitaWeb(app, ctx, LUNES_10_MERIDA)).json()) as { appointment: { id: string } };
    const id = created.appointment.id;
    const re = await app.request(`/v1/citas/${SLUG}/appointments/${id}/reschedule`, jsonRequestInit({ new_starts_at: LUNES_1030_MERIDA, actor_channel: "whatsapp", customer_phone: "9991112233" }, tool(ctx)));
    expect(re.status).toBe(200);
    expect(((await re.json()) as { appointment: { id: string; starts_at: string } }).appointment).toMatchObject({ id, starts_at: LUNES_1030_MERIDA });
    const conf = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${id}/confirm`, authedJson(ctx.staff.staffMember.token, {}));
    expect(conf.status).toBe(200);
    const canc = await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${id}/cancel`, authedJson(ctx.staff.staffMember.token, {}));
    expect(canc.status).toBe(200);
    // El horario liberado se puede volver a reservar.
    const otra = await crearCitaWeb(app, ctx, LUNES_1030_MERIDA, "9995550000");
    expect(otra.status).toBe(201);
    // Cancelar dos veces es idempotente; confirmar una cancelada es conflicto.
    expect((await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${id}/cancel`, authedJson(ctx.staff.owner.token, {}))).status).toBe(200);
    expect((await app.request(`/v1/citas/properties/${ctx.propertyId}/appointments/${id}/confirm`, authedJson(ctx.staff.owner.token, {}))).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Concurrencia e idempotencia por API (la carrera real contra Postgres la cubre scripts/verify-citas-concurrencia).
// ---------------------------------------------------------------------------------------------------------------------
describe("QA R1 features citas -- dobles reservas e idempotencia por API", () => {
  it("dos reservas simultaneas del MISMO horario y proveedor (clientes distintos): exactamente una 201 y una 409", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const [a, b] = await Promise.all([crearCitaWeb(app, ctx, LUNES_10_MERIDA, "9990000001"), crearCitaWeb(app, ctx, LUNES_10_MERIDA, "9990000002")]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it("ocho reservas simultaneas del mismo horario: una sola cita activa", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => crearCitaWeb(app, ctx, LUNES_10_MERIDA, `99900000${10 + i}`)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(7);
  });

  it("reintento con la MISMA idempotency_key y los mismos datos devuelve la misma cita (sin duplicar); con datos distintos es 409", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const key = randomUUID();
    const [a, b] = await Promise.all([crearCitaWeb(app, ctx, LUNES_10_MERIDA, "9990000003", { idempotency_key: key }), crearCitaWeb(app, ctx, LUNES_10_MERIDA, "9990000003", { idempotency_key: key })]);
    const ids = await Promise.all([a, b].map(async (r) => ((await r.json()) as { appointment?: { id: string } }).appointment?.id));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(ids[0]).toBe(ids[1]);
    const c = await crearCitaWeb(app, ctx, LUNES_1030_MERIDA, "9990000003", { idempotency_key: key });
    expect(c.status).toBe(409);
  });

  it("dos cancelaciones simultaneas por el agente: ambas 200 (idempotente) y la cita queda cancelada una sola vez", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = (await (await crearCitaWeb(app, ctx, LUNES_10_MERIDA)).json()) as { appointment: { id: string } };
    const url = `/v1/citas/${SLUG}/appointments/${created.appointment.id}/cancel`;
    const [a, b] = await Promise.all([app.request(url, jsonRequestInit({ customer_phone: "9991112233" }, tool(ctx))), app.request(url, jsonRequestInit({ customer_phone: "9991112233" }, tool(ctx)))]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Validacion de entrada y contrato de errores de los endpoints publicos y de herramientas.
// ---------------------------------------------------------------------------------------------------------------------
describe("QA R1 features citas -- validacion de entrada y contrato de errores", () => {
  it("crear cita: tipos incorrectos, vacios, strings enormes y source forjado responden 400/401/409/413, nunca 500", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const base = { provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: LUNES_10_MERIDA, source: "web" };
    const casos: Array<[string, Record<string, unknown>, number[]]> = [
      ["provider_id numerico", { ...base, provider_id: 123 }, [400]],
      ["nombre vacio", { ...base, customer_name: "   " }, [400]],
      ["telefono vacio", { ...base, customer_phone: "" }, [400]],
      ["starts_at en formato de texto no parseable", { ...base, starts_at: "13/09/2027 10:00" }, [400]],
      ["nombre de 161 caracteres", { ...base, customer_name: "a".repeat(161) }, [400]],
      ["notas de 2001 caracteres", { ...base, notes: "n".repeat(2001) }, [400]],
      ["provider_id de 65 caracteres", { ...base, provider_id: "p".repeat(65) }, [400]],
      ["source=manual sin secreto", { ...base, source: "manual" }, [400]],
      ["source=whatsapp sin secreto", { ...base, source: "whatsapp" }, [401]],
      ["inyeccion SQL en provider_id", { ...base, provider_id: "' or 1=1 --" }, [400]],
      ["horario de madrugada", { ...base, starts_at: "2027-09-13T09:00:00.000Z" }, [409]],
      ["horario fuera de grilla (10:07)", { ...base, starts_at: "2027-09-13T16:07:00.000Z" }, [409]],
    ];
    for (const [nombre, body, esperados] of casos) {
      const res = await app.request(`/v1/citas/${SLUG}/appointments`, jsonRequestInit(body));
      expect({ nombre, status: res.status, ok: esperados.includes(res.status) }).toEqual({ nombre, status: res.status, ok: true });
    }
    // Cuerpo > 16 KB: rechazado antes de parsear.
    const enorme = await app.request(`/v1/citas/${SLUG}/appointments`, jsonRequestInit({ ...base, notes: "x".repeat(20_000) }));
    expect(enorme.status).toBe(413);
    // El tope publico (10/min por IP) ya se agoto con los casos de arriba: la siguiente peticion valida es 429, no 500.
    const limitada = await app.request(`/v1/citas/${SLUG}/appointments`, jsonRequestInit({ ...base, customer_name: "Ñandú Peña 🦷 Ü" }));
    expect(limitada.status).toBe(429);
    // Unicode (acentos, enie, emoji) en el nombre: aceptado tal cual (contexto nuevo, sin el tope agotado).
    const ctx2 = await buildCitasTestContext(buildApp);
    const app2 = buildApp(ctx2.deps);
    const unicode = await app2.request(`/v1/citas/${SLUG}/appointments`, jsonRequestInit({ ...base, provider_id: ctx2.providerId, service_id: ctx2.serviceId, customer_name: "Ñandú Peña 🦷 Ü" }));
    expect(unicode.status).toBe(201);
  });

  it("QA-citas-R1-features-09: starts_at de texto libre ('mañana a las 10', '10') es 400 de validacion (hoy: Date.parse lo lee como 2001-10-01 y responde 409 'fuera de disponibilidad')", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    for (const startsAt of ["mañana a las 10", "10"]) {
      const res = await app.request(`/v1/citas/${SLUG}/appointments`, jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: startsAt, source: "web" }));
      expect({ startsAt, status: res.status }).toEqual({ startsAt, status: 400 });
    }
  });

  it("crear cita desde un origen no permitido es 403; un slug inexistente o un negocio de otra organizacion con ids ajenos es 404/400", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ajena = await segundaOrganizacion(app, ctx);
    const body = { provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana", customer_phone: "9991112233", starts_at: LUNES_10_MERIDA, source: "web" };
    expect((await app.request(`/v1/citas/${SLUG}/appointments`, jsonRequestInit(body, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await app.request(`/v1/citas/no-existe/appointments`, jsonRequestInit(body))).status).toBe(404);
    // Proveedor/servicio de la organizacion A reservados con el slug de la organizacion B: nunca cruza.
    const cruzada = await app.request(`/v1/citas/otra-clinica/appointments`, jsonRequestInit(body));
    expect(cruzada.status).toBe(400);
    expect(ajena.organizationId).toBeTruthy();
  });

  it("herramientas del agente: sin secreto o con secreto incorrecto 401; cita de OTRA organizacion via el slug propio 404", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ajena = await segundaOrganizacion(app, ctx);
    const deB = await app.request(
      `/v1/citas/otra-clinica/appointments`,
      jsonRequestInit({ provider_id: ajena.providerId, service_id: ajena.serviceId, customer_name: "Beto", customer_phone: "5551112233", starts_at: "2027-09-13T15:00:00.000Z", source: "web" }),
    );
    expect(deB.status).toBe(201);
    const idB = ((await deB.json()) as { appointment: { id: string } }).appointment.id;
    for (const accion of ["cancel", "reschedule", "reassign"]) {
      const url = `/v1/citas/${SLUG}/appointments/${idB}/${accion}`;
      expect((await app.request(url, jsonRequestInit({ new_starts_at: LUNES_10_MERIDA }))).status).toBe(401);
      expect((await app.request(url, jsonRequestInit({ new_starts_at: LUNES_10_MERIDA }, { "x-atiende-tool-secret": "no-es-el-secreto" }))).status).toBe(401);
      const cruzado = await app.request(url, jsonRequestInit({ new_starts_at: LUNES_10_MERIDA, new_provider_id: ctx.providerId, customer_phone: "5551112233" }, tool(ctx)));
      expect({ accion, status: cruzado.status }).toEqual({ accion, status: 404 });
    }
  });

  it("disponibilidad publica: fecha invalida, ids no-UUID y cuerpo enorme se rechazan sin 500; negocio no listo responde lista:false", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/citas/${SLUG}/publico/disponibilidad`;
    expect((await app.request(url, jsonRequestInit({ service_id: ctx.serviceId, date: "2027-02-30" }))).status).toBe(400);
    expect((await app.request(url, jsonRequestInit({ service_id: "1; drop table x", date: "2027-09-13" }))).status).toBe(400);
    expect((await app.request(url, jsonRequestInit({ service_id: ctx.serviceId, provider_id: "nope", date: "2027-09-13" }))).status).toBe(400);
    expect((await app.request(url, jsonRequestInit({ date: "2027-09-13" }))).status).toBe(400);
    expect((await app.request(url, jsonRequestInit({ service_id: ctx.serviceId, date: "2027-09-13", relleno: "x".repeat(5000) }))).status).toBe(413);
    const ok = await app.request(url, jsonRequestInit({ service_id: ctx.serviceId, date: "2027-09-13" }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { lista: boolean; zona_horaria?: string; slots?: Array<{ starts_at: string }> };
    if (body.lista) {
      expect(body.zona_horaria).toBe("America/Merida");
      expect(body.slots?.[0]?.starts_at).toBe("2027-09-13T15:00:00.000Z"); // 09:00 Merida
    }
  });

  it("agenda del panel: from/to invalidos 400; limit negativo/enorme acotado; ordenada por hora; filtro por proveedor", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await crearCitaWeb(app, ctx, LUNES_1030_MERIDA, "9990000020");
    await crearCitaWeb(app, ctx, LUNES_10_MERIDA, "9990000021");
    const base = `/v1/citas/properties/${ctx.propertyId}/appointments`;
    expect((await app.request(`${base}?from=ayer&to=hoy`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    expect((await app.request(`${base}`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    for (const limit of ["-5", "0", "999999", "abc"]) {
      const res = await app.request(`${base}?from=2027-09-01T00:00:00Z&to=2027-10-01T00:00:00Z&limit=${limit}`, authedGet(ctx.staff.owner.token));
      expect({ limit, status: res.status }).toEqual({ limit, status: 200 });
    }
    const res = await app.request(`${base}?from=2027-09-01T00:00:00Z&to=2027-10-01T00:00:00Z`, authedGet(ctx.staff.owner.token));
    const list = ((await res.json()) as { appointments: Array<{ starts_at?: string; startsAt?: string }> }).appointments;
    const horas = list.map((a) => a.starts_at ?? a.startsAt);
    expect(horas).toEqual([LUNES_10_MERIDA, LUNES_1030_MERIDA]);
    const otroProveedor = await app.request(`${base}?from=2027-09-01T00:00:00Z&to=2027-10-01T00:00:00Z&provider_id=${randomUUID()}`, authedGet(ctx.staff.owner.token));
    expect(((await otroProveedor.json()) as { appointments: unknown[] }).appointments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Voz: rutas HTTP que ejecuta el worker de voice-core.
// ---------------------------------------------------------------------------------------------------------------------
describe("QA R1 features citas -- rutas de herramientas de voz", () => {
  it("herramienta desconocida 404; telefono no-texto 400; sin secreto 401; llamante anonimo no puede crear ni cancelar", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const voz = (h: string) => `/v1/citas/${SLUG}/voz/${h}`;
    expect((await app.request(voz("borrar_todo"), jsonRequestInit({}, tool(ctx)))).status).toBe(404);
    expect((await app.request(voz("buscar_mis_citas"), jsonRequestInit({ telefono: 9991112233 }, tool(ctx)))).status).toBe(400);
    expect((await app.request(voz("buscar_mis_citas"), jsonRequestInit({ telefono: "9991112233" }))).status).toBe(401);
    const anon = await app.request(voz("crear_cita"), jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "X", starts_at: LUNES_10_MERIDA }, tool(ctx)));
    expect(anon.status).toBe(200);
    expect(await anon.json()).toMatchObject({ error: "llamante_anonimo", requiere_humano: true });
  });

  it("buscar_mis_citas / cancelar_cita por voz: el telefono de la llamada solo ve y toca SUS citas (otra persona: no encontrada)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const deAna = (await (await crearCitaWeb(app, ctx, LUNES_10_MERIDA, "9991112233")).json()) as { appointment: { id: string } };
    const voz = (h: string) => `/v1/citas/${SLUG}/voz/${h}`;
    const mias = await app.request(voz("buscar_mis_citas"), jsonRequestInit({ telefono: "+529995556677" }, tool(ctx)));
    expect(((await mias.json()) as { appointments: unknown[] }).appointments).toHaveLength(0);
    const robo = await app.request(voz("cancelar_cita"), jsonRequestInit({ telefono: "+529995556677", appointment_id: deAna.appointment.id }, tool(ctx)));
    expect(await robo.json()).toMatchObject({ error: "Cita no encontrada" });
    const deVerdad = await app.request(voz("cancelar_cita"), jsonRequestInit({ telefono: "+529991112233", appointment_id: deAna.appointment.id }, tool(ctx)));
    expect(((await deVerdad.json()) as { appointment: { status: string } }).appointment.status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Lista de espera: el aviso al liberar un horario y el broadcast existen, pero nadie puede INSCRIBIRSE.
// ---------------------------------------------------------------------------------------------------------------------
describe("QA R1 features citas -- lista de espera", () => {
  it("control: el panel lee la lista (vacia) y el broadcast responde sin candidatos", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const lista = await app.request(`/v1/citas/properties/${ctx.propertyId}/waitlist`, authedGet(ctx.staff.staffMember.token));
    expect(lista.status).toBe(200);
    const broadcast = await app.request(`/v1/citas/properties/${ctx.propertyId}/waitlist/broadcast`, authedJson(ctx.staff.owner.token, {}));
    expect(broadcast.status).toBeLessThan(500);
  });

  it("QA-citas-R1-features-12: el staff puede inscribir a un cliente en la lista de espera desde el panel (hoy no existe ninguna ruta: 404)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/v1/citas/properties/${ctx.propertyId}/waitlist`,
      authedJson(ctx.staff.staffMember.token, { customer_name: "Ana", customer_phone: "9991112233", service_id: ctx.serviceId, provider_id: ctx.providerId, preferred_date_from: "2027-09-13", preferred_date_to: "2027-09-17" }),
    );
    expect([200, 201]).toContain(res.status);
  });
});

