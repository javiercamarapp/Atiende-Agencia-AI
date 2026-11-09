// StripeHotelesPaymentsPort — adaptador real de `PaymentsPort` (domain-hoteles)
// para `deps.hotelesPaymentsPort`, consumido por `production/deps.ts`.
//
// Hallazgo de auditoría (rubro 1/20, "puertos stub devuelven 500 tras confirmar
// en base de datos" / "hoteles: CFDI y pago con tarjeta imposibles de producto"):
// hasta este cambio, `hotelesPaymentsPort` era SIEMPRE `notProductionReady`
// (lanza incondicionalmente), sin importar qué credenciales estuvieran
// configuradas — a diferencia del resto de puertos externos de este monorepo
// (Resend, WhatsApp Graph API, Finkok/SW Sapien), que sí tienen un adaptador
// real listo para recibir la credencial. No existía NINGÚN código, real ni de
// SDK, que hablara con un procesador de pagos para cobrar al huésped de un
// folio — un gap de código, no solo de credencial.
//
// Distinto del riel de Stripe de `packages/billing` (ver el comentario de
// cabecera de `domain-hoteles/src/payments-port.ts`): ese resuelve la
// SUSCRIPCIÓN de Atiende a sus clientes (Checkout Sessions, per-seat); este
// cobra al HUÉSPED final por su folio (PaymentIntents, cargo directo con un
// `paymentMethodToken` ya tokenizado del lado del cliente — un PAN crudo NUNCA
// llega a este servidor). Ambos pueden compartir la MISMA cuenta real de
// Stripe (un solo `STRIPE_SECRET_KEY`) sin conflicto — son dos productos
// distintos de la misma cuenta, no dos integraciones separadas.
//
// `fetch` nativo (sin SDK) — mismo patrón exacto que
// `domain-*/src/email-dispatch.ts::sendEmailOutboxJob` (Resend) y
// `mcp-servers/cfdi` (Finkok/SW Sapien): el SDK del proveedor no vive en este
// monorepo, la llamada HTTP real sí. La API de Stripe espera
// `application/x-www-form-urlencoded`, no JSON — único detalle propio de este
// proveedor frente a los demás.
import type { PaymentChargeInput, PaymentChargeResult, PaymentsPort } from "@atiende/domain-hoteles";

export interface StripePaymentsConfig {
  readonly secretKey: string | null;
  /** Tope de la llamada HTTP a Stripe. Por omisión `STRIPE_TIMEOUT_MS_DEFAULT`. */
  readonly timeoutMs?: number;
}

/** 20 s: Stripe confirma un PaymentIntent en 1-3 s; por encima de esto la conexión está
 *  colgada y el request de recepción no debe quedarse esperando hasta el límite de la función.
 *  Un timeout NO dice si Stripe cobró: el reintento con la misma Idempotency-Key lo resuelve. */
export const STRIPE_TIMEOUT_MS_DEFAULT = 20_000;

type StripePaymentIntentJson = { id?: string; status?: string; error?: { type?: string; code?: string; message?: string } };

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** Estados reales de un PaymentIntent de Stripe que terminan en captura exitosa. */
const SUCCEEDED_STATUSES = new Set(["succeeded"]);
/** Estados que siguen en curso (3DS pendiente, captura manual pendiente, etc.) —
 * nunca "fallido": el cargo puede resolverse después sin que el caller reintente. */
const PENDING_STATUSES = new Set(["processing", "requires_action", "requires_capture", "requires_confirmation"]);

export class StripeHotelesPaymentsPort implements PaymentsPort {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly config: StripePaymentsConfig,
  ) {}

  async charge(input: PaymentChargeInput): Promise<PaymentChargeResult> {
    if (!this.config.secretKey) throw new Error("Stripe secret key unavailable");
    if (!Number.isSafeInteger(input.amountCentavos) || !(input.amountCentavos > 0)) {
      throw new Error("PaymentChargeInput.amountCentavos debe ser un entero de centavos mayor a 0");
    }
    if (!input.currency) throw new Error("PaymentChargeInput.currency requerida");
    if (!input.paymentMethodToken) throw new Error("PaymentChargeInput.paymentMethodToken requerido");
    if (!input.idempotencyKey) throw new Error("PaymentChargeInput.idempotencyKey requerida");

    const body = new URLSearchParams({
      // Stripe cobra en la unidad más pequeña de la moneda (centavos para MXN/USD).
      // `amountCentavos` ya es un entero en esa unidad (tipo `Centavos`, producido por
      // `pesosACentavos()` en la ruta de folios): aquí NO se redondea ni se escala.
      amount: String(input.amountCentavos),
      currency: input.currency.toLowerCase(),
      payment_method: input.paymentMethodToken,
      confirm: "true",
      // El huésped ya no está presente (folio cerrado desde el panel de recepción,
      // no un checkout en vivo) — igual que un cargo de no-show o un cargo tardío
      // de minibar, nunca hay un "return_url" al que redirigir a nadie.
      off_session: "true",
    });

    const timeoutMs = this.config.timeoutMs ?? STRIPE_TIMEOUT_MS_DEFAULT;
    let response: Response;
    try {
      response = await this.fetchImpl("https://api.stripe.com/v1/payment_intents", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          // Mismo criterio que Resend (ver email-dispatch.ts): la idempotencyKey del
          // caller (repositorio de folios, ver postgres-repository.ts) es la MISMA
          // que cierra la ventana de "Stripe sí cobró pero el worker murió antes de
          // registrar el pago" — un reintento nunca duplica el cargo real.
          "Idempotency-Key": input.idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new Error(`Stripe no respondió en ${timeoutMs} ms (el cobro puede o no haberse hecho: reintenta con la misma Idempotency-Key).`, { cause: err });
      }
      throw err;
    }

    // El cuerpo se lee UNA sola vez como texto y luego se parsea: un proxy o balanceador
    // puede devolver HTML (502/503) y `response.json()` reventaría con un SyntaxError opaco
    // (y dejaría el cuerpo consumido para el mensaje de error).
    const raw = await response.text();
    let json: StripePaymentIntentJson;
    try {
      json = JSON.parse(raw) as StripePaymentIntentJson;
    } catch {
      throw new Error(`Stripe respondió ${response.status} con un cuerpo no-JSON (${raw.slice(0, 80).replace(/\s+/g, " ")}).`);
    }
    if (json === null || typeof json !== "object") throw new Error(`Stripe respondió ${response.status} con un cuerpo no-JSON.`);

    if (!response.ok) {
      // Un `card_error` (tarjeta rechazada, fondos insuficientes, CVC inválido) es
      // un desenlace de NEGOCIO real, nunca una falla de integración — se reporta
      // como "fallido" con el id real si Stripe lo dio, jamás se lanza (lanzar
      // aquí tumbaría el request completo por una tarjeta rechazada, un caso
      // esperado y frecuente). Cualquier OTRO error (401 por key inválida, 5xx de
      // Stripe, red caída) sí se lanza -- eso es un fallo de integración real, el
      // caller (folios.ts) ya lo convierte en un 5xx honesto.
      if (json.error?.type === "card_error") {
        return { status: "fallido", externalPaymentId: json.id ?? `stripe_error_${input.idempotencyKey}` };
      }
      throw new Error(`Stripe respondió ${response.status}: ${json.error?.message ?? json.error?.type ?? "sin detalle"}`);
    }

    if (!json.id || !json.status) throw new Error("Stripe respondió 200 sin id/status de PaymentIntent");

    const status: PaymentChargeResult["status"] = SUCCEEDED_STATUSES.has(json.status)
      ? "capturado"
      : PENDING_STATUSES.has(json.status)
        ? "pendiente"
        : "fallido";

    return { status, externalPaymentId: json.id };
  }
}
