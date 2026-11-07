// Onboarding P0: el webhook de Stripe activa la organizacion en prueba cuando confirma un pago (migracion 0072,
// `core.organization_activate_on_payment`). Solo un pago real activa: checkout con payment_status "paid" o suscripcion "active".
// Un checkout sin cobro, una suscripcion "trialing", o una organizacion suspendida no cambian el estado. Un fallo de la activacion
// nunca convierte el webhook en 500 (el billing ya se guardo y el ledger ya sello el evento).
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryCoreRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { eventoConfirmaPago } from "../src/routes/billing.ts";
import { buildTestDeps } from "./fixtures.ts";

const SECRET = "whsec_test_secreto";
const SUPER = "00000000-0000-0000-0000-0000000f7b99";

function firmar(ts: number, payload: string): string {
  return `t=${ts},v1=${createHmac("sha256", SECRET).update(`${ts}.${payload}`, "utf8").digest("hex")}`;
}

function evento(tipo: string, objeto: Record<string, unknown>, orgId: string, customer: string): { payload: string; ts: number } {
  const ts = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ id: `evt_${randomUUID()}`, object: "event", type: tipo, created: ts, data: { object: { customer, metadata: { tenant_id: orgId, vertical: "citas" }, ...objeto } } });
  return { payload, ts };
}

async function escenario(status: "trial" | "active" | "suspended") {
  const base = await buildTestDeps();
  const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
  const orgId = randomUUID();
  const customer = `cus_${orgId.slice(0, 8)}`;
  coreRepo.addOrganization({ id: orgId, slug: `org-${orgId.slice(0, 8)}`, name: "Consultorio", vertical: "citas", status });
  coreRepo.addStaff({ id: SUPER, email: "super@example.com", fullName: "Super", passwordHash: null, createdVia: "seed", emailVerifiedAt: null });
  coreRepo.addPlatformSuperadmin(SUPER);
  // Customer ya registrado (CASO 1 de verificarTenantDelWebhook): el evento debe traer el mismo.
  await coreRepo.upsertOrganizationBilling({ organizationId: orgId, stripeCustomerId: customer, stripeSubscriptionId: null, priceId: null, seats: 0, status: "pago_pendiente", currentPeriodEnd: null });
  const deps = { ...base.deps, saasBillingWebhookSecret: SECRET };
  const app = buildApp(deps);
  const enviar = async (tipo: string, objeto: Record<string, unknown>) => {
    const { payload, ts } = evento(tipo, objeto, orgId, customer);
    return app.request("/billing/webhook", { method: "POST", body: payload, headers: { "content-type": "application/json", "stripe-signature": firmar(ts, payload) } });
  };
  const status_ = async () => (await coreRepo.listAllOrganizationsForSuperadmin(SUPER)).find((o) => o.id === orgId)?.status;
  return { coreRepo, orgId, enviar, status: status_ };
}

describe("POST /billing/webhook activa la prueba al confirmar el pago", () => {
  it("checkout.session.completed pagado: trial -> active", async () => {
    const e = await escenario("trial");
    const res = await e.enviar("checkout.session.completed", { subscription: "sub_1", payment_status: "paid" });
    expect(res.status).toBe(200);
    expect(await e.status()).toBe("active");
  });

  it("customer.subscription.created con status active: trial -> active", async () => {
    const e = await escenario("trial");
    const res = await e.enviar("customer.subscription.created", { id: "sub_2", status: "active", current_period_end: 1900000000, items: { data: [{ quantity: 1, price: { id: "price_1" } }] } });
    expect(res.status).toBe(200);
    expect(await e.status()).toBe("active");
  });

  it("checkout sin cobro (no_payment_required) o suscripcion 'trialing' NO activan", async () => {
    const e = await escenario("trial");
    await e.enviar("checkout.session.completed", { subscription: "sub_3", payment_status: "no_payment_required" });
    await e.enviar("customer.subscription.updated", { id: "sub_3", status: "trialing", current_period_end: 1900000000, items: { data: [{ quantity: 1, price: { id: "price_1" } }] } });
    expect(await e.status()).toBe("trial");
  });

  it("una organizacion suspendida NO se reactiva por un pago", async () => {
    const e = await escenario("suspended");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await e.enviar("checkout.session.completed", { subscription: "sub_4", payment_status: "paid" });
    expect(res.status).toBe(200);
    expect(await e.status()).toBe("suspended");
    warn.mockRestore();
  });

  it("si la activacion falla, el webhook responde 200 igual (el billing ya quedo guardado)", async () => {
    const e = await escenario("trial");
    vi.spyOn(e.coreRepo, "activateOrganizationOnPayment").mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "57P01" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await e.enviar("checkout.session.completed", { subscription: "sub_5", payment_status: "paid" });
    expect(res.status).toBe(200);
    expect(await e.coreRepo.getOrganizationBillingForWebhook(e.orgId)).toMatchObject({ status: "activa", stripeSubscriptionId: "sub_5" });
    expect(await e.status()).toBe("trial");
    error.mockRestore();
  });
});

describe("eventoConfirmaPago", () => {
  it.each([
    ["checkout.session.completed", { payment_status: "paid" }, true],
    ["checkout.session.completed", { payment_status: "unpaid" }, false],
    ["checkout.session.completed", { payment_status: "no_payment_required" }, false],
    ["customer.subscription.created", { status: "active" }, true],
    ["customer.subscription.updated", { status: "active" }, true],
    ["customer.subscription.updated", { status: "trialing" }, false],
    ["customer.subscription.updated", { status: "past_due" }, false],
    ["customer.subscription.deleted", { status: "active" }, false],
  ] as const)("%s %j -> %s", (tipo, datos, esperado) => {
    expect(eventoConfirmaPago(tipo, datos)).toBe(esperado);
  });
});
