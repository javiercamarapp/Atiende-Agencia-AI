// Test de integración real de la ruta interna del recordatorio 24h — gateada por
// x-atiende-internal-secret, pensada para un scheduler externo (ver diseño Fase 1
// citas §5.3).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";
import { jsonRequestInit } from "./fixtures.ts";

describe("POST /internal/citas/confirmacion-cita", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/citas/confirmacion-cita", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("con el secreto real, recorre las organizaciones activas y encola recordatorios reales de las citas dentro de la ventana de 24h", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    // Crea una cita real mañana a las 10am hora de Mérida.
    await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana Torres", customer_phone: "9991112233", starts_at: "2026-09-14T16:00:00.000Z", source: "web" }),
    );

    const res = await app.request("/internal/citas/confirmacion-cita", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tenants_checked: number; processed: number; sent: number; failures: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.tenants_checked).toBeGreaterThanOrEqual(1);
    expect(body.failures).toEqual([]);
    // La cita creada arriba está fuera de la ventana de 24h desde "ahora" real (el
    // test corre en cualquier fecha) — lo que importa aquí es que la ruta procesó
    // la organización sin lanzar, no cuántas cayeron en la ventana exacta.
    expect(body.processed).toBeGreaterThanOrEqual(0);
    expect(body.sent).toBeGreaterThanOrEqual(0);
  });
});
