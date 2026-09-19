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
//
// `verificarFirmaWebhookStripe` es la ÚNICA excepción parcial a "el SDK no vive
// aquí": no es una llamada HTTP ni depende del SDK de Stripe (solo HMAC-SHA256
// con `node:crypto`, mismo criterio exacto que
// `domain-restaurantes/src/whatsapp/meta-signature.ts::verifyMetaSignature`
// para Meta) — es la REGLA DE NEGOCIO de seguridad que
// `packages/billing/src/types.ts::EventoWebhook` asume ya aplicada ("Un evento
// de proveedor de pagos ya verificado en firma... eso lo hace la app, con su
// propio secreto de webhook"): el caller (`apps/api/src/routes/billing.ts`) usa
// esta función exactamente para esa parte del contrato, sin reinventar el
// algoritmo de Stripe ni dejarlo desperdigado en la capa HTTP.
// ═══════════════════════════════════════════════════════════════════════════

import { createHmac, timingSafeEqual } from "node:crypto";

function constantTimeHexEqual(actual: string, expected: string): boolean {
  let actualBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    actualBuf = Buffer.from(actual, "hex");
    expectedBuf = Buffer.from(expected, "hex");
  } catch {
    return false;
  }
  if (actualBuf.length !== expectedBuf.length || actualBuf.length === 0) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}

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

/**
 * Verifica el header `Stripe-Signature` de un webhook real de Stripe —
 * algoritmo documentado de Stripe (https://stripe.com/docs/webhooks#verify-manually):
 * el header trae `t=<timestamp-unix>,v1=<hmac-hex>[,v1=<hmac-hex>...]` (más de
 * un `v1` durante una rotación de secreto de Stripe — CUALQUIERA que coincida
 * es válido); el HMAC-SHA256 se calcula sobre `${timestamp}.${payload}` con el
 * secreto de firma del endpoint (`whsec_...`, NUNCA el `STRIPE_SECRET_KEY` de
 * la cuenta — son dos secretos distintos).
 *
 * NUNCA se procesa un evento sin esto — es la única prueba de que el evento es
 * realmente de Stripe y no un `checkout.session.completed` falsificado por
 * cualquiera que sepa la URL del webhook (ver el comentario de cabecera de
 * `packages/billing/src/types.ts::EventoWebhook`).
 *
 * `payload` DEBE ser el texto crudo exacto del body (nunca `JSON.stringify` de
 * un objeto ya parseado/re-serializado — mismo detalle crítico que documenta
 * `domain-restaurantes/src/whatsapp/meta-signature.ts` para Meta: re-serializar
 * puede reordenar claves o cambiar espacios y el HMAC ya no coincide).
 *
 * Tolerancia de reloj de 5 minutos por defecto (mismo default que la librería
 * oficial de Stripe) contra un replay de un evento viejo interceptado —
 * defensa EN ADICIÓN al ledger de `ledger.ts` (ese cierra reordenamiento/
 * duplicado de eventos YA verificados en firma, esto cierra un evento
 * verdadero pero re-enviado mucho después de capturado en tránsito).
 */
export function verificarFirmaWebhookStripe(opts: {
  payload: string;
  signatureHeader: string | null;
  /** Secreto de firma del endpoint de webhook (`whsec_...`). `null` = webhook
   *  sin configurar en este entorno — el caller ya debió responder 503 ANTES de
   *  llegar aquí (nunca se llega a esta función sin secreto en el flujo real),
   *  pero por defensa en profundidad esto también rechaza en vez de aceptar
   *  a ciegas. */
  secret: string | null;
  toleranceSeconds?: number;
  /** Epoch actual en segundos — parametrizable solo para pruebas
   *  determinísticas; en producción siempre `Date.now() / 1000`. */
  nowUnix?: number;
}): boolean {
  const { payload, signatureHeader, secret, toleranceSeconds = 300, nowUnix = Math.floor(Date.now() / 1000) } = opts;
  if (!secret || !signatureHeader) return false;

  let timestamp: number | null = null;
  const candidateSignatures: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value) timestamp = Number(value);
    else if (key === 'v1' && value) candidateSignatures.push(value);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || candidateSignatures.length === 0) return false;
  if (Math.abs(nowUnix - timestamp) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');
  return candidateSignatures.some((candidate) => constantTimeHexEqual(candidate, expected));
}
