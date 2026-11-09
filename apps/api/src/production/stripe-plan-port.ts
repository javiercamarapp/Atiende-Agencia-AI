// Adaptador HTTP real de Stripe para la suscripcion POR PLAN (precios de la lista permitida, IVA, medidos, SPEI y reporte de
// uso). `fetch` nativo y `application/x-www-form-urlencoded`, igual que saas-billing-stripe-port.ts. Las REGLAS (que precio
// se acepta, como se arman los renglones) viven en @atiende/billing/stripe-plan.ts; aqui solo las llamadas.
import type { LineItemSuscripcion, PrecioStripeDetalle } from "@atiende/billing";

export interface StripePlanClient {
  leerPrecio(priceId: string): Promise<PrecioStripeDetalle>;
  crearCustomer(opts: { email: string; nombre: string; metadata: Record<string, string> }): Promise<{ id: string }>;
  crearCheckoutPlan(opts: { customerId?: string; lineItems: readonly LineItemSuscripcion[]; metadata: Record<string, string>; taxRateId: string; anclaUnix: number; successUrl: string; cancelUrl: string }): Promise<{ url: string }>;
  /** Suscripcion cobrada por FACTURA (SPEI a CLABE virtual de Stripe; `customer_balance` + `mx_bank_transfer`). */
  crearSuscripcionFactura(opts: { customerId: string; lineItems: readonly LineItemSuscripcion[]; metadata: Record<string, string>; taxRateId: string; anclaUnix: number; diasParaPagar: number }): Promise<{ id: string }>;
  reportarUsoMedido(opts: { eventName: string; customerId: string; value: number; timestampUnix: number; identifier: string }): Promise<void>;
}

async function llamar(fetchImpl: typeof fetch, secretKey: string, metodo: "GET" | "POST", ruta: string, body?: URLSearchParams, idempotencia?: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}` };
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencia) headers["Idempotency-Key"] = idempotencia;
  const res = await fetchImpl(`https://api.stripe.com${ruta}`, { method: metodo, headers, body });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Stripe respondio ${res.status} en ${ruta}: ${json.error?.message ?? ""}`.trim());
  return json;
}

function agregarItems(body: URLSearchParams, prefijo: string, items: readonly LineItemSuscripcion[], conUnicos: "line_items" | "add_invoice_items", taxRateId?: string): void {
  let i = 0;
  let j = 0;
  for (const it of items) {
    if (it.unico) {
      const k = conUnicos === "line_items" ? `${prefijo}[${i++}]` : `add_invoice_items[${j++}]`;
      body.append(`${k}[price]`, it.price);
      if (conUnicos === "add_invoice_items" && taxRateId) body.append(`${k}[tax_rates][0]`, taxRateId);
      if (it.quantity !== undefined) body.append(`${k}[quantity]`, String(it.quantity));
      continue;
    }
    body.append(`${prefijo}[${i}][price]`, it.price);
    if (it.quantity !== undefined) body.append(`${prefijo}[${i}][quantity]`, String(it.quantity));
    i++;
  }
}

export class HttpStripePlanClient implements StripePlanClient {
  constructor(private readonly fetchImpl: typeof fetch, private readonly secretKey: string) {}

  async leerPrecio(priceId: string): Promise<PrecioStripeDetalle> {
    const j = await llamar(this.fetchImpl, this.secretKey, "GET", `/v1/prices/${encodeURIComponent(priceId)}`);
    const rec = (j.recurring ?? null) as { usage_type?: string; meter?: string | null } | null;
    return {
      id: String(j.id),
      activo: j.active === true,
      moneda: String(j.currency ?? ""),
      montoUnitarioCentavos: typeof j.unit_amount === "number" ? j.unit_amount : null,
      tipo: j.type === "one_time" ? "one_time" : "recurring",
      usoMedido: rec?.usage_type === "metered",
      meterId: typeof rec?.meter === "string" ? rec.meter : null,
    };
  }

  async crearCustomer(opts: { email: string; nombre: string; metadata: Record<string, string> }): Promise<{ id: string }> {
    const b = new URLSearchParams();
    b.append("email", opts.email);
    b.append("name", opts.nombre);
    for (const [k, v] of Object.entries(opts.metadata)) b.append(`metadata[${k}]`, v);
    const j = await llamar(this.fetchImpl, this.secretKey, "POST", "/v1/customers", b, `customer/${opts.metadata.tenant_id ?? opts.email}`);
    return { id: String(j.id) };
  }

  async crearCheckoutPlan(opts: { customerId?: string; lineItems: readonly LineItemSuscripcion[]; metadata: Record<string, string>; taxRateId: string; anclaUnix: number; successUrl: string; cancelUrl: string }): Promise<{ url: string }> {
    const b = new URLSearchParams();
    b.append("mode", "subscription");
    agregarItems(b, "line_items", opts.lineItems, "line_items");
    opts.lineItems.forEach((_it, idx) => b.append(`line_items[${idx}][tax_rates][0]`, opts.taxRateId));
    b.append("subscription_data[default_tax_rates][0]", opts.taxRateId);
    b.append("subscription_data[billing_cycle_anchor]", String(opts.anclaUnix));
    b.append("success_url", opts.successUrl);
    b.append("cancel_url", opts.cancelUrl);
    if (opts.customerId) b.append("customer", opts.customerId);
    for (const [k, v] of Object.entries(opts.metadata)) {
      b.append(`metadata[${k}]`, v);
      b.append(`subscription_data[metadata][${k}]`, v);
    }
    const j = await llamar(this.fetchImpl, this.secretKey, "POST", "/v1/checkout/sessions", b);
    if (typeof j.url !== "string") throw new Error("Stripe respondio 200 sin url de checkout.");
    return { url: j.url };
  }

  async crearSuscripcionFactura(opts: { customerId: string; lineItems: readonly LineItemSuscripcion[]; metadata: Record<string, string>; taxRateId: string; anclaUnix: number; diasParaPagar: number }): Promise<{ id: string }> {
    const b = new URLSearchParams();
    b.append("customer", opts.customerId);
    agregarItems(b, "items", opts.lineItems, "add_invoice_items", opts.taxRateId);
    b.append("collection_method", "send_invoice");
    b.append("days_until_due", String(opts.diasParaPagar));
    b.append("default_tax_rates[0]", opts.taxRateId);
    b.append("billing_cycle_anchor", String(opts.anclaUnix));
    b.append("payment_settings[payment_method_types][0]", "customer_balance");
    b.append("payment_settings[payment_method_options][customer_balance][funding_type]", "bank_transfer");
    b.append("payment_settings[payment_method_options][customer_balance][bank_transfer][type]", "mx_bank_transfer");
    for (const [k, v] of Object.entries(opts.metadata)) b.append(`metadata[${k}]`, v);
    const j = await llamar(this.fetchImpl, this.secretKey, "POST", "/v1/subscriptions", b, `suscripcion-spei/${opts.metadata.tenant_id ?? opts.customerId}/${opts.anclaUnix}`);
    return { id: String(j.id) };
  }

  async reportarUsoMedido(opts: { eventName: string; customerId: string; value: number; timestampUnix: number; identifier: string }): Promise<void> {
    const b = new URLSearchParams();
    b.append("event_name", opts.eventName);
    b.append("payload[stripe_customer_id]", opts.customerId);
    b.append("payload[value]", String(opts.value));
    b.append("timestamp", String(opts.timestampUnix));
    b.append("identifier", opts.identifier);
    await llamar(this.fetchImpl, this.secretKey, "POST", "/v1/billing/meter_events", b, opts.identifier);
  }
}
