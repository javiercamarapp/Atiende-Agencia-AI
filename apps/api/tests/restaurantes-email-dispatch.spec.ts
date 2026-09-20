// Hallazgo de auditoría (severidad MEDIA, "restaurantes no envía ningún correo:
// sin plantilla, sin dispatcher, sin remitente — solo WhatsApp"): POST/GET
// /internal/restaurantes/email-dispatch — mismo patrón de prueba EXACTO que
// apps/api/tests/citas-email-dispatch.spec.ts (Fase 6 §3 citas, primer vertical
// en resolver este mismo gap).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit, TEST_ENV } from "./fixtures.ts";

describe("POST /internal/restaurantes/email-dispatch", () => {
  it("sin el secreto interno responde 401", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/internal/restaurantes/email-dispatch", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("fix a2b: sin RESEND_API_KEY configurada, responde 'not_configured' y NO reclama nada (cero intentos quemados)", async () => {
    const { deps, restaurantesRepo, products } = await buildTestDeps();
    const app = buildApp(deps);

    // Crea el pedido vía el endpoint HTTP público real (source=web) — es esa ruta
    // (orders.ts::createOrder, best-effort) quien encola el correo real, no una
    // llamada directa al dominio.
    const createRes = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit(
        {
          branch_slug: "fco-montejo",
          customer_name: "Cliente Correo",
          customer_phone: "9991112222",
          customer_email: "cliente@example.com",
          items: [{ product_id: products.cocaCola, requested_quantity: 1 }],
          source: "web",
        },
        { origin: "http://localhost:5173" },
      ),
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { order: { customerEmail: string | null } };
    expect(created.order.customerEmail).toBe("cliente@example.com");

    const res = await app.request("/internal/restaurantes/email-dispatch", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; processed: number; sent: number; failed: number };
    // Fix a2b (CRÍTICO, seguimiento PR #166): sin proveedor configurado, NUNCA
    // se reclama el outbox (cross-tenant, cuenta intento) -- antes de este
    // fix, `processed`/`failed` eran 1 aquí, quemando un intento por cada
    // invocación sin que Resend jamás lo hubiera visto.
    expect(body.status).toBe("not_configured");
    expect(body.processed).toBe(0);
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(0);

    const job = restaurantesRepo.getOutbox().find((o) => o.channel === "email" && o.eventType === "order.created.email");
    expect(job?.status).toBe("pending");
  });

  it("un pedido SIN correo (voz/WhatsApp-first, el caso real de hoy) no encola nada — el dispatch queda en 0", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);

    const createRes = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit(
        { branch_slug: "fco-montejo", customer_name: "Cliente Sin Correo", customer_phone: "9991112222", items: [{ product_id: products.cocaCola, requested_quantity: 1 }], source: "web" },
        { origin: "http://localhost:5173" },
      ),
    );
    expect(createRes.status).toBe(200);

    const res = await app.request("/internal/restaurantes/email-dispatch", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    const body = (await res.json()) as { processed: number };
    expect(body.processed).toBe(0);
  });

  // Wiring real del scheduler (vercel.json::crons): Vercel Cron SIEMPRE dispara
  // GET, nunca POST, y solo sabe mandar el secreto como
  // `Authorization: Bearer <CRON_SECRET>` — nunca el header custom
  // `x-atiende-internal-secret`. Ver internalOrCronSecretMatches (http-security.ts).
  it("GET con Authorization: Bearer <secreto> (forma real en que Vercel Cron invoca la ruta) también autentica", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/internal/restaurantes/email-dispatch", { method: "GET", headers: { authorization: `Bearer ${TEST_ENV.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET sin ningún secreto responde 401", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/internal/restaurantes/email-dispatch", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("GET con un Bearer incorrecto responde 401", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/internal/restaurantes/email-dispatch", { method: "GET", headers: { authorization: "Bearer secreto-equivocado" } });
    expect(res.status).toBe(401);
  });
});
