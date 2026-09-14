// ═══════════════════════════════════════════════════════════════════════════
// RIEL DE STRIPE — puerto de las validaciones reales de
// ~/proyecto-origen/src/lib/saas/suscripcion.ts::guardarPriceDePlan y del patrón
// per-seat de ~/GitHub-repos-backup/atiende.ai/.../billing/per-doctor.ts
// (createDoctorCheckout), generalizado a cualquier vertical/seat.
//
// El SDK de Stripe no vive aquí — igual que el resto del motor, entra por
// una interfaz (`StripeClient`) que la app implementa. Este archivo solo
// contiene las REGLAS DE NEGOCIO alrededor de Stripe: qué price se acepta y
// cómo se arma un checkout per-seat, no las llamadas HTTP en sí.
// ═══════════════════════════════════════════════════════════════════════════

export interface PriceStripe {
  id: string;
  activo: boolean;
  recurrente: boolean;
  moneda: string; // ISO 4217 en minúsculas, como lo devuelve Stripe ('mxn')
  montoUnitarioCentavos: number;
}

export class PriceStripeInvalido extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Las mismas cuatro comprobaciones que `guardarPriceDePlan` en el proyecto origen, antes
 * de aceptar un price de Stripe como el precio de un plan/seat:
 *   - tiene que ser recurrente (un pago único cobraría una vez y el tenant
 *     quedaría con el seat activo para siempre);
 *   - tiene que estar activo en Stripe;
 *   - tiene que cobrar en MXN (todo el producto imprime pesos);
 *   - tiene que cobrar más de $0 (un plan en $0 se ve contratado y no cobra
 *     nunca — si es cortesía se asigna a mano, no se acepta un price gratis).
 */
export function validarPriceParaSeat(price: PriceStripe): void {
  if (!price.recurrente) {
    throw new PriceStripeInvalido(
      `Price ${price.id} es de pago único, no de suscripción. Cobraría una vez y el seat quedaría activo para siempre.`,
    );
  }
  if (!price.activo) {
    throw new PriceStripeInvalido(`Price ${price.id} está archivado en Stripe: no se puede cobrar con él.`);
  }
  if (price.moneda.toLowerCase() !== 'mxn') {
    throw new PriceStripeInvalido(
      `Price ${price.id} cobra en ${price.moneda.toUpperCase()}, no en MXN. Todo el panel imprime pesos mexicanos.`,
    );
  }
  if (!(price.montoUnitarioCentavos > 0)) {
    throw new PriceStripeInvalido(
      `Price ${price.id} cobra $0. Un seat gratis se ve contratado y no cobra nunca; si es cortesía, se asigna a mano.`,
    );
  }
}

export interface StripeClient {
  crearSesionCheckout(opts: {
    customerId?: string;
    priceId: string;
    cantidadSeats: number;
    metadata: Record<string, string>;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }>;
}

/**
 * Arma el checkout de un seat per-seat (1 subscription, `cantidadSeats`
 * unidades del mismo price) para CUALQUIER vertical. La metadata SIEMPRE
 * incluye `tenant_id` y `vertical` — es lo que `tenant-verification.ts`
 * exige re-derivar del lado del webhook, nunca confiar a ciegas.
 */
export async function crearCheckoutPerSeat(
  stripe: StripeClient,
  opts: {
    tenantId: string;
    vertical: string;
    priceId: string;
    cantidadSeats: number;
    customerId?: string;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<{ url: string }> {
  if (opts.cantidadSeats < 1) {
    throw new Error('No se arma un checkout de 0 seats.');
  }
  return stripe.crearSesionCheckout({
    customerId: opts.customerId,
    priceId: opts.priceId,
    cantidadSeats: opts.cantidadSeats,
    metadata: { tenant_id: opts.tenantId, vertical: opts.vertical },
    successUrl: opts.successUrl,
    cancelUrl: opts.cancelUrl,
  });
}
