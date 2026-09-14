// ═══════════════════════════════════════════════════════════════════════════
// WhatsAppOutboundDispatcher — el dispatcher REAL que faltaba en las 3 verticales
// de WhatsApp (citas/hoteles/restaurantes): drena `messaging_outbox`, envía cada
// mensaje vía Graph API real (`WhatsAppGraphClient`, ver types.ts) y decide
// sent/retry/dead con el mismo espíritu de diseño que
// packages/agent-core/src/gateway/gateway.ts (LlmGateway):
//   1. CIRCUIT BREAKER por `phone_number_id` (reutiliza
//      @atiende/agent-core::CircuitBreaker tal cual — es genérico por `providerId`
//      string, aquí la "clave de proveedor" es el número remitente): un número que
//      está fallando en cadena no debe seguir gastando intentos de CADA mensaje en
//      cola contra él.
//   2. RETRY/BACKOFF con tope claro (`maxAttempts`, nunca infinito) — un error
//      reintentable (red, 429, 5xx) vuelve a `pending` con `next_attempt_at` en el
//      futuro (backoff exponencial capado); agotado el tope, o un error NO
//      reintentable (payload inválido, 4xx de negocio de Graph API), el mensaje se
//      marca `dead` de inmediato — nunca reintento infinito, nunca se pierde en
//      silencio.
//   3. IDEMPOTENCIA: `claimBatch` (implementado por cada adaptador de vertical,
//      ver outbox-port.ts) solo devuelve mensajes `pending` o `processing` con
//      lease expirado — un mensaje ya `sent` NUNCA vuelve a ser elegible, sea cual
//      sea el número de corridas futuras de este dispatcher contra la misma tabla.
// ═══════════════════════════════════════════════════════════════════════════
import type { CircuitBreaker } from "@atiende/agent-core/gateway";
import { WhatsAppInvalidPayloadError, WhatsAppSendError } from "./errors.ts";
import type { MessagingOutboxItem, MessagingOutboxPort } from "./outbox-port.ts";
import type { WhatsAppGraphClient } from "./types.ts";

/** Tope de intentos antes de `dead` — nunca reintento infinito. */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Lease por defecto al reclamar un batch (segundos) — mismos 120s que
 *  `claim_whatsapp_conversation` en las 3 verticales. */
export const DEFAULT_LEASE_SECONDS = 120;
export const DEFAULT_BATCH_LIMIT = 25;

const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_CAP_SECONDS = 3600;

/** Backoff exponencial capado: intento 1 -> 30s, 2 -> 60s, 3 -> 120s, 4 -> 240s,
 *  tope 1h. Determinista y puro — fácil de testear sin reloj real. */
export function computeBackoffSeconds(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(BACKOFF_BASE_SECONDS * 2 ** exponent, BACKOFF_CAP_SECONDS);
}

interface ValidWhatsAppOutboxPayload {
  readonly to: string;
  readonly phone_number_id: string;
  readonly body: string;
  readonly buttons?: readonly string[];
}

/** El payload es opaco (`jsonb`) desde el punto de vista del outbox — este
 *  dispatcher es el único lugar que le exige forma, exactamente la que
 *  `enqueueMessagingOutbox` ya escribe hoy para reminders/waitlist de citas (ver
 *  packages/domain-citas/src/reminders.ts) y la que las rutas de webhook de las 3
 *  verticales escriben para `outcome.reply` (ver whatsapp/inbound.ts de cada
 *  dominio). Un payload que no cumple esta forma es un error de ENCOLADO, nunca de
 *  red — se manda a `dead` de inmediato, no tiene sentido reintentarlo. */
function parseWhatsAppOutboxPayload(payload: unknown): ValidWhatsAppOutboxPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new WhatsAppInvalidPayloadError("payload de messaging_outbox no es un objeto");
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.to !== "string" || p.to.length === 0) throw new WhatsAppInvalidPayloadError('payload de messaging_outbox sin "to" válido');
  if (typeof p.phone_number_id !== "string" || p.phone_number_id.length === 0) throw new WhatsAppInvalidPayloadError('payload de messaging_outbox sin "phone_number_id" válido');
  if (typeof p.body !== "string" || p.body.length === 0) throw new WhatsAppInvalidPayloadError('payload de messaging_outbox sin "body" válido');
  if (p.buttons !== undefined && (!Array.isArray(p.buttons) || p.buttons.some((b) => typeof b !== "string"))) {
    throw new WhatsAppInvalidPayloadError('payload de messaging_outbox con "buttons" inválido (debe ser string[])');
  }
  return { to: p.to, phone_number_id: p.phone_number_id, body: p.body, buttons: p.buttons as readonly string[] | undefined };
}

export interface WhatsAppOutboundDispatcherOptions {
  readonly graphClient: WhatsAppGraphClient;
  /** Opcional — sin breaker (`undefined`), el dispatcher sigue funcionando
   *  correctamente (fail-open), igual criterio que `CircuitBreaker` sin store: es
   *  defensa en profundidad, no el único control de fallas. */
  readonly breaker?: CircuitBreaker;
  readonly maxAttempts?: number;
  readonly leaseSeconds?: number;
  /** Inyectable para tests deterministas de backoff. */
  readonly now?: () => Date;
}

export type DispatchItemOutcome = "sent" | "retry" | "dead" | "skipped_circuit_open";

export interface DispatchItemResult {
  readonly id: string;
  readonly outcome: DispatchItemOutcome;
  readonly error?: string;
}

export interface DispatchSummary {
  readonly label: string;
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly dead: number;
  readonly skipped: number;
  readonly items: readonly DispatchItemResult[];
}

export class WhatsAppOutboundDispatcher {
  private readonly graphClient: WhatsAppGraphClient;
  private readonly breaker: CircuitBreaker | undefined;
  private readonly maxAttempts: number;
  private readonly leaseSeconds: number;
  private readonly now: () => Date;

  constructor(opts: WhatsAppOutboundDispatcherOptions) {
    this.graphClient = opts.graphClient;
    this.breaker = opts.breaker;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.leaseSeconds = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.now = opts.now ?? (() => new Date());
  }

  /** Reclama y despacha hasta `limit` mensajes pendientes de un puerto (una
   *  vertical concreta). Un mensaje individual que falle NUNCA tumba el resto del
   *  batch — mismo criterio de aislamiento que `runConfirmacionCitaCore`/la ruta
   *  interna de recordatorios (un tenant/mensaje raro no bloquea a los demás). */
  async dispatchPending(port: MessagingOutboxPort, opts: { limit?: number } = {}): Promise<DispatchSummary> {
    const limit = opts.limit ?? DEFAULT_BATCH_LIMIT;
    const claimed = await port.claimBatch(limit, this.leaseSeconds);

    const items: DispatchItemResult[] = [];
    let sent = 0;
    let retried = 0;
    let dead = 0;
    let skipped = 0;

    for (const item of claimed) {
      const result = await this.dispatchOne(port, item);
      items.push(result);
      switch (result.outcome) {
        case "sent":
          sent++;
          break;
        case "retry":
          retried++;
          break;
        case "dead":
          dead++;
          break;
        case "skipped_circuit_open":
          skipped++;
          break;
      }
    }

    return { label: port.label, claimed: claimed.length, sent, retried, dead, skipped, items };
  }

  private async dispatchOne(port: MessagingOutboxPort, item: MessagingOutboxItem): Promise<DispatchItemResult> {
    let payload: ValidWhatsAppOutboxPayload;
    try {
      payload = parseWhatsAppOutboxPayload(item.payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await port.markDead(item.id, item.attempts + 1, message.slice(0, 120));
      return { id: item.id, outcome: "dead", error: message };
    }

    if (this.breaker) {
      try {
        await this.breaker.checkCircuit(payload.phone_number_id);
      } catch {
        // Circuito abierto para ESTE número remitente: no es culpa de este
        // mensaje en particular, así que no cuenta como intento (no se toca
        // `attempts`) — se deja el mensaje reclamado; el lease expira solo y
        // `claimBatch` lo vuelve a ofrecer en la siguiente corrida, mismo criterio
        // que LlmGateway salta un proveedor con el breaker abierto sin penalizar
        // la solicitud del caller.
        return { id: item.id, outcome: "skipped_circuit_open" };
      }
    }

    try {
      await this.graphClient.sendMessage({ to: payload.to, phoneNumberId: payload.phone_number_id, body: payload.body, buttons: payload.buttons });
      await this.breaker?.reportSuccess(payload.phone_number_id);
      await port.markSent(item.id);
      return { id: item.id, outcome: "sent" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof WhatsAppSendError ? err.retryable : true;
      await this.breaker?.reportFailure(payload.phone_number_id, message);

      const nextAttempts = item.attempts + 1;
      if (!retryable || nextAttempts >= this.maxAttempts) {
        await port.markDead(item.id, nextAttempts, message.slice(0, 120));
        return { id: item.id, outcome: "dead", error: message };
      }

      const backoffSeconds = computeBackoffSeconds(nextAttempts);
      const nextAttemptAtIso = new Date(this.now().getTime() + backoffSeconds * 1000).toISOString();
      await port.markRetry(item.id, nextAttempts, message.slice(0, 120), nextAttemptAtIso);
      return { id: item.id, outcome: "retry", error: message };
    }
  }
}
