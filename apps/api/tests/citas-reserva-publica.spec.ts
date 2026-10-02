// C-19 -- API publica de la pagina de reservas: catalogo + disponibilidad (sin sesion), sobre la app Hono real con
// InMemoryCitasRepository. Cubre 404 uniforme, negocio no listo, rate limit, origen no permitido y que NINGUNA respuesta
// publica expone PII del personal ni de clientes.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";
import { jsonRequestInit } from "./fixtures.ts";

const SLUG = "clinica-dental-sonrisas";

function proximoLunes(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + (((1 - d.getUTCDay() + 7) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

const ip = (n: string) => ({ "x-forwarded-for": n });

describe("GET /v1/citas/:orgSlug/publico/catalogo", () => {
  it("entrega negocio, zona horaria, servicios y profesionales activos sin sesion", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/${SLUG}/publico/catalogo`, { headers: ip("10.0.0.1") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lista: boolean;
      negocio: { nombre: string; zona_horaria: string };
      servicios: { id: string; nombre: string; duracion_minutos: number; precio_centavos: number | null }[];
      profesionales: { id: string; nombre: string; servicio_ids: string[] }[];
    };
    expect(body.lista).toBe(true);
    expect(body.negocio).toEqual({ nombre: "Clínica Dental Sonrisas", zona_horaria: "America/Merida" });
    expect(body.servicios).toEqual([{ id: ctx.serviceId, nombre: "Consulta general", duracion_minutos: 30, precio_centavos: 50000 }]);
    expect(body.profesionales).toEqual([{ id: ctx.providerId, nombre: "Dra. Fernanda López", servicio_ids: [ctx.serviceId] }]);
  });

  it("no publica servicios inactivos ni profesionales inactivos", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const otroServicio = randomUUID();
    ctx.citasRepo.seedService({ id: otroServicio, organizationId: ctx.organizationId, name: "Servicio apagado", durationMinutes: 20, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: null, isActive: false });
    const otroProveedor = randomUUID();
    ctx.citasRepo.seedProvider({ id: otroProveedor, organizationId: ctx.organizationId, propertyId: null, displayName: "Dr. Inactivo", roleLabel: "x", isActive: false });
    ctx.citasRepo.seedProviderService(otroProveedor, ctx.serviceId);
    const body = (await (await app.request(`/v1/citas/${SLUG}/publico/catalogo`, { headers: ip("10.0.0.2") })).json()) as { servicios: { id: string }[]; profesionales: { id: string }[] };
    expect(body.servicios.map((s) => s.id)).toEqual([ctx.serviceId]);
    expect(body.profesionales.map((p) => p.id)).toEqual([ctx.providerId]);
  });

  it("SIN PII: la respuesta no contiene telefono, correo ni ids de cuentas del personal ni de la organizacion", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const texto = await (await app.request(`/v1/citas/${SLUG}/publico/catalogo`, { headers: ip("10.0.0.3") })).text();
    for (const secreto of [ctx.staff.owner.email, ctx.staff.admin.email, ctx.staff.staffMember.email, ctx.staff.owner.id, ctx.staff.admin.id, ctx.staff.staffMember.id, ctx.organizationId, ctx.propertyId, "1234567890", "Dentista"]) {
      expect(texto).not.toContain(secreto);
    }
    expect(texto).not.toMatch(/phone|telefono|email|correo|user_id|organization_id|property_id/i);
  });

  it("404 uniforme: negocio inexistente e inactivo responden igual", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const a = await app.request("/v1/citas/no-existe/publico/catalogo", { headers: ip("10.0.0.4") });
    expect(a.status).toBe(404);
    ctx.citasRepo.seedOrganization({ id: randomUUID(), slug: "cerrado", name: "Cerrado", defaultTimezone: "America/Merida", isActive: false });
    const b = await app.request("/v1/citas/cerrado/publico/catalogo", { headers: ip("10.0.0.4") });
    expect(b.status).toBe(404);
    expect(await b.text()).toBe(await a.text());
  });

  it("negocio no listo: responde { lista:false, faltan } y ningun dato del negocio", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.updateProvider(ctx.organizationId, ctx.providerId, { isActive: false });
    const res = await app.request(`/v1/citas/${SLUG}/publico/catalogo`, { headers: ip("10.0.0.5") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.lista).toBe(false);
    expect(Array.isArray(body.faltan)).toBe(true);
    expect((body.faltan as string[]).length).toBeGreaterThan(0);
    expect(Object.keys(body).sort()).toEqual(["faltan", "lista"]);
  });

  it("403 con un origen no permitido", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/${SLUG}/publico/catalogo`, { headers: { origin: "https://evil.example", ...ip("10.0.0.6") } });
    expect(res.status).toBe(403);
  });

  it("429 al pasar el limite por IP, y otra IP no se ve afectada", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    let ultimo = 200;
    for (let i = 0; i < 61; i += 1) ultimo = (await app.request(`/v1/citas/${SLUG}/publico/catalogo`, { headers: ip("10.9.9.9") })).status;
    expect(ultimo).toBe(429);
    expect((await app.request(`/v1/citas/${SLUG}/publico/catalogo`, { headers: ip("10.9.9.10") })).status).toBe(200);
  });
});

describe("POST /v1/citas/:orgSlug/publico/disponibilidad", () => {
  const url = `/v1/citas/${SLUG}/publico/disponibilidad`;

  it("devuelve horarios reales de un profesional, con zona horaria y sin PII", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(url, jsonRequestInit({ service_id: ctx.serviceId, provider_id: ctx.providerId, date: proximoLunes() }, ip("10.1.0.1")));
    expect(res.status).toBe(200);
    const texto = await res.text();
    const body = JSON.parse(texto) as { lista: boolean; zona_horaria: string; slots: { starts_at: string; ends_at: string; provider_id: string }[] };
    expect(body.lista).toBe(true);
    expect(body.zona_horaria).toBe("America/Merida");
    expect(body.slots.length).toBeGreaterThan(0);
    expect(body.slots.every((s) => s.provider_id === ctx.providerId)).toBe(true);
    expect(texto).not.toMatch(/phone|telefono|email|correo|customer|user_id|organization_id/i);
  });

  it("sin provider_id une a quienes ofrecen el servicio y cada horario conserva un solo profesional", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const segundo = randomUUID();
    ctx.citasRepo.seedProvider({ id: segundo, organizationId: ctx.organizationId, propertyId: null, displayName: "Dr. Mario Pat", roleLabel: "Dentista", isActive: true });
    ctx.citasRepo.seedProviderService(segundo, ctx.serviceId);
    for (const dayOfWeek of [1]) ctx.citasRepo.seedAvailabilityRule({ id: randomUUID(), providerId: segundo, dayOfWeek, startTime: "17:00", endTime: "18:00", isActive: true });
    const res = await app.request(url, jsonRequestInit({ service_id: ctx.serviceId, date: proximoLunes() }, ip("10.1.0.2")));
    const body = (await res.json()) as { slots: { starts_at: string; provider_id: string }[] };
    const inicios = body.slots.map((s) => s.starts_at);
    expect(new Set(inicios).size).toBe(inicios.length);
    expect(inicios).toEqual([...inicios].sort());
    const proveedores = new Set(body.slots.map((s) => s.provider_id));
    expect(proveedores.has(ctx.providerId)).toBe(true);
    expect(proveedores.has(segundo)).toBe(true);
  });

  it("400 con datos faltantes, ids malformados o fecha invalida", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const casos = [{ date: proximoLunes() }, { service_id: ctx.serviceId }, { service_id: "no-uuid", date: proximoLunes() }, { service_id: ctx.serviceId, date: "mañana" }];
    for (const [i, c] of casos.entries()) {
      const res = await app.request(url, jsonRequestInit(c, ip(`10.1.1.${i}`)));
      expect(res.status, JSON.stringify(c)).toBe(400);
    }
  });

  it("400 si el profesional no ofrece el servicio; 400 si el servicio no existe en 'cualquiera'", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    expect((await app.request(url, jsonRequestInit({ service_id: randomUUID(), provider_id: ctx.providerId, date: proximoLunes() }, ip("10.1.2.1")))).status).toBe(400);
    expect((await app.request(url, jsonRequestInit({ service_id: randomUUID(), date: proximoLunes() }, ip("10.1.2.2")))).status).toBe(400);
  });

  it("404 uniforme con negocio inexistente", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/citas/no-existe/publico/disponibilidad", jsonRequestInit({ service_id: ctx.serviceId, date: proximoLunes() }, ip("10.1.3.1")));
    expect(res.status).toBe(404);
  });

  it("negocio no listo: { lista:false, faltan } sin horarios", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.citasRepo.updateProvider(ctx.organizationId, ctx.providerId, { isActive: false });
    const res = await app.request(url, jsonRequestInit({ service_id: ctx.serviceId, date: proximoLunes() }, ip("10.1.4.1")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.lista).toBe(false);
    expect(Object.keys(body).sort()).toEqual(["faltan", "lista"]);
  });

  it("403 con origen no permitido y 429 al pasar el limite por IP", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const peticion = { service_id: ctx.serviceId, provider_id: ctx.providerId, date: proximoLunes() };
    expect((await app.request(url, jsonRequestInit(peticion, { origin: "https://evil.example", ...ip("10.1.5.1") }))).status).toBe(403);
    let ultimo = 200;
    for (let i = 0; i < 31; i += 1) ultimo = (await app.request(url, jsonRequestInit(peticion, ip("10.1.6.1")))).status;
    expect(ultimo).toBe(429);
  });

  it("una cita web ya tomada deja de aparecer y reservar el mismo horario devuelve 409", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const antes = (await (await app.request(url, jsonRequestInit({ service_id: ctx.serviceId, provider_id: ctx.providerId, date: proximoLunes() }, ip("10.1.7.1")))).json()) as { slots: { starts_at: string }[] };
    const horario = antes.slots[0]!.starts_at;
    const reservar = (tel: string, h: Record<string, string>) =>
      app.request(`/v1/citas/${SLUG}/appointments`, jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana Prueba", customer_phone: tel, starts_at: horario, source: "web" }, h));
    expect((await reservar("+529991112233", ip("10.1.7.2"))).status).toBe(201);
    expect((await reservar("+529994445566", ip("10.1.7.3"))).status).toBe(409);
    const despues = (await (await app.request(url, jsonRequestInit({ service_id: ctx.serviceId, provider_id: ctx.providerId, date: proximoLunes() }, ip("10.1.7.4")))).json()) as { slots: { starts_at: string }[] };
    expect(despues.slots.map((s) => s.starts_at)).not.toContain(horario);
  });
});
