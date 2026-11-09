// QA ronda 1 (citas, lente AUTOMATIZACION) -- crons /internal de citas: latido del cron de calendario con errores reales (08),
// kill switch y secreto por cron (cobertura).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { InMemorySaludRepository } from "@atiende/db";
import { createAppointment, FakeGoogleCalendarPort } from "@atiende/domain-citas";
import { buildApp } from "../src/app.ts";
import { createPlatformSwitchGuard } from "../src/platform-switches.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";

const CRONS_CITAS = ["/internal/citas/confirmacion-cita", "/internal/citas/email-dispatch", "/internal/citas/google-calendar-sync"] as const;

describe("QA-citas-R1-automatizacion-08: cron de Google Calendar con errores reales", () => {
  it("una cita que no se pudo sincronizar deja el latido del cron en error (no en verde)", async () => {
    const port = new FakeGoogleCalendarPort();
    const ctx = await buildCitasTestContext(buildApp, { googleCalendarPort: port });
    const app = buildApp(ctx.deps);
    const saludRepo = ctx.deps.saludRepo as InMemorySaludRepository;
    const superadminId = randomUUID();
    saludRepo.addPlatformSuperadmin(superadminId);

    const connectRes = await app.request(`/v1/citas/properties/${ctx.propertyId}/providers/${ctx.providerId}/google-calendar/connect`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    const { authorize_url } = (await connectRes.json()) as { authorize_url: string };
    const state = new URL(authorize_url).searchParams.get("state")!;
    await app.request(`/v1/citas/google-calendar/oauth-callback?code=fake-auth-code&state=${encodeURIComponent(state)}`);

    await createAppointment(ctx.citasRepo, { organizationId: ctx.organizationId, providerId: ctx.providerId, serviceId: ctx.serviceId, customerName: "Ana", customerPhone: "9991112233", startsAt: "2026-09-14T16:00:00.000Z", source: "web" });
    port.failNextCall = new Error("Google Calendar timeout");

    const res = await app.request("/internal/citas/google-calendar-sync", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; errors: unknown[] };
    expect(body.errors).toHaveLength(1);
    // Mismo contrato que /internal/citas/confirmacion-cita: un fallo real por cita => ok:false + latido "error".
    expect(body.ok).toBe(false);
    const latido = (await saludRepo.listCronHeartbeatsForSuperadmin(superadminId)).find((l) => l.cronName === "/internal/citas/google-calendar-sync");
    expect(latido?.lastStatus).toBe("error");
  });
});

describe("cobertura: kill switch y secreto de los 3 crons de citas", () => {
  for (const path of CRONS_CITAS) {
    it(`${path}: pausado por interruptor responde skipped:kill_switch y no corre`, async () => {
      const ctx = await buildCitasTestContext(buildApp);
      const guard = createPlatformSwitchGuard(async () => [{ scope: "cron", target: path }]);
      const app = buildApp({ ...ctx.deps, platformSwitchGuard: guard });
      const res = await app.request(path, { method: "GET", headers: { authorization: `Bearer ${ctx.deps.env.internalSecret}` } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ skipped: "kill_switch" });
    });

    it(`${path}: sin secreto responde 401`, async () => {
      const ctx = await buildCitasTestContext(buildApp);
      const res = await buildApp(ctx.deps).request(path, { method: "GET" });
      expect(res.status).toBe(401);
    });
  }

  it("el interruptor GLOBAL 'crons' tambien detiene el recordatorio de citas", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const guard = createPlatformSwitchGuard(async () => [{ scope: "global", target: "crons" }]);
    const app = buildApp({ ...ctx.deps, platformSwitchGuard: guard });
    const res = await app.request("/internal/citas/confirmacion-cita", { method: "GET", headers: { authorization: `Bearer ${ctx.deps.env.internalSecret}` } });
    expect(await res.json()).toMatchObject({ skipped: "kill_switch" });
  });
});
