// Fase 9 — GET/POST /internal/rentas/email-dispatch: drena el canal `email` de
// `rentas.messaging_outbox` vía Resend. Mismo patrón/guard que
// citas-email-dispatch.spec.ts/hoteles-email-dispatch.spec.ts (leídos primero como
// plantilla) -- hallazgo de auditoría: esta ruta solo aceptaba POST, así que Vercel
// Cron (que únicamente dispara GET) nunca la ejecutaba en producción.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

describe("GET/POST /internal/rentas/email-dispatch", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/email-dispatch", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("fail-closed: sin RESEND_API_KEY configurada, un job pendiente se procesa y falla explícito (nunca 'sent')", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.rentasRepo.enqueueMessagingOutbox(ctx.propertyId, ctx.organizationId, "email", "reserva.recordatorio_checkin", "dedupe-test-1", {
      to: "huesped@example.com",
      subject: "Asunto",
      html: "<p>hola</p>",
      text: "hola",
    });

    const res = await app.request("/internal/rentas/email-dispatch", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; sent: number; failed: number };
    expect(body.processed).toBe(1);
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(1);

    const job = ctx.rentasRepo.getMessagingOutbox().find((o) => o.channel === "email" && o.eventType === "reserva.recordatorio_checkin");
    expect(job?.status).toBe("failed");
  });

  // Wiring real del scheduler (vercel.json::crons): Vercel Cron SIEMPRE dispara
  // GET, nunca POST, y solo sabe mandar el secreto como
  // `Authorization: Bearer <CRON_SECRET>` -- nunca el header custom
  // `x-atiende-internal-secret`. Ver internalOrCronSecretMatches (http-security.ts).
  it("GET con Authorization: Bearer <secreto> (forma real en que Vercel Cron invoca la ruta) también autentica", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/email-dispatch", { method: "GET", headers: { authorization: `Bearer ${TEST_ENV.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET sin ningún secreto responde 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/email-dispatch", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("GET con un Bearer incorrecto responde 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/email-dispatch", { method: "GET", headers: { authorization: "Bearer secreto-equivocado" } });
    expect(res.status).toBe(401);
  });
});

// Cierre del hallazgo "rentas no tiene disparo inline de correo" -- prueba la
// propiedad real que le importa a la auditoría: el cron diario y el disparo
// inline operan sobre la MISMA fila del outbox (reclamo atómico,
// `claim_email_outbox_batch`), así que un correo real nunca sale dos veces.
// Mismo criterio que licitaciones-discover.spec.ts para stubear SOLO el
// transporte HTTP (nunca la lógica de negocio): `vi.stubGlobal("fetch", ...)`
// sustituye la llamada real a la API de Resend.
describe("Disparo inline + cron: la misma fila nunca se envía dos veces", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("con RESEND_API_KEY real, el correo se manda UNA sola vez aunque el cron corra después del disparo inline", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const deps = { ...ctx.deps, env: { ...ctx.deps.env, resend: { apiKey: "re_test_key", from: ctx.deps.env.resend.from } } };
    const app = buildApp(deps);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "resend-id" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const crearRes = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-09-01", fin: "2026-09-03" }, huespedNombre: "Ana Pérez", huespedContacto: "ana@example.com" }),
    );
    expect(crearRes.status).toBe(201);

    // El disparo inline, DENTRO del propio POST de creación, ya mandó el correo real.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const job = ctx.rentasRepo.getMessagingOutbox().find((o) => o.eventType === "reserva.creada");
    expect(job?.status).toBe("sent");

    // El cron diario (red de seguridad) corre después sobre la misma fila -- el
    // reclamo atómico nunca reclama una fila ya 'sent', así que no reenvía.
    const cronRes = await app.request("/internal/rentas/email-dispatch", { method: "POST", headers: { "x-atiende-internal-secret": deps.env.internalSecret } });
    expect(cronRes.status).toBe(200);
    const body = (await cronRes.json()) as { processed: number };
    expect(body.processed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // sigue en 1 -- nunca se reenvía.
  });
});
