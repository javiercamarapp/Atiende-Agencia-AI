// Suscripción SaaS propia de Atiende a sus organizaciones clientes (auditoría de
// 22 rubros, hallazgo P1 #6) -- POST /billing/checkout + POST /billing/webhook.
// `@atiende/billing` (tenant-verification/ledger/per-seat/stripe-rail) ya tenía
// sus propias pruebas unitarias -- este archivo cubre la RUTA HTTP: quién puede
// crear un checkout, el fail-closed sin credenciales, y el webhook end-to-end
// (firma inválida rechazada, verificación cross-tenant, dedupe/orden del
// ledger).
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// Hallazgo de revisores (ronda r5): POST /billing/webhook no tenía rate-limit.
// Ver el comentario de cabecera de billing.ts para el criterio completo
// (categoría 'conversation:inbound-webhook', evaluado ANTES de la firma,
// fail-open). `resetDefaultRateLimiterForTests()` corre automáticamente antes
// de CADA test (ver test-setup/reset-rate-limiter.ts) -- estos tests siempre
// arrancan con el contador en cero.
describe("POST /billing/webhook -- rate limiting real (conversation:inbound-webhook, por IP, ANTES de verificar la firma)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("dentro del límite (menos de 120 en la ventana) nunca responde 429 -- una firma inválida sigue dando 401, la verificación de firma sigue intacta", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const app = buildApp(deps);
    const payload = buildCheckoutCompletedEvent({ id: "evt_rl_ok", created: Math.floor(Date.now() / 1000), customer: "cus_rl", tenantId: base.organizationId });

    for (let i = 0; i < 10; i += 1) {
      const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": "t=1,v1=firmaquenocoincide00000000000000000000000000000000000000000000" }));
      expect(res.status).toBe(401);
    }
  });

  it("más de 120 notificaciones en la misma ventana (misma IP) responde 429 con Retry-After -- evaluado ANTES de verificar la firma: incluso con firma siempre inválida, el corte real es el rate limit, no la firma", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const app = buildApp(deps);
    const payload = buildCheckoutCompletedEvent({ id: "evt_rl_exceso", created: Math.floor(Date.now() / 1000), customer: "cus_rl_exceso", tenantId: base.organizationId });

    let last: Response | undefined;
    for (let i = 0; i < 121; i += 1) {
      last = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": `t=1,v1=firma-invalida-${i}` }));
      if (i < 120) expect(last.status).toBe(401);
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBe("60");
  });

  it("con Upstash configurado pero Redis caído a media petición, el webhook sigue pasando -- fail-open por diseño, nunca bloquea un webhook legítimo de Stripe por un blip del proveedor", async () => {
    // Distinto del caso de abajo ("sin Upstash configurado"): aquí SÍ hay
    // credenciales, y lo que falla es el `fetch` a Redis -- el camino de
    // `redis_failure`/`failMode: 'open'` de `endpoint-policy.ts`.
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake-redis.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "tok-de-prueba");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const app = buildApp(deps);
    const now = Math.floor(Date.now() / 1000);
    const payload = buildCheckoutCompletedEvent({ id: "evt_rl_failopen", created: now, customer: "cus_rl_failopen", tenantId: base.organizationId });
    const header = firmarStripe(WEBHOOK_SECRET, now, payload);

    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": header }));
    // Redis caído -- degrada al backend en memoria de esta instancia (la
    // categoría es ABIERTA), nunca bloquea con 429 ni con 5xx: el resto del
    // handler corre normal (firma válida -> 200 procesado).
    expect(res.status).toBe(200);
  });

  // Hallazgo de revisión real (ronda r5, no-bloqueante 3 del PR #167): el test
  // de arriba (pese a su nombre anterior) solo probaba "Redis caído CON
  // credenciales" -- el caso "sin Upstash configurado en absoluto" (que SÍ
  // pide el encargo original) es un camino DISTINTO en
  // `DistributedRateLimiter`: sin `UPSTASH_REDIS_REST_URL`/`_TOKEN`, `fetch`
  // nunca se llama, y el backend en memoria de ESTA instancia SÍ aplica el
  // límite (degradación, no ausencia de límite) -- 121 requests siguen dando
  // 429 en la número 121, exactamente igual que con Redis disponible.
  it("sin ninguna credencial de Upstash configurada, el backend en memoria SÍ limita -- no es 'pasar sin límite', es degradar a memoria", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const app = buildApp(deps);
    const payload = buildCheckoutCompletedEvent({ id: "evt_rl_sin_upstash", created: Math.floor(Date.now() / 1000), customer: "cus_rl_sin_upstash", tenantId: base.organizationId });

    let last: Response | undefined;
    for (let i = 0; i < 121; i += 1) {
      last = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": `t=1,v1=firma-invalida-sin-upstash-${i}` }));
      if (i < 120) expect(last.status).toBe(401);
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBe("60");
  });

  // Hallazgo de revisión real (ronda r5, bloqueante 1 del PR #167): sin este
  // fix, `cf-connecting-ip` (falsificable por el cliente, sin Cloudflare real
  // delante de Vercel) tenía prioridad -- rotarlo en cada request evadía el
  // límite por completo.
  it("rotar cf-connecting-ip en cada request NO evade el límite -- el actor real es x-forwarded-for, no un header que el cliente controla", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const app = buildApp(deps);
    const payload = buildCheckoutCompletedEvent({ id: "evt_rl_cf_spoof", created: Math.floor(Date.now() / 1000), customer: "cus_rl_cf_spoof", tenantId: base.organizationId });

    let last: Response | undefined;
    for (let i = 0; i < 121; i += 1) {
      last = await app.request(
        "/billing/webhook",
        rawRequestInit(payload, { "stripe-signature": `t=1,v1=firma-invalida-cf-${i}`, "cf-connecting-ip": `10.0.0.${i % 255}`, "x-forwarded-for": "198.51.100.7" }),
      );
      if (i < 120) expect(last.status).toBe(401);
    }
    expect(last!.status).toBe(429);
  });

  // Hallazgo de revisión real (ronda r5, bloqueante 2 del PR #167): esta clave
  // era byte-idéntica a la de `hoteles/cfdi-webhook.ts` -- tráfico NO
  // autenticado contra /billing/webhook agotaba el bucket que ese webhook
  // consulta DESPUÉS de verificar su propia firma (tope 60, no 120).
  it("agotar el límite de /billing/webhook NO agota el bucket de /hoteles/cfdi/webhook (claves distintas pese a compartir categoría e IP)", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const app = buildApp(deps);
    const payload = buildCheckoutCompletedEvent({ id: "evt_rl_cfdi_isolation", created: Math.floor(Date.now() / 1000), customer: "cus_rl_cfdi_isolation", tenantId: base.organizationId });

    for (let i = 0; i < 121; i += 1) {
      await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": `t=1,v1=firma-invalida-aislamiento-${i}` }));
    }

    // El bucket de CFDI (tope 60) sigue en cero -- una firma de PAC inválida
    // sigue respondiendo 401 (firma), nunca 429 (que probaría que el bucket ya
    // venía agotado por el tráfico de arriba).
    const cfdiRes = await app.request("/hoteles/cfdi/webhook", rawRequestInit(JSON.stringify({ evento: "x" }), { "x-pac-signature": "firma-invalida" }));
    expect(cfdiRes.status).not.toBe(429);
  });
});

// Bitácora completa de `POST /billing/webhook` (`core.billing_webhook_log`,
// `packages/db/migrations/0018_billing_webhook_registro.sql`) -- registra CADA
// intento, con o sin éxito, para que un cobro que no se reflejó sea
// diagnosticable sin leer logs de la instancia. Cada caso de abajo reusa un
// escenario YA cubierto arriba (nunca inventa uno nuevo) y solo agrega la
// aserción sobre la bitácora -- confirma que la escritura NUEVA nunca cambia
// el comportamiento YA probado del webhook (mismo body/status en cada caso).
async function ultimaFilaDeBitacora(deps: Awaited<ReturnType<typeof buildTestDeps>>["deps"], superId: string) {
  const pagina = await deps.coreRepo.listBillingWebhookLogForSuperadmin(superId, { limit: 1, offset: 0 });
  return pagina.rows[0];
}

describe("POST /billing/webhook — bitácora (core.billing_webhook_log)", () => {
  async function conSuperadmin(deps: Awaited<ReturnType<typeof buildTestDeps>>["deps"]) {
    const coreRepo = deps.coreRepo as InMemoryCoreRepository;
    const superId = randomUUID();
    coreRepo.addStaff({ id: superId, email: `super-${superId}@atiende.ai`, fullName: "Super", passwordHash: null, createdVia: "seed", emailVerifiedAt: null });
    coreRepo.addPlatformSuperadmin(superId);
    return superId;
  }

  it("firma inválida queda 'rechazado'/'firma_invalida', sin id/tipo/organización (nunca se guarda la cabecera de firma)", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const superId = await conSuperadmin(deps);
    const app = buildApp(deps);
    const payload = buildCheckoutCompletedEvent({ id: "evt_1", created: Math.floor(Date.now() / 1000), customer: "cus_1", tenantId: base.organizationId });

    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": "t=1700000000,v1=firmaquenocoincide00000000000000000000000000000000000000000000" }));
    expect(res.status).toBe(401);

    const fila = await ultimaFilaDeBitacora(deps, superId);
    expect(fila).toMatchObject({ result: "rechazado", reason: "firma_invalida", providerEventId: null, eventType: null, organizationId: null });
  });

  it("sin STRIPE_WEBHOOK_SECRET configurado (503) NO escribe ninguna fila -- no hay evento real que registrar todavía", async () => {
    const base = await buildTestDeps();
    const deps = base.deps; // sin saasBillingWebhookSecret
    const superId = await conSuperadmin(deps);
    const app = buildApp(deps);
    const payload = buildCheckoutCompletedEvent({ id: "evt_1", created: Math.floor(Date.now() / 1000), customer: "cus_1", tenantId: base.organizationId });

    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": "t=1,v1=deadbeef" }));
    expect(res.status).toBe(503);

    const pagina = await deps.coreRepo.listBillingWebhookLogForSuperadmin(superId, { limit: 10, offset: 0 });
    expect(pagina.total).toBe(0);
  });

  it("JSON inválido (con firma real) queda 'rechazado'/'json_invalido'", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const superId = await conSuperadmin(deps);
    const app = buildApp(deps);
    const now = Math.floor(Date.now() / 1000);
    const payload = "{esto no es json valido";
    const header = firmarStripe(WEBHOOK_SECRET, now, payload);

    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": header }));
    expect(res.status).toBe(400);

    const fila = await ultimaFilaDeBitacora(deps, superId);
    expect(fila).toMatchObject({ result: "rechazado", reason: "json_invalido", organizationId: null });
  });

  it("un tipo de evento no manejado queda 'ignorado'/'evento_no_reconocido', con id/tipo capturados", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const superId = await conSuperadmin(deps);
    const app = buildApp(deps);
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ id: "evt_no_manejado", object: "event", type: "invoice.created", created: now, data: { object: { customer: "cus_x", metadata: { tenant_id: base.organizationId } } } });
    const header = firmarStripe(WEBHOOK_SECRET, now, payload);

    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": header }));
    expect(res.status).toBe(200);

    const fila = await ultimaFilaDeBitacora(deps, superId);
    expect(fila).toMatchObject({ result: "ignorado", reason: "evento_no_reconocido", providerEventId: "evt_no_manejado", eventType: "invoice.created", organizationId: null });
  });

  it("un tenant_id falseado (customer no coincide) queda 'rechazado' con el motivo real y la organización SÍ resuelta (el tenant existe, solo el customer no cruzó)", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const superId = await conSuperadmin(deps);
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

    const fila = await ultimaFilaDeBitacora(deps, superId);
    expect(fila).toMatchObject({ result: "rechazado", reason: "customer_no_coincide", providerEventId: "evt_ataque", organizationId: base.organizationId });
  });

  it("un evento aplicado con éxito queda 'procesado'/'aplicado', con la organización real resuelta", async () => {
    const base = await buildTestDeps();
    const deps = {
      ...base.deps,
      saasBillingWebhookSecret: WEBHOOK_SECRET,
      saasBillingCustomerLookup: new FakeCustomerLookup({ cus_nuevo: base.ownerEmail }),
    };
    const superId = await conSuperadmin(deps);
    const app = buildApp(deps);
    const now = Math.floor(Date.now() / 1000);
    const payload = buildCheckoutCompletedEvent({ id: "evt_checkout_1", created: now, customer: "cus_nuevo", subscription: "sub_nuevo", tenantId: base.organizationId });
    const header = firmarStripe(WEBHOOK_SECRET, now, payload);

    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": header }));
    expect(res.status).toBe(200);

    const fila = await ultimaFilaDeBitacora(deps, superId);
    expect(fila).toMatchObject({ result: "procesado", reason: "aplicado", providerEventId: "evt_checkout_1", organizationId: base.organizationId });
  });

  it("el mismo evento reenviado (dedupe) queda 'ignorado'/'duplicado' la segunda vez -- primero sigue 'procesado'/'aplicado'", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const superId = await conSuperadmin(deps);
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

    await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": header }));
    const segundo = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": header }));
    expect(segundo.status).toBe(200);

    const pagina = await deps.coreRepo.listBillingWebhookLogForSuperadmin(superId, { limit: 10, offset: 0 });
    expect(pagina.total).toBe(2);
    expect(pagina.rows[0]).toMatchObject({ result: "ignorado", reason: "duplicado" });
    expect(pagina.rows[1]).toMatchObject({ result: "procesado", reason: "aplicado" });
  });

  it("filtra por result y por organizationId -- mismos filtros que expone GET /superadmin/facturacion/webhooks-bitacora", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const superId = await conSuperadmin(deps);
    const app = buildApp(deps);

    // Una fila 'rechazado' (firma inválida, sin organización) y una
    // 'procesado' (con organización real) -- 2 resultados distintos para que
    // el filtro por `result` (y por `organizationId`, que solo matchea la
    // segunda) tenga algo real que distinguir.
    await app.request(
      "/billing/webhook",
      rawRequestInit(buildCheckoutCompletedEvent({ id: "evt_x", created: 1, customer: "cus_x", tenantId: base.organizationId }), {
        "stripe-signature": "t=1,v1=invalida000000000000000000000000000000000000000000000000000000",
      }),
    );
    const now = Math.floor(Date.now() / 1000);
    const payload = buildCheckoutCompletedEvent({ id: "evt_ok", created: now, customer: "cus_ok", subscription: "sub_ok", tenantId: base.organizationId });
    await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": firmarStripe(WEBHOOK_SECRET, now, payload) }));

    const soloRechazados = await deps.coreRepo.listBillingWebhookLogForSuperadmin(superId, { result: "rechazado", limit: 10, offset: 0 });
    expect(soloRechazados.total).toBe(1);
    expect(soloRechazados.rows[0]).toMatchObject({ reason: "firma_invalida" });

    const porOrganizacion = await deps.coreRepo.listBillingWebhookLogForSuperadmin(superId, { organizationId: base.organizationId, limit: 10, offset: 0 });
    expect(porOrganizacion.total).toBe(1);
    expect(porOrganizacion.rows[0]).toMatchObject({ result: "procesado" });
  });

  it("un staff normal (no superadmin) obtiene una página vacía -- nunca la bitácora real de otra organización", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const coreRepo = deps.coreRepo as InMemoryCoreRepository;
    const app = buildApp(deps);
    const payload = buildCheckoutCompletedEvent({ id: "evt_1", created: Math.floor(Date.now() / 1000), customer: "cus_1", tenantId: base.organizationId });
    await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": "t=1,v1=deadbeef" }));

    const memberId = randomUUID();
    coreRepo.addStaff({ id: memberId, email: "miembro-bitacora@lostaquitos.mx", fullName: "Miembro", passwordHash: null, createdVia: "seed", emailVerifiedAt: null });
    coreRepo.addMembership({ userId: memberId, organizationId: base.organizationId, platformRole: "member", verticalRole: "staff", propertyIds: null });

    const pagina = await deps.coreRepo.listBillingWebhookLogForSuperadmin(memberId, { limit: 10, offset: 0 });
    expect(pagina).toEqual({ disponible: true, rows: [], total: 0 });
  });

  // Revisión de PR #153 (bloqueante 2): el commit caa938c dice "cubre cada
  // resultado del handler" pero ningún test forzaba el resultado 'error' --
  // grep error_interno en apps/api/tests daba 0 resultados. Este ejercita el
  // catch real de billing.ts (L392-399): `aplicar()` (el upsert real) falla,
  // se registra 'error'/'error_interno', y el error original se REPROPAGA
  // sin cambios (mismo 500 que ya producía este catch antes de que existiera
  // la bitácora).
  it("un error real al aplicar el evento (el upsert falla) responde 500, registra 'error'/'error_interno', y el error original se repropaga sin cambios", async () => {
    const base = await buildTestDeps();
    const deps = {
      ...base.deps,
      saasBillingWebhookSecret: WEBHOOK_SECRET,
      saasBillingCustomerLookup: new FakeCustomerLookup({ cus_boom: base.ownerEmail }),
    };
    const superId = await conSuperadmin(deps);
    const coreRepo = deps.coreRepo as InMemoryCoreRepository;
    coreRepo.upsertOrganizationBilling = async () => {
      throw new Error("fallo real de Postgres en el upsert (simulado)");
    };
    const app = buildApp(deps);
    const now = Math.floor(Date.now() / 1000);
    const payload = buildCheckoutCompletedEvent({ id: "evt_boom", created: now, customer: "cus_boom", subscription: "sub_boom", tenantId: base.organizationId });
    const header = firmarStripe(WEBHOOK_SECRET, now, payload);

    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": header }));

    expect(res.status).toBe(500);
    const fila = await ultimaFilaDeBitacora(deps, superId);
    expect(fila).toMatchObject({ result: "error", reason: "error_interno", providerEventId: "evt_boom", organizationId: base.organizationId });
  });

  // Revisión de PR #153 (bloqueante 2): `registrarWebhook` es una "segunda
  // red" -- `deps.coreRepo.recordBillingWebhookEvent` YA nunca lanza por
  // contrato, pero nada probaba que si LO HICIERA de todos modos, la
  // respuesta HTTP real del webhook (la que Stripe usa para decidir si
  // reintenta) se quedara intacta. Ejercita el camino de éxito (200) y el de
  // firma inválida (401) con la escritura de bitácora rota.
  it("si recordBillingWebhookEvent lanza (violando su propio contrato), la respuesta HTTP del webhook no cambia -- éxito sigue 200", async () => {
    const base = await buildTestDeps();
    const deps = {
      ...base.deps,
      saasBillingWebhookSecret: WEBHOOK_SECRET,
      saasBillingCustomerLookup: new FakeCustomerLookup({ cus_segunda_red: base.ownerEmail }),
    };
    const coreRepo = deps.coreRepo as InMemoryCoreRepository;
    coreRepo.recordBillingWebhookEvent = async () => {
      throw new Error("bitácora rota (simulado) -- registrarWebhook debe atraparlo igual");
    };
    const app = buildApp(deps);
    const now = Math.floor(Date.now() / 1000);
    const payload = buildCheckoutCompletedEvent({ id: "evt_segunda_red", created: now, customer: "cus_segunda_red", subscription: "sub_segunda_red", tenantId: base.organizationId });
    const header = firmarStripe(WEBHOOK_SECRET, now, payload);

    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": header }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, procesado: true, estado: "aplicado" });
  });

  it("si recordBillingWebhookEvent lanza, el rechazo por firma inválida se sigue respondiendo 401 sin cambios", async () => {
    const base = await buildTestDeps();
    const deps = { ...base.deps, saasBillingWebhookSecret: WEBHOOK_SECRET };
    const coreRepo = deps.coreRepo as InMemoryCoreRepository;
    coreRepo.recordBillingWebhookEvent = async () => {
      throw new Error("bitácora rota (simulado)");
    };
    const app = buildApp(deps);
    const payload = buildCheckoutCompletedEvent({ id: "evt_1", created: Math.floor(Date.now() / 1000), customer: "cus_1", tenantId: base.organizationId });

    const res = await app.request("/billing/webhook", rawRequestInit(payload, { "stripe-signature": "t=1,v1=deadbeef" }));

    expect(res.status).toBe(401);
  });
});
