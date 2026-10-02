// Portal de cliente de Stripe (Billing Portal) para la suscripcion SaaS PROPIA de Atiende (PL-16). El cliente administra su
// metodo de pago, facturas y cancelacion en el portal alojado por Stripe; aqui solo se crea la sesion.
//
// Sin STRIPE_SECRET_KEY o sin customer de Stripe en la organizacion NO se inventa una URL: el llamador responde un estado
// honesto "no configurado" (ver apps/api/src/routes/billing.ts). El portal real ademas requiere que alguien configure el portal
// en el dashboard de Stripe (una vez); mientras no exista, Stripe responde un error y la ruta lo propaga como 502.

export interface StripeBillingPortalClient {
  crearSesionPortal(opts: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
}

export class PortalFacturacionInvalido extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalFacturacionInvalido";
  }
}

const CUSTOMER_RE = /^cus_[A-Za-z0-9]{6,}$/;

/** Valida los datos y delega en el cliente. `returnUrl` debe ser absoluta http(s): Stripe la usa para el boton "volver". */
export async function crearSesionPortalFacturacion(
  client: StripeBillingPortalClient,
  opts: { customerId: string; returnUrl: string },
): Promise<{ url: string }> {
  if (!CUSTOMER_RE.test(opts.customerId)) throw new PortalFacturacionInvalido("customerId invalido: se esperaba un customer de Stripe (cus_...).");
  let parsed: URL;
  try {
    parsed = new URL(opts.returnUrl);
  } catch {
    throw new PortalFacturacionInvalido("returnUrl invalida: se esperaba una URL absoluta.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new PortalFacturacionInvalido("returnUrl invalida: solo http(s).");
  const { url } = await client.crearSesionPortal(opts);
  if (typeof url !== "string" || url.length === 0) throw new Error("Stripe no devolvio la URL del portal.");
  return { url };
}
