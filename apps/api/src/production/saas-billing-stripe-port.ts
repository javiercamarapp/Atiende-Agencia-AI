// StripeSaasBillingCheckoutPort / StripeSaasBillingCustomerLookup — adaptadores
// reales de `@atiende/billing::StripeClient`/`CustomerLookup` (tenant-verification)
// para la suscripción SaaS PROPIA de Atiende a sus organizaciones clientes
// (auditoría de 22 rubros, hallazgo P1 #6), consumidos por `deps.ts` de
// `POST /billing/checkout`/`POST /billing/webhook` (ver `../routes/billing.ts`).
//
// Distinto de `StripeHotelesPaymentsPort` (`hoteles-payments-port.ts`, ese cobra
// al HUÉSPED final de un folio con PaymentIntents): este crea Checkout Sessions
// per-seat para que la ORGANIZACIÓN cliente pague su suscripción a la
// plataforma. Ambos pueden compartir la MISMA cuenta real de Stripe (un solo
// `STRIPE_SECRET_KEY`, ver `env.ts`) sin conflicto -- dos productos distintos
// de la misma cuenta, mismo criterio ya documentado en el encabezado de
// `hoteles-payments-port.ts`.
//
// `fetch` nativo (sin SDK) -- mismo patrón exacto que
// `hoteles-payments-port.ts`/`domain-*/src/email-dispatch.ts` (Resend)/
// `mcp-servers/cfdi` (Finkok/SW Sapien): el SDK del proveedor no vive en este
// monorepo, la llamada HTTP real sí. La API de Stripe espera
// `application/x-www-form-urlencoded` con notación de corchetes para objetos
// anidados (`metadata[tenant_id]`, `subscription_data[metadata][vertical]`),
// nunca JSON.
import type { CustomerLookup, StripeClient } from "@atiende/billing";

export interface SaasBillingStripeConfig {
  readonly secretKey: string;
}

function appendNested(body: URLSearchParams, key: string, value: string): void {
  body.append(key, value);
}

export class StripeSaasBillingCheckoutPort implements StripeClient {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly config: SaasBillingStripeConfig,
  ) {}

  async crearSesionCheckout(opts: {
    customerId?: string;
    priceId: string;
    cantidadSeats: number;
    metadata: Record<string, string>;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }> {
    const body = new URLSearchParams();
    body.append("mode", "subscription");
    body.append("line_items[0][price]", opts.priceId);
    body.append("line_items[0][quantity]", String(Math.round(opts.cantidadSeats)));
    body.append("success_url", opts.successUrl);
    body.append("cancel_url", opts.cancelUrl);
    if (opts.customerId) body.append("customer", opts.customerId);

    // La metadata va TANTO en la sesión (para leerla desde `checkout.session.
    // completed`) COMO en la subscription que Stripe crea al completar el pago
    // (`subscription_data[metadata]`) -- sin esto, los eventos posteriores
    // `customer.subscription.updated`/`.deleted` (los que de verdad mantienen
    // sincronizado seats/status/price, ver `../routes/billing.ts`) llegarían SIN
    // `tenant_id`/`vertical`, y `@atiende/billing::verificarTenantDelWebhook`
    // los rechazaría como `tenant_id_ausente` para siempre después del primer
    // evento. Stripe NO copia la metadata de la sesión a la subscription por su
    // cuenta -- hay que mandarla explícita en las dos partes.
    for (const [key, value] of Object.entries(opts.metadata)) {
      appendNested(body, `metadata[${key}]`, value);
      appendNested(body, `subscription_data[metadata][${key}]`, value);
    }

    const response = await this.fetchImpl("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const json = (await response.json()) as { url?: string; error?: { message?: string } };
    if (!response.ok) {
      throw new Error(`Stripe respondió ${response.status} al crear el checkout session: ${json.error?.message ?? await response.text().catch(() => "")}`);
    }
    if (!json.url) throw new Error("Stripe respondió 200 al crear el checkout session sin `url`.");
    return { url: json.url };
  }
}

/** Adaptador real de `CustomerLookup` (`@atiende/billing/tenant-verification.ts`)
 *  -- resuelve el email que Stripe tiene registrado para un customer, usado por
 *  `verificarTenantDelWebhook` en el CASO 2 (primer checkout de un tenant, sin
 *  customer guardado todavía: cruza email del customer contra el owner_email de
 *  la organización, ver el comentario de cabecera de ese archivo). */
export class StripeSaasBillingCustomerLookup implements CustomerLookup {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly config: SaasBillingStripeConfig,
  ) {}

  async getEmailDelCustomer(customerId: string): Promise<string | null> {
    const response = await this.fetchImpl(`https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}`, {
      headers: { Authorization: `Bearer ${this.config.secretKey}` },
    });
    if (!response.ok) {
      // Mismo criterio que documenta `tenant-verification.ts`: un fallo de RED al
      // consultar el customer NO bloquea (el evento ya trae firma válida de
      // Stripe) -- se resuelve `null` (sin dato) en vez de lanzar, para que
      // `verificarTenantDelWebhook` tome la rama "sin datos suficientes para
      // cruzar" en vez de tumbar el webhook completo por un 5xx/404 transitorio
      // de Stripe.
      return null;
    }
    const json = (await response.json().catch(() => null)) as { email?: string | null } | null;
    return json?.email ?? null;
  }
}
