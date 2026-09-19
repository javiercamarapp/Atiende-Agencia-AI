// Back office de plataforma — FACTURACIÓN de la suscripción SaaS propia de
// Atiende. Recorre las rutas contra los repos en memoria: 403 honesto para
// staff normal, agregaciones reales con varias organizaciones/estados/
// verticales (MRR SOLO con precio conocido, nunca inventado), descuadre de
// asientos (facturado vs. `calcularPerSeat` sobre staff real), y el 503
// honesto del checkout sin credenciales de Stripe — mismo criterio que
// `superadmin-llm-usage.spec.ts`/`billing.spec.ts`.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import type { StripeClient } from "@atiende/billing";
import { SEAT_HOTELES, SEAT_RESTAURANTES } from "@atiende/billing";
import { buildApp } from "../src/app.ts";
import { buildTestDeps } from "./fixtures.ts";

class FakeSaasStripeClient implements StripeClient {
  calls: Array<Parameters<StripeClient["crearSesionCheckout"]>[0]> = [];
  async crearSesionCheckout(opts: Parameters<StripeClient["crearSesionCheckout"]>[0]) {
    this.calls.push(opts);
    return { url: `https://checkout.stripe.com/test/${opts.priceId}/${this.calls.length}` };
  }
}

async function makeSuperadmin(base: Awaited<ReturnType<typeof buildTestDeps>>): Promise<{ token: string; superadminId: string }> {
  const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
  const superadminId = randomUUID();
  coreRepo.addStaff({ id: superadminId, email: "superadmin-facturacion@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addPlatformSuperadmin(superadminId);
  const token = await signAccessToken(
    { sub: superadminId, org_id: "", vertical: "restaurantes", property_ids: null, email: "superadmin-facturacion@example.com" },
    base.deps.env.jwtSecret,
    base.deps.env.accessTokenTtlSeconds,
  );
  return { token, superadminId };
}

async function staffToken(base: Awaited<ReturnType<typeof buildTestDeps>>): Promise<string> {
  return signAccessToken(
    { sub: randomUUID(), org_id: base.organizationId, vertical: "restaurantes", property_ids: null, email: base.ownerEmail },
    base.deps.env.jwtSecret,
    base.deps.env.accessTokenTtlSeconds,
  );
}

/** Organización de vertical `hoteles` — precio per-seat CONOCIDO
 *  (`SEAT_HOTELES`), estado de billing y staff real sembrados aparte por
 *  cada test (para ejercitar reconciliación/agregación con distintos
 *  valores). */
function seedOrgActivaHoteles(coreRepo: InMemoryCoreRepository) {
  const organizationId = randomUUID();
  coreRepo.addOrganization({ id: organizationId, slug: `hotel-${organizationId.slice(0, 8)}`, name: "Hotel de Prueba", vertical: "hoteles", status: "active", createdAt: new Date("2025-01-01T00:00:00.000Z").toISOString() });
  return organizationId;
}

describe("GET /superadmin/facturacion/organizaciones", () => {
  it("un staff normal (no superadmin) recibe 403 explícito", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/organizaciones", { headers: { authorization: `Bearer ${await staffToken(base)}` } });
    expect(res.status).toBe(403);
  });

  it("sin token -- 401", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/organizaciones");
    expect(res.status).toBe(401);
  });

  it("una organización sin fila de organization_billing aparece con status 'sin_suscripcion' y seats 0 -- nunca se omite ni se inventa un estado", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);

    const res = await app.request("/superadmin/facturacion/organizaciones", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizaciones: Array<{ organizationId: string; billingStatus: string; seats: number; mrrMxn: number | null }> };
    const org = body.organizaciones.find((o) => o.organizationId === base.organizationId);
    expect(org).toBeDefined();
    expect(org).toMatchObject({ billingStatus: "sin_suscripcion", seats: 0, mrrMxn: null });
  });

  it("reconciliación de asientos: seats contratados vs. calcularPerSeat sobre el staff real, con el descuadre señalado", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const { token } = await makeSuperadmin(base);

    const organizationId = seedOrgActivaHoteles(coreRepo);
    // 4 miembros de staff reales -- SEAT_HOTELES: seatsIncluidos=5, precio 89.
    // 4 <= 5 incluidos -> seatsFacturables real = 0.
    for (let i = 0; i < 4; i += 1) {
      const userId = randomUUID();
      coreRepo.addStaff({ id: userId, email: `staff-hotel-${i}@example.com`, passwordHash: null, fullName: `Staff ${i}`, createdVia: "seed", emailVerifiedAt: null });
      coreRepo.addMembership({ userId, organizationId, platformRole: "member", verticalRole: "staff", propertyIds: null });
    }
    await coreRepo.upsertOrganizationBilling({
      organizationId,
      stripeCustomerId: "cus_hotel_reconciliacion",
      stripeSubscriptionId: "sub_hotel_reconciliacion",
      priceId: "price_hotel",
      seats: 3, // contratado -- distinto de lo que el staff real justificaría (0)
      status: "activa",
      currentPeriodEnd: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    });

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/organizaciones", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      organizaciones: Array<{
        organizationId: string;
        staffCount: number;
        seats: number;
        precioConocido: boolean;
        seatsFacturablesSegunReal: number | null;
        descuadreAsientos: number;
        mrrMxn: number | null;
      }>;
    };
    const org = body.organizaciones.find((o) => o.organizationId === organizationId)!;
    expect(org.staffCount).toBe(4);
    expect(org.seats).toBe(3);
    expect(org.precioConocido).toBe(true);
    expect(org.seatsFacturablesSegunReal).toBe(0);
    expect(org.descuadreAsientos).toBe(3); // 3 contratados - 0 que le tocarían según staff real
    expect(org.mrrMxn).toBe(3 * SEAT_HOTELES.precioPorSeatMxn);
  });

  it("un vertical sin precio per-seat conocido (rentas) nunca calcula MRR ni seatsFacturablesSegunReal inventados -- reconciliación cae a comparar directo contra el staff real", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const { token } = await makeSuperadmin(base);

    const organizationId = randomUUID();
    coreRepo.addOrganization({ id: organizationId, slug: "rentas-sin-precio", name: "Rentas Sin Precio", vertical: "rentas", status: "active", createdAt: new Date().toISOString() });
    const userId = randomUUID();
    coreRepo.addStaff({ id: userId, email: "staff-rentas@example.com", passwordHash: null, fullName: "Staff Rentas", createdVia: "seed", emailVerifiedAt: null });
    coreRepo.addMembership({ userId, organizationId, platformRole: "member", verticalRole: "staff", propertyIds: null });
    await coreRepo.upsertOrganizationBilling({
      organizationId,
      stripeCustomerId: "cus_rentas",
      stripeSubscriptionId: "sub_rentas",
      priceId: "price_rentas",
      seats: 5,
      status: "activa",
      currentPeriodEnd: null,
    });

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/organizaciones", { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { organizaciones: Array<{ organizationId: string; precioConocido: boolean; seatsFacturablesSegunReal: number | null; mrrMxn: number | null; descuadreAsientos: number; staffCount: number; seats: number }> };
    const org = body.organizaciones.find((o) => o.organizationId === organizationId)!;
    expect(org.precioConocido).toBe(false);
    expect(org.seatsFacturablesSegunReal).toBeNull();
    expect(org.mrrMxn).toBeNull();
    expect(org.staffCount).toBe(1);
    expect(org.descuadreAsientos).toBe(5 - 1); // comparación directa contra headcount real
  });

  it("filtra por estado vía query param", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const { token } = await makeSuperadmin(base);
    const cancelada = seedOrgActivaHoteles(coreRepo);
    await coreRepo.upsertOrganizationBilling({ organizationId: cancelada, stripeCustomerId: "cus_cancelada", stripeSubscriptionId: null, priceId: null, seats: 0, status: "cancelada", currentPeriodEnd: null });

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/organizaciones?estado=cancelada", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizaciones: Array<{ organizationId: string; billingStatus: string }> };
    expect(body.organizaciones.every((o) => o.billingStatus === "cancelada")).toBe(true);
    expect(body.organizaciones.some((o) => o.organizationId === cancelada)).toBe(true);
  });

  it("un estado inválido en el filtro responde 400", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/organizaciones?estado=no-es-un-estado", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
  });
});

describe("GET /superadmin/facturacion/resumen", () => {
  it("un staff normal recibe 403", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/resumen", { headers: { authorization: `Bearer ${await staffToken(base)}` } });
    expect(res.status).toBe(403);
  });

  it("agrega MRR real (solo organizaciones activas con precio conocido), conteo por estado, morosos y próximas renovaciones", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const { token } = await makeSuperadmin(base);

    // Org 1: hoteles, activa, 10 seats -- precio conocido, aporta MRR real.
    const org1 = seedOrgActivaHoteles(coreRepo);
    await coreRepo.upsertOrganizationBilling({ organizationId: org1, stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", priceId: "price_1", seats: 10, status: "activa", currentPeriodEnd: new Date("2026-03-01T00:00:00.000Z").toISOString() });

    // Org 2: restaurantes, activa, 2 seats -- también precio conocido.
    const org2 = randomUUID();
    coreRepo.addOrganization({ id: org2, slug: "resto-resumen", name: "Restaurante Resumen", vertical: "restaurantes", status: "active", createdAt: new Date().toISOString() });
    await coreRepo.upsertOrganizationBilling({ organizationId: org2, stripeCustomerId: "cus_2", stripeSubscriptionId: "sub_2", priceId: "price_2", seats: 2, status: "activa", currentPeriodEnd: new Date("2026-02-01T00:00:00.000Z").toISOString() });

    // Org 3: pago_pendiente (morosa) -- nunca cuenta para MRR.
    const org3 = seedOrgActivaHoteles(coreRepo);
    await coreRepo.upsertOrganizationBilling({ organizationId: org3, stripeCustomerId: "cus_3", stripeSubscriptionId: "sub_3", priceId: "price_3", seats: 4, status: "pago_pendiente", currentPeriodEnd: null });

    // Org 4: cancelada.
    const org4 = seedOrgActivaHoteles(coreRepo);
    await coreRepo.upsertOrganizationBilling({ organizationId: org4, stripeCustomerId: "cus_4", stripeSubscriptionId: null, priceId: null, seats: 0, status: "cancelada", currentPeriodEnd: null });

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/resumen", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalOrganizaciones: number;
      conteoPorEstado: Record<string, number>;
      morosos: number;
      mrrMxn: number | null;
      proximasRenovaciones: Array<{ organizationId: string }>;
    };

    expect(body.conteoPorEstado.activa).toBe(2);
    expect(body.conteoPorEstado.pago_pendiente).toBe(1);
    expect(body.conteoPorEstado.cancelada).toBe(1);
    expect(body.morosos).toBe(1);
    expect(body.mrrMxn).toBe(10 * SEAT_HOTELES.precioPorSeatMxn + 2 * SEAT_RESTAURANTES.precioPorSeatMxn);
    // Próxima renovación primero (org2 vence antes que org1).
    expect(body.proximasRenovaciones[0]?.organizationId).toBe(org2);
    expect(body.proximasRenovaciones[1]?.organizationId).toBe(org1);
  });

  it("cuando NINGUNA organización activa tiene precio conocido, el MRR total es null -- nunca 0 inventado", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const { token } = await makeSuperadmin(base);

    const organizationId = randomUUID();
    coreRepo.addOrganization({ id: organizationId, slug: "licitaciones-resumen", name: "Licitaciones Resumen", vertical: "licitaciones", status: "active", createdAt: new Date().toISOString() });
    await coreRepo.upsertOrganizationBilling({ organizationId, stripeCustomerId: "cus_lic", stripeSubscriptionId: "sub_lic", priceId: "price_lic", seats: 3, status: "activa", currentPeriodEnd: null });

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/resumen", { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { mrrMxn: number | null; organizacionesActivasConPrecioDesconocido: number };
    expect(body.mrrMxn).toBeNull();
    expect(body.organizacionesActivasConPrecioDesconocido).toBe(1);
  });
});

describe("GET /superadmin/facturacion/webhooks-recientes", () => {
  it("un staff normal recibe 403", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/webhooks-recientes", { headers: { authorization: `Bearer ${await staffToken(base)}` } });
    expect(res.status).toBe(403);
  });

  it("lista los eventos ya procesados, más recientes primero, con el total real", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const { token } = await makeSuperadmin(base);

    await coreRepo.markBillingWebhookEventSeen("evt_1");
    await coreRepo.markBillingWebhookEventSeen("evt_2");
    await coreRepo.markBillingWebhookEventSeen("evt_3");

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/webhooks-recientes?limit=2", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { eventos: Array<{ eventId: string; processedAt: string }>; total: number };
    expect(body.eventos).toHaveLength(2);
    expect(body.total).toBe(3);
  });
});

describe("GET /superadmin/facturacion/webhooks-bitacora", () => {
  it("un staff normal recibe 403", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/webhooks-bitacora", { headers: { authorization: `Bearer ${await staffToken(base)}` } });
    expect(res.status).toBe(403);
  });

  it("un superadmin real lista la bitácora completa, filtrable por result/organizationId, paginada", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const { token } = await makeSuperadmin(base);

    await coreRepo.recordBillingWebhookEvent({ providerEventId: null, eventType: null, organizationId: null, result: "rechazado", reason: "firma_invalida" });
    await coreRepo.recordBillingWebhookEvent({ providerEventId: "evt_ok", eventType: "checkout.session.completed", organizationId: base.organizationId, result: "procesado", reason: "aplicado" });
    await coreRepo.recordBillingWebhookEvent({ providerEventId: "evt_dup", eventType: "checkout.session.completed", organizationId: base.organizationId, result: "ignorado", reason: "duplicado" });

    const app = buildApp(base.deps);

    const sinFiltro = await app.request("/superadmin/facturacion/webhooks-bitacora", { headers: { authorization: `Bearer ${token}` } });
    expect(sinFiltro.status).toBe(200);
    const bodySinFiltro = (await sinFiltro.json()) as { disponible: boolean; rows: Array<{ result: string; reason: string }>; total: number };
    expect(bodySinFiltro).toMatchObject({ disponible: true, total: 3 });
    expect(bodySinFiltro.rows).toHaveLength(3);

    const soloRechazados = await app.request("/superadmin/facturacion/webhooks-bitacora?result=rechazado", { headers: { authorization: `Bearer ${token}` } });
    const bodyRechazados = (await soloRechazados.json()) as { total: number; rows: Array<{ reason: string }> };
    expect(bodyRechazados.total).toBe(1);
    expect(bodyRechazados.rows[0]).toMatchObject({ reason: "firma_invalida" });

    const porOrganizacion = await app.request(`/superadmin/facturacion/webhooks-bitacora?organizationId=${base.organizationId}`, { headers: { authorization: `Bearer ${token}` } });
    const bodyPorOrg = (await porOrganizacion.json()) as { total: number };
    expect(bodyPorOrg.total).toBe(2);

    const paginado = await app.request("/superadmin/facturacion/webhooks-bitacora?limit=1&offset=1", { headers: { authorization: `Bearer ${token}` } });
    const bodyPaginado = (await paginado.json()) as { total: number; rows: unknown[] };
    expect(bodyPaginado.total).toBe(3);
    expect(bodyPaginado.rows).toHaveLength(1);
  });

  it("un result inválido en el filtro responde 400", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/webhooks-bitacora?result=no-es-un-resultado", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
  });

  it("un rango de fechas inválido responde 400", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/webhooks-bitacora?desde=no-es-una-fecha", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
  });

  // Revisión de PR #153 (bloqueante 3): `Date.parse` acepta entradas laxas
  // (p.ej. "2026", solo el año) que Postgres SÍ rechaza como `timestamptz`
  // real (22007) -- la ruta normaliza a ISO completo ANTES de que el filtro
  // llegue al repositorio, así que una fecha laxa pero parseable nunca debe
  // tumbar la request con un error.
  it("una fecha laxa pero parseable (solo el año) se normaliza a ISO completo, sin 500", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/webhooks-bitacora?desde=2026", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  // Revisión de PR #153 (bloqueante 3): un `organizationId` parcial/no-UUID
  // (p.ej. mientras el usuario todavía teclea en el filtro de la UI) llegaba
  // crudo hasta el parámetro `uuid` de la función SQL -> Postgres 22P02 ->
  // 500 genérico. Debe rechazarse ANTES, con 400 explícito.
  it("un organizationId que no es UUID responde 400 (nunca deja que Postgres decida)", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/webhooks-bitacora?organizationId=no-es-un-uuid", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
  });

  it("un organizationId parcial (UUID incompleto, típico de estar tecleando) también responde 400", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/webhooks-bitacora?organizationId=00000000-0000-0000-0000", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
  });

  // Revisión de PR #153 (bloqueante 1): el único caso `disponible: false` que
  // existía en el repo era un stub de fetch de UI
  // (`apps/web/tests/superadmin-facturacion-page.spec.tsx:222`), que no
  // ejerce el repositorio real -- este SÍ ejercita la ruta completa contra un
  // repositorio que simula la migración `0018_billing_webhook_registro.sql`
  // sin aplicar.
  it("cuando el repositorio reporta disponible:false (migración sin aplicar), la ruta responde 200 con 'no disponible aún', nunca 500", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const { token } = await makeSuperadmin(base);
    const originalMethod = coreRepo.listBillingWebhookLogForSuperadmin.bind(coreRepo);
    coreRepo.listBillingWebhookLogForSuperadmin = async (callerId, filters) => {
      await originalMethod(callerId, filters);
      return { disponible: false, rows: [], total: 0 };
    };
    const app = buildApp(base.deps);

    const res = await app.request("/superadmin/facturacion/webhooks-bitacora", { headers: { authorization: `Bearer ${token}` } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; rows: unknown[]; total: number };
    expect(body).toEqual({ disponible: false, rows: [], total: 0 });
  });

  it("sin ninguna fila todavía, responde vacío honesto (disponible: true, total: 0) -- nunca un error", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/facturacion/webhooks-bitacora", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; rows: unknown[]; total: number };
    expect(body).toEqual({ disponible: true, rows: [], total: 0 });
  });
});

describe("POST /superadmin/facturacion/organizaciones/:id/checkout", () => {
  it("un staff normal (no superadmin) recibe 403", async () => {
    const base = await buildTestDeps();
    const app = buildApp({ ...base.deps, saasBillingStripeClient: new FakeSaasStripeClient() });
    const res = await app.request(`/superadmin/facturacion/organizaciones/${base.organizationId}/checkout`, {
      method: "POST",
      headers: { authorization: `Bearer ${await staffToken(base)}`, "content-type": "application/json" },
      body: JSON.stringify({ priceId: "price_1", seats: 1 }),
    });
    expect(res.status).toBe(403);
  });

  it("sin STRIPE_SECRET_KEY configurada responde 503 honesto, nunca finge una URL", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps); // sin saasBillingStripeClient

    const res = await app.request(`/superadmin/facturacion/organizaciones/${base.organizationId}/checkout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ priceId: "price_1", seats: 1 }),
    });
    expect(res.status).toBe(503);
  });

  it("un superadmin real genera el enlace de checkout reutilizando la lógica existente -- aunque no sea miembro de la organización", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const stripe = new FakeSaasStripeClient();
    const app = buildApp({ ...base.deps, saasBillingStripeClient: stripe });

    const res = await app.request(`/superadmin/facturacion/organizaciones/${base.organizationId}/checkout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ priceId: "price_real_599", seats: 5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain("price_real_599");
    expect(stripe.calls).toHaveLength(1);
    expect(stripe.calls[0]).toMatchObject({ priceId: "price_real_599", cantidadSeats: 5 });
  });

  it("una organización inexistente responde 404", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp({ ...base.deps, saasBillingStripeClient: new FakeSaasStripeClient() });

    const res = await app.request(`/superadmin/facturacion/organizaciones/${randomUUID()}/checkout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ priceId: "price_1", seats: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it("seats inválido responde 400 de validación", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp({ ...base.deps, saasBillingStripeClient: new FakeSaasStripeClient() });

    const res = await app.request(`/superadmin/facturacion/organizaciones/${base.organizationId}/checkout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ priceId: "price_1", seats: 0 }),
    });
    expect(res.status).toBe(400);
  });
});
