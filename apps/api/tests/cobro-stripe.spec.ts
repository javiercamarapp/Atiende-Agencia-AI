// Stripe por plan: webhook de facturas (cobranza y CFDI), checkout por plan con IVA y lista permitida de precios. Repos en
// memoria y cliente de Stripe falso (la autorizacion real en SQL: scripts/verify-cobro-stripe-cobranza/).
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCobroStripeRepository } from "@atiende/db";
import type { LineItemSuscripcion, PrecioStripeDetalle } from "@atiende/billing";
import { buildApp } from "../src/app.ts";
import type { StripePlanClient } from "../src/production/stripe-plan-port.ts";
import { periodoDeFactura } from "../src/cobro/factura-webhook.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

const SECRETO = "whsec_prueba_cobro";
const firmar = (ts: number, payload: string) => `t=${ts},v1=${createHmac("sha256", SECRETO).update(`${ts}.${payload}`, "utf8").digest("hex")}`;
const raw = (body: string, headers: Record<string, string>): RequestInit => ({ method: "POST", body, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...headers } });

class FakeStripePlan implements StripePlanClient {
  checkouts: Array<{ lineItems: readonly LineItemSuscripcion[]; taxRateId: string; anclaUnix: number }> = [];
  precio: PrecioStripeDetalle = { id: "price_SUCURSAL01", activo: true, moneda: "mxn", montoUnitarioCentavos: 769000, tipo: "recurring", usoMedido: false, meterId: null };
  async leerPrecio() { return this.precio; }
  async crearCustomer() { return { id: "cus_nuevo" }; }
  async crearCheckoutPlan(o: { lineItems: readonly LineItemSuscripcion[]; taxRateId: string; anclaUnix: number }) { this.checkouts.push(o); return { url: "https://checkout.stripe.com/prueba" }; }
  async crearSuscripcionFactura() { return { id: "sub_spei" }; }
  async reportarUsoMedido() {}
}

async function setup(env: { iva?: string | null } = { iva: "txr_IVA16" }) {
  const s = await seguridadSetup({ env: { stripe: { secretKey: "sk_test_x", webhookSecret: SECRETO, ivaTaxRateId: env.iva ?? null } } });
  const repo = new InMemoryCobroStripeRepository();
  const stripe = new FakeStripePlan();
  const org = s.base.organizationId;
  repo.precios.set(org, { organizationId: org, planId: "restaurantes-pro", sucursalesActivas: 2, precios: [
    { componente: "sucursal", priceId: "price_SUCURSAL01", meterEventName: null },
    { componente: "minuto_voz_excedente", priceId: "price_MINUTO0001", meterEventName: "atiende_minutos_voz" },
    { componente: "alta", priceId: "price_ALTA000001", meterEventName: null },
  ] });
  await s.deps.coreRepo.upsertOrganizationBilling({ organizationId: org, stripeCustomerId: "cus_pm", stripeSubscriptionId: null, priceId: null, seats: 0, status: "sin_suscripcion", currentPeriodEnd: null });
  const legado: string[] = [];
  const saasBillingStripeClient = { async crearSesionCheckout(o: { priceId: string }) { legado.push(o.priceId); return { url: "https://checkout.stripe.com/legado" }; } };
  const deps = { ...s.deps, saasBillingWebhookSecret: SECRETO, cobroStripeRepo: () => repo, stripePlanClient: stripe, saasBillingStripeClient };
  return { s, app: buildApp(deps), repo, stripe, org, legado };
}

function factura(tipo: string, id: string, invoiceId: string, org: string, extra: Record<string, unknown> = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ id, object: "event", type: tipo, created: ts, data: { object: { id: invoiceId, customer: "cus_pm", subscription_details: { metadata: { tenant_id: org } }, ...extra } } });
  return { payload, header: firmar(ts, payload) };
}

describe("webhook de facturas", () => {
  it("tres pagos fallidos llevan la cobranza a pausa sugerida (nada se pausa solo)", async () => {
    const t = await setup();
    for (const [i, ev] of ["evt_f1", "evt_f2", "evt_f3"].entries()) {
      const f = factura("invoice.payment_failed", ev, `in_FALLIDA0${i}`, t.org, { attempt_count: i + 1, amount_due: 1784080 });
      expect((await t.app.request("/billing/webhook", raw(f.payload, { "stripe-signature": f.header }))).status).toBe(200);
    }
    expect(t.repo.cobranza.get(t.org)?.estado).toBe("pausa_sugerida");
  });

  it("factura pagada: al corriente y CFDI encolado una sola vez (el reintento del mismo evento no duplica)", async () => {
    const t = await setup();
    const f = factura("invoice.paid", "evt_p1", "in_PAGADA0001", t.org, { total: 1784080, tax: 246080, subtotal: 1538000 });
    await t.app.request("/billing/webhook", raw(f.payload, { "stripe-signature": f.header }));
    await t.app.request("/billing/webhook", raw(f.payload, { "stripe-signature": f.header }));
    expect(t.repo.cobranza.get(t.org)?.estado).toBe("al_corriente");
    expect([...t.repo.cfdi.values()]).toEqual([{ organizationId: t.org, subtotalCentavos: 1538000, ivaCentavos: 246080 }]);
  });

  it("una factura con customer de OTRA organizacion se rechaza (409)", async () => {
    const t = await setup();
    const ts = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ id: "evt_x", object: "event", type: "invoice.paid", created: ts, data: { object: { id: "in_AJENA00001", customer: "cus_otro", subscription_details: { metadata: { tenant_id: t.org } } } } });
    expect((await t.app.request("/billing/webhook", raw(payload, { "stripe-signature": firmar(ts, payload) }))).status).toBe(409);
    expect(t.repo.cfdi.size).toBe(0);
  });

  it("periodoDeFactura: la factura del 1-dic cobra el uso de noviembre", () => {
    expect(periodoDeFactura(Date.UTC(2026, 11, 1, 6) / 1000, "America/Merida")).toBe("2026-11-01");
  });
});

describe("checkout por plan", () => {
  it("usa SOLO la lista permitida del plan: sucursales por cantidad, medido sin cantidad, alta en la primera factura, IVA y ancla al dia 1", async () => {
    const t = await setup();
    const sa = await t.s.superadmin();
    const res = await t.app.request("/billing/checkout-plan", { ...jsonRequestInit({ organizationId: t.org }, bearer(sa.token)), method: "POST" });
    expect(res.status).toBe(200);
    const c = t.stripe.checkouts[0]!;
    expect(c.taxRateId).toBe("txr_IVA16");
    expect(c.lineItems).toEqual([{ price: "price_SUCURSAL01", quantity: 2 }, { price: "price_MINUTO0001" }, { price: "price_ALTA000001", quantity: 2, unico: true }]);
    expect(new Date(c.anclaUnix * 1000).getUTCDate()).toBe(1);
  });

  it("sin la tasa de IVA configurada no se cobra (503)", async () => {
    const t = await setup({ iva: null });
    const sa = await t.s.superadmin();
    expect((await t.app.request("/billing/checkout-plan", { ...jsonRequestInit({ organizationId: t.org }, bearer(sa.token)), method: "POST" })).status).toBe(503);
  });
});

describe("lista permitida de precios", () => {
  it("rechaza un precio en USD; acepta uno valido", async () => {
    const t = await setup();
    const sa = await t.s.superadmin();
    t.repo.superadmins.add(sa.id);
    t.stripe.precio = { ...t.stripe.precio, moneda: "usd" };
    const mal = await t.app.request("/superadmin/planes/restaurantes-pro/stripe-precios/sucursal", { ...jsonRequestInit({ priceId: "price_SUCURSAL01" }, bearer(sa.token)), method: "PUT" });
    expect(mal.status).toBe(400);
    t.stripe.precio = { ...t.stripe.precio, moneda: "mxn" };
    const bien = await t.app.request("/superadmin/planes/restaurantes-pro/stripe-precios/sucursal", { ...jsonRequestInit({ priceId: "price_SUCURSAL01" }, bearer(sa.token)), method: "PUT" });
    expect(bien.status).toBe(200);
    expect(t.repo.setPrecioLlamadas).toEqual([{ planId: "restaurantes-pro", componente: "sucursal", priceId: "price_SUCURSAL01" }]);
  });

  it("un staff normal no puede ligar precios (403)", async () => {
    const t = await setup();
    const st = await t.s.staff();
    expect((await t.app.request("/superadmin/planes/restaurantes-pro/stripe-precios/sucursal", { ...jsonRequestInit({ priceId: "price_SUCURSAL01" }, bearer(st.token)), method: "PUT" })).status).toBe(403);
  });
});

describe("POST /billing/checkout (legado) con la lista permitida", () => {
  it("un priceId fuera de la lista del plan se rechaza (400) sin llamar a Stripe", async () => {
    const t = await setup();
    const sa = await t.s.superadmin();
    const res = await t.app.request("/billing/checkout", { ...jsonRequestInit({ organizationId: t.org, priceId: "price_INVENTADO99", seats: 1 }, bearer(sa.token)), method: "POST" });
    expect(res.status).toBe(400);
    expect(t.legado).toHaveLength(0);
    const ok = await t.app.request("/billing/checkout", { ...jsonRequestInit({ organizationId: t.org, priceId: "price_SUCURSAL01", seats: 2 }, bearer(sa.token)), method: "POST" });
    expect(ok.status).toBe(200);
    expect(t.legado).toEqual(["price_SUCURSAL01"]);
  });
});
