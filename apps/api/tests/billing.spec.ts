// Suscripción SaaS propia de Atiende a sus organizaciones clientes (auditoría de
// 22 rubros, hallazgo P1 #6) -- POST /billing/checkout + POST /billing/webhook.
// `@atiende/billing` (tenant-verification/ledger/per-seat/stripe-rail) ya tenía
// sus propias pruebas unitarias -- este archivo cubre la RUTA HTTP: quién puede
// crear un checkout, el fail-closed sin credenciales, y el webhook end-to-end
// (firma inválida rechazada, verificación cross-tenant, dedupe/orden del
// ledger).
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import type { CustomerLookup, StripeClient } from "@atiende/billing";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const WEBHOOK_SECRET = "whsec_test_secreto";

class FakeSaasStripeClient implements StripeClient {
  calls: Array<Parameters<StripeClient["crearSesionCheckout"]>[0]> = [];
  async crearSesionCheckout(opts: Parameters<StripeClient["crearSesionCheckout"]>[0]) {
    this.calls.push(opts);
    return { url: `https://checkout.stripe.com/test/${opts.priceId}/${this.calls.length}` };
  }
}

class FakeCustomerLookup implements CustomerLookup {
  constructor(private readonly emails: Record<string, string> = {}) {}
  async getEmailDelCustomer(customerId: string): Promise<string | null> {
    return this.emails[customerId] ?? null;
  }
}

async function tokenFor(deps: Awaited<ReturnType<typeof buildTestDeps>>["deps"], userId: string, email: string): Promise<string> {
  return signAccessToken({ sub: userId, org_id: "", vertical: "restaurantes", property_ids: null, email }, deps.env.jwtSecret, deps.env.accessTokenTtlSeconds);
}

function firmarStripe(secret: string, timestampUnix: number, payload: string): string {
  const hmac = createHmac("sha256", secret).update(`${timestampUnix}.${payload}`, "utf8").digest("hex");
  return `t=${timestampUnix},v1=${hmac}`;
}

function rawRequestInit(body: string, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(body).byteLength), ...headers },
  };
}

function buildCheckoutCompletedEvent(opts: { id: string; created: number; customer: string; subscription?: string | null; tenantId: string | null; vertical?: string }): string {
  return JSON.stringify({
    id: opts.id,
    object: "event",
    type: "checkout.session.completed",
    created: opts.created,
    data: {
      object: {
        customer: opts.customer,
        subscription: opts.subscription ?? `sub_${opts.id}`,
        metadata: opts.tenantId ? { tenant_id: opts.tenantId, vertical: opts.vertical ?? "restaurantes" } : {},
      },
    },
  });
}

function buildSubscriptionEvent(opts: {
  id: string;
  type: "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted";
  created: number;
  customer: string;
  subscriptionId: string;
  status: string;
  quantity: number;
  priceId: string;
  currentPeriodEndUnix: number;
  tenantId: string | null;
  vertical?: string;
}): string {
  return JSON.stringify({
    id: opts.id,
    object: "event",
    type: opts.type,
    created: opts.created,
    data: {
      object: {
        id: opts.subscriptionId,
        customer: opts.customer,
        status: opts.status,
        current_period_end: opts.currentPeriodEndUnix,
        items: { data: [{ quantity: opts.quantity, price: { id: opts.priceId } }] },
        metadata: opts.tenantId ? { tenant_id: opts.tenantId, vertical: opts.vertical ?? "restaurantes" } : {},
      },
    },
  });
}

describe("POST /billing/checkout", () => {
  it("el owner de la organización crea un checkout real -- metadata siempre lleva tenant_id/vertical", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const stripe = new FakeSaasStripeClient();
    const deps = { ...base.deps, saasBillingStripeClient: stripe };
    const app = buildApp(deps);

    const ownerId = (await coreRepo.findStaffByEmail(base.ownerEmail))!.id;
    const token = await tokenFor(deps, ownerId, base.ownerEmail);

    const res = await app.request(
      "/billing/checkout",
      jsonRequestInit({ organizationId: base.organizationId, priceId: "price_real_599", seats: 3 }, { authorization: `Bearer ${token}` }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain("price_real_599");
    expect(stripe.calls).toHaveLength(1);
    expect(stripe.calls[0]).toMatchObject({ priceId: "price_real_599", cantidadSeats: 3 });
    expect(stripe.calls[0]!.metadata).toEqual({ tenant_id: base.organizationId, vertical: "restaurantes" });
    expect(stripe.calls[0]!.successUrl).toContain(base.organizationId);
    expect(stripe.calls[0]!.cancelUrl).toContain(base.organizationId);
  });

  it("sin STRIPE_SECRET_KEY configurada (saasBillingStripeClient ausente) responde 503 honesto, nunca finge una URL", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const app = buildApp(base.deps); // buildTestDeps no configura saasBillingStripeClient

    const ownerId = (await coreRepo.findStaffByEmail(base.ownerEmail))!.id;
    const token = await tokenFor(base.deps, ownerId, base.ownerEmail);

    const res = await app.request(
      "/billing/checkout",
      jsonRequestInit({ organizationId: base.organizationId, priceId: "price_real_599", seats: 3 }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("service_unavailable");
  });

  it("un 'member' (ni owner ni admin) es rechazado con 403 -- nunca solo un chequeo de TS, la autoridad vive en getOrganizationBillingForCheckout", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const memberId = randomUUID();
    coreRepo.addStaff({ id: memberId, email: "miembro@lostaquitos.mx", fullName: "Miembro", passwordHash: null, createdVia: "seed", emailVerifiedAt: null });
    coreRepo.addMembership({ userId: memberId, organizationId: base.organizationId, platformRole: "member", verticalRole: "staff", propertyIds: null });

    const deps = { ...base.deps, saasBillingStripeClient: new FakeSaasStripeClient() };
    const app = buildApp(deps);
    const token = await tokenFor(deps, memberId, "miembro@lostaquitos.mx");

    const res = await app.request(
      "/billing/checkout",
      jsonRequestInit({ organizationId: base.organizationId, priceId: "price_real_599", seats: 3 }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(403);
  });

  it("un superadmin de plataforma puede iniciar checkout aunque no sea miembro de la organización", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const superId = randomUUID();
    coreRepo.addStaff({ id: superId, email: "super@atiende.ai", fullName: "Super", passwordHash: null, createdVia: "seed", emailVerifiedAt: null });
    coreRepo.addPlatformSuperadmin(superId);

    const stripe = new FakeSaasStripeClient();
    const deps = { ...base.deps, saasBillingStripeClient: stripe };
    const app = buildApp(deps);
    const token = await tokenFor(deps, superId, "super@atiende.ai");

    const res = await app.request(
      "/billing/checkout",
      jsonRequestInit({ organizationId: base.organizationId, priceId: "price_real_599", seats: 1 }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    expect(stripe.calls).toHaveLength(1);
  });

  it("una organización inexistente responde 404", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const deps = { ...base.deps, saasBillingStripeClient: new FakeSaasStripeClient() };
    const app = buildApp(deps);
    const ownerId = (await coreRepo.findStaffByEmail(base.ownerEmail))!.id;
    const token = await tokenFor(deps, ownerId, base.ownerEmail);

    const res = await app.request(
      "/billing/checkout",
      jsonRequestInit({ organizationId: randomUUID(), priceId: "price_real_599", seats: 1 }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(404);
  });

  it("seats inválido (0, negativo, o no entero) responde 400 de validación", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const deps = { ...base.deps, saasBillingStripeClient: new FakeSaasStripeClient() };
    const app = buildApp(deps);
    const ownerId = (await coreRepo.findStaffByEmail(base.ownerEmail))!.id;
    const token = await tokenFor(deps, ownerId, base.ownerEmail);

    for (const seats of [0, -1, 1.5, "3"]) {
      const res = await app.request("/billing/checkout", jsonRequestInit({ organizationId: base.organizationId, priceId: "price_1", seats }, { authorization: `Bearer ${token}` }));
      expect(res.status).toBe(400);
    }
  });

  it("sin token -- 401", async () => {
    const base = await buildTestDeps();
    const app = buildApp({ ...base.deps, saasBillingStripeClient: new FakeSaasStripeClient() });
    const res = await app.request("/billing/checkout", jsonRequestInit({ organizationId: base.organizationId, priceId: "price_1", seats: 1 }));
    expect(res.status).toBe(401);
  });
});

describe("POST /billing/webhook", () => {
  it("sin STRIPE_WEBHOOK_SECRET configurado responde 503 honesto, nunca procesa el evento", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps); // sin saasBillingWebhookSecret
    const payload = buildCheckoutCompletedEvent({ id: "evt_1", created: Math.floor(Date.now() / 1000), customer: "cus_1", tenantId: base.organizationId });
    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": "t=1,v1=deadbeef" }));
    expect(res.status).toBe(503);
  });

  it("firma inválida es rechazada con 401, nunca actualiza el estado de la organización", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const app = buildApp(deps);
    const payload = buildCheckoutCompletedEvent({ id: "evt_1", created: Math.floor(Date.now() / 1000), customer: "cus_1", tenantId: base.organizationId });

    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": "t=1700000000,v1=firmaquenocoincide00000000000000000000000000000000000000000000" }));
    expect(res.status).toBe(401);
    expect(await deps.coreRepo.getOrganizationBillingForWebhook(base.organizationId)).toMatchObject({ status: "sin_suscripcion" });
  });

  it("checkout.session.completed con firma válida y primer checkout (cruce por email) marca la organización 'activa'", async () => {
    const base = await buildTestDeps();
    const deps = {
      ...base.deps,
      saasBillingWebhookSecret: WEBHOOK_SECRET,
      saasBillingCustomerLookup: new FakeCustomerLookup({ cus_nuevo: base.ownerEmail }),
    };
    const app = buildApp(deps);

    const now = Math.floor(Date.now() / 1000);
    const payload = buildCheckoutCompletedEvent({ id: "evt_checkout_1", created: now, customer: "cus_nuevo", subscription: "sub_nuevo", tenantId: base.organizationId });
    const header = firmarStripe(WEBHOOK_SECRET, now, payload);

    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": header }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { procesado: boolean; estado: string };
    expect(body).toMatchObject({ procesado: true, estado: "aplicado" });

    const billing = await deps.coreRepo.getOrganizationBillingForWebhook(base.organizationId);
    expect(billing).toMatchObject({ status: "activa", stripeCustomerId: "cus_nuevo", stripeSubscriptionId: "sub_nuevo" });
  });

  it("customer.subscription.updated sincroniza seats/price/status reales desde items.quantity", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const app = buildApp(deps);
    // Ya hay un customer registrado (checkout anterior) -- CASO 1 de
    // verificarTenantDelWebhook: debe coincidir exacto.
    await deps.coreRepo.upsertOrganizationBilling({
      organizationId: base.organizationId,
      stripeCustomerId: "cus_existente",
      stripeSubscriptionId: "sub_existente",
      priceId: null,
      seats: 0,
      status: "activa",
      currentPeriodEnd: null,
    });

    const now = Math.floor(Date.now() / 1000);
    const periodEnd = now + 30 * 24 * 60 * 60;
    const payload = buildSubscriptionEvent({
      id: "evt_sub_1",
      type: "customer.subscription.updated",
      created: now,
      customer: "cus_existente",
      subscriptionId: "sub_existente",
      status: "active",
      quantity: 7,
      priceId: "price_599",
      currentPeriodEndUnix: periodEnd,
      tenantId: base.organizationId,
    });
    const header = firmarStripe(WEBHOOK_SECRET, now, payload);

    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": header }));
    expect(res.status).toBe(200);

    const billing = await deps.coreRepo.getOrganizationBillingForWebhook(base.organizationId);
    expect(billing).toMatchObject({ status: "activa", seats: 7, priceId: "price_599" });
    expect(billing?.currentPeriodEnd).toBe(new Date(periodEnd * 1000).toISOString());
  });

  it("un webhook con tenant_id falseado (customer del evento no coincide con el registrado) se rechaza con 409 y NUNCA actualiza el estado", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const app = buildApp(deps);
    await deps.coreRepo.upsertOrganizationBilling({
      organizationId: base.organizationId,
      stripeCustomerId: "cus_real_del_tenant",
      stripeSubscriptionId: "sub_real",
      priceId: "price_viejo",
      seats: 2,
      status: "activa",
      currentPeriodEnd: null,
    });

    const now = Math.floor(Date.now() / 1000);
    // El atacante pone el tenant_id de la víctima, pero trae SU PROPIO customer.
    const payload = buildSubscriptionEvent({
      id: "evt_ataque",
      type: "customer.subscription.updated",
      created: now,
      customer: "cus_del_atacante",
      subscriptionId: "sub_del_atacante",
      status: "active",
      quantity: 999,
      priceId: "price_599",
      currentPeriodEndUnix: now + 1000,
      tenantId: base.organizationId,
    });
    const header = firmarStripe(WEBHOOK_SECRET, now, payload);

    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": header }));
    expect(res.status).toBe(409);

    // El estado de la organización NUNCA se tocó -- ni el seats=999 falsificado,
    // ni el customer del atacante.
    const billing = await deps.coreRepo.getOrganizationBillingForWebhook(base.organizationId);
    expect(billing).toMatchObject({ stripeCustomerId: "cus_real_del_tenant", seats: 2, priceId: "price_viejo" });
  });

  it("el mismo evento reenviado (mismo id, reintento at-least-once de Stripe) no duplica -- responde estado 'duplicado'", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const app = buildApp(deps);

    const now = Math.floor(Date.now() / 1000);
    const payload = buildSubscriptionEvent({
      id: "evt_reintento",
      type: "customer.subscription.created",
      created: now,
      customer: "cus_dedupe",
      subscriptionId: "sub_dedupe",
      status: "active",
      quantity: 4,
      priceId: "price_1",
      currentPeriodEndUnix: now + 1000,
      tenantId: base.organizationId,
    });
    const header = firmarStripe(WEBHOOK_SECRET, now, payload);

    const primero = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": header }));
    expect(primero.status).toBe(200);
    expect(((await primero.json()) as { estado: string }).estado).toBe("aplicado");

    const segundo = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": header }));
    expect(segundo.status).toBe(200);
    expect(((await segundo.json()) as { estado: string }).estado).toBe("duplicado");

    // El estado sigue siendo el de la única aplicación real (4 seats), no se
    // volvió a aplicar ni se corrompió con un segundo cálculo.
    const billing = await deps.coreRepo.getOrganizationBillingForWebhook(base.organizationId);
    expect(billing).toMatchObject({ seats: 4 });
  });

  it("un evento MÁS VIEJO que el último aplicado para el mismo customer llega después -- se descarta ('fuera_de_orden'), nunca pisa el estado más nuevo", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const app = buildApp(deps);

    const hoy = 2_000_000;
    const cancelacionHoy = buildSubscriptionEvent({
      id: "evt_cancelacion_hoy",
      type: "customer.subscription.deleted",
      created: hoy,
      customer: "cus_orden",
      subscriptionId: "sub_orden",
      status: "canceled",
      quantity: 3,
      priceId: "price_1",
      currentPeriodEndUnix: hoy,
      tenantId: base.organizationId,
    });
    const headerHoy = firmarStripe(WEBHOOK_SECRET, Math.floor(Date.now() / 1000), cancelacionHoy);
    const r1 = await app.request("/billing/webhook", rawRequestInit(cancelacionHoy, { "stripe-signature": headerHoy }));
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { estado: string }).estado).toBe("aplicado");
    expect((await deps.coreRepo.getOrganizationBillingForWebhook(base.organizationId))?.status).toBe("cancelada");

    // Reintento tardío de un `.updated` VIEJO (backoff largo del proveedor) que
    // la dejaría "activa" otra vez -- debe descartarse.
    const actualizacionVieja = buildSubscriptionEvent({
      id: "evt_actualizacion_vieja",
      type: "customer.subscription.updated",
      created: hoy - 1_000_000,
      customer: "cus_orden",
      subscriptionId: "sub_orden",
      status: "active",
      quantity: 3,
      priceId: "price_1",
      currentPeriodEndUnix: hoy,
      tenantId: base.organizationId,
    });
    const headerVieja = firmarStripe(WEBHOOK_SECRET, Math.floor(Date.now() / 1000), actualizacionVieja);
    const r2 = await app.request("/billing/webhook", rawRequestInit(actualizacionVieja, { "stripe-signature": headerVieja }));
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { estado: string }).estado).toBe("fuera_de_orden");

    // SIGUE cancelada -- el evento viejo nunca revivió la suscripción.
    expect((await deps.coreRepo.getOrganizationBillingForWebhook(base.organizationId))?.status).toBe("cancelada");
  });

  it("un tipo de evento no manejado (p.ej. invoice.created) se responde 200 sin tocar la organización", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const app = buildApp(deps);
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ id: "evt_no_manejado", object: "event", type: "invoice.created", created: now, data: { object: { customer: "cus_x", metadata: { tenant_id: base.organizationId } } } });
    const header = firmarStripe(WEBHOOK_SECRET, now, payload);

    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": header }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { procesado: boolean }).procesado).toBe(false);
    expect(await deps.coreRepo.getOrganizationBillingForWebhook(base.organizationId)).toMatchObject({ status: "sin_suscripcion" });
  });
});
