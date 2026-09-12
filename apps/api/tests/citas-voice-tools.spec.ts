// Fase 2 §1 — Server Tools HTTP reales para el agente de voz de ElevenLabs.
// Mismo patrón de test que apps/api/tests/voice-tools.spec.ts (restaurantes): HTTP
// real vía `app.request`, sobre fixtures reales in-memory, sin mocks de la lógica
// de negocio.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";

const TOOL_SECRET_HEADERS = { "x-atiende-tool-secret": "test-voice-tool-secret" };

describe("POST /v1/citas/:orgSlug/availability — consultar_disponibilidad", () => {
  it("401 sin el secreto de la herramienta de voz", async () => {
    const { deps } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/availability", jsonRequestInit({ provider_id: "x", service_id: "y", date: "2026-09-14" }));
    expect(res.status).toBe(401);
  });

  it("404 con un negocio que no existe, incluso con el secreto correcto", async () => {
    const { deps } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const res = await app.request("/v1/citas/no-existe/availability", jsonRequestInit({ provider_id: "x", service_id: "y", date: "2026-09-14" }, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(404);
  });

  it("400 si falta cualquiera de provider_id/service_id/date", async () => {
    const { deps, providerId, serviceId } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/availability", jsonRequestInit({ provider_id: providerId, service_id: serviceId }, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(400);
  });

  it("400 con un formato de date inválido — GUARDIA anti-manipulación de fecha (nunca llega a zonedTimeToUtc)", async () => {
    const { deps, providerId, serviceId } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/availability", jsonRequestInit({ provider_id: providerId, service_id: serviceId, date: "mañana" }, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(400);
  });

  it("devuelve slots reales calculados server-side — nunca inventados", async () => {
    const { deps, providerId, serviceId } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    // Próximo lunes real, para no depender de qué día corre la suite.
    const now = new Date();
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    monday.setUTCDate(monday.getUTCDate() + (((1 - monday.getUTCDay() + 7) % 7) || 7));
    const dateStr = monday.toISOString().slice(0, 10);

    const res = await app.request("/v1/citas/clinica-dental-sonrisas/availability", jsonRequestInit({ provider_id: providerId, service_id: serviceId, date: dateStr }, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slots: Array<{ starts_at: string; ends_at: string }> };
    expect(body.slots.length).toBeGreaterThan(0);
  });

  it("400 si el proveedor no ofrece el servicio", async () => {
    const { deps, providerId } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/citas/clinica-dental-sonrisas/availability",
      jsonRequestInit({ provider_id: providerId, service_id: randomUUID(), date: "2026-09-14" }, TOOL_SECRET_HEADERS),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/citas/:orgSlug/services — listar_servicios", () => {
  it("401 sin el secreto de la herramienta de voz", async () => {
    const { deps } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/services", jsonRequestInit({}));
    expect(res.status).toBe(401);
  });

  it("lista solo servicios activos reales — nunca inventados", async () => {
    const { deps, serviceId } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/services", jsonRequestInit({}, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { services: Array<{ id: string; name: string; duration_minutes: number }> };
    expect(body.services.map((s) => s.id)).toContain(serviceId);
    expect(body.services[0]).toMatchObject({ name: "Consulta general", duration_minutes: 30 });
  });
});

describe("POST /v1/citas/:orgSlug/providers — listar_proveedores", () => {
  it("401 sin el secreto de la herramienta de voz", async () => {
    const { deps } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/providers", jsonRequestInit({}));
    expect(res.status).toBe(401);
  });

  it("lista proveedores reales activos, filtrando por service_id cuando se manda", async () => {
    const { deps, providerId, serviceId } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/providers", jsonRequestInit({ service_id: serviceId }, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: Array<{ id: string; display_name: string }> };
    expect(body.providers.map((p) => p.id)).toEqual([providerId]);
  });

  it("un service_id inexistente devuelve lista vacía, nunca un error ni una lista sin filtrar", async () => {
    const { deps } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/providers", jsonRequestInit({ service_id: randomUUID() }, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(200);
    expect((await res.json()) as { providers: unknown[] }).toEqual({ providers: [] });
  });
});

describe("POST /v1/citas/:orgSlug/customers/appointments — buscar_citas_cliente (el de mayor riesgo real)", () => {
  it("401 sin el secreto de la herramienta de voz", async () => {
    const { deps } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/customers/appointments", jsonRequestInit({ customer_phone: "9991234567" }));
    expect(res.status).toBe(401);
  });

  it("400 si falta customer_phone", async () => {
    const { deps } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/customers/appointments", jsonRequestInit({}, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(400);
  });

  it("CONTRATO DE SILENCIO: un teléfono nunca visto en esta organización devuelve lista vacía, nunca un error ni datos de otro cliente", async () => {
    const { deps } = await buildCitasTestContext(buildApp);
    const app = buildApp(deps);
    const res = await app.request("/v1/citas/clinica-dental-sonrisas/customers/appointments", jsonRequestInit({ customer_phone: "+52 999 000 0000" }, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(200);
    expect((await res.json()) as { appointments: unknown[] }).toEqual({ appointments: [] });
  });

  it("GUARDIA DE IDENTIDAD: devuelve solo las citas reales del teléfono pedido — un número no puede ver las citas de otro", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    // Crea una cita real para el cliente A vía el flujo normal (POST público
    // /v1/citas/:orgSlug/appointments, fuente=web) — no seedAppointment directo,
    // para ejercitar el pipeline real de principio a fin.
    const createRes = await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit(
        {
          provider_id: ctx.providerId,
          service_id: ctx.serviceId,
          customer_name: "Cliente A",
          customer_phone: "9991111111",
          starts_at: (() => {
            const now = new Date();
            const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
            monday.setUTCDate(monday.getUTCDate() + (((1 - monday.getUTCDay() + 7) % 7) || 7));
            const y = monday.getUTCFullYear();
            const m = String(monday.getUTCMonth() + 1).padStart(2, "0");
            const d = String(monday.getUTCDate()).padStart(2, "0");
            // 10:00 America/Merida ~ 16:00 UTC (sin DST) — suficiente para un test
            // determinista dentro de la ventana 09:00-17:00 sembrada por el fixture.
            return `${y}-${m}-${d}T16:00:00.000Z`;
          })(),
        },
        { origin: "http://localhost:5173" },
      ),
    );
    expect(createRes.status).toBe(201);

    const resA = await app.request("/v1/citas/clinica-dental-sonrisas/customers/appointments", jsonRequestInit({ customer_phone: "9991111111" }, TOOL_SECRET_HEADERS));
    const bodyA = (await resA.json()) as { appointments: unknown[] };
    expect(bodyA.appointments).toHaveLength(1);

    const resB = await app.request("/v1/citas/clinica-dental-sonrisas/customers/appointments", jsonRequestInit({ customer_phone: "9992222222" }, TOOL_SECRET_HEADERS));
    const bodyB = (await resB.json()) as { appointments: unknown[] };
    expect(bodyB.appointments).toHaveLength(0);
  });
});
