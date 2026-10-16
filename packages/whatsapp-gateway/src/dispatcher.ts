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
import { MAX_TEMPLATE_PARAM_LENGTH, MAX_TEMPLATE_PARAMS, TEMPLATE_LANGUAGE_PATTERN, TEMPLATE_NAME_PATTERN } from "./types.ts";
import type { OutboundButton, OutboundTemplate, WhatsAppGraphClient } from "./types.ts";

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
  readonly buttons?: readonly (string | OutboundButton)[];
  readonly template?: OutboundTemplate;
  /** SA-L-46: `true` = respuesta transaccional dentro de una conversacion en curso (el cliente la pidio): la lista de
   *  supresion de plataforma NO la bloquea. Cualquier otro valor (o ausente) = aviso proactivo. */
  readonly transaccional: boolean;
  /** PL-16: aviso proactivo que el plan nunca debe omitir por tope de mensajes (p. ej. un aviso de seguridad). */
  readonly critico: boolean;
  /** Mensaje interactivo de solicitud de ubicacion (`location_request_message`); `body` es el texto que lo acompana. */
  readonly solicitar_ubicacion: boolean;
}

/** R-27: valida la plantilla HSM opcional del payload. Una plantilla mal formada es un error de ENCOLADO (el
 *  mensaje va a `dead`, nunca se reintenta ni se manda a Meta con un nombre/variables invalidos). */
function parseTemplate(raw: unknown): OutboundTemplate {
  if (typeof raw !== "object" || raw === null) throw new WhatsAppInvalidPayloadError('payload de messaging_outbox con "template" invalido (debe ser un objeto)');
  const t = raw as Record<string, unknown>;
  if (typeof t.name !== "string" || !TEMPLATE_NAME_PATTERN.test(t.name)) {
    throw new WhatsAppInvalidPayloadError('payload de messaging_outbox con "template.name" invalido (minusculas, digitos y guion bajo)');
  }
  if (typeof t.language !== "string" || !TEMPLATE_LANGUAGE_PATTERN.test(t.language)) {
    throw new WhatsAppInvalidPayloadError('payload de messaging_outbox con "template.language" invalido (por ejemplo es_MX)');
  }
  if (!Array.isArray(t.params) || t.params.length > MAX_TEMPLATE_PARAMS) {
    throw new WhatsAppInvalidPayloadError(`payload de messaging_outbox con "template.params" invalido (arreglo de maximo ${MAX_TEMPLATE_PARAMS} textos)`);
  }
  for (const v of t.params) {
    if (typeof v !== "string" || v.length === 0 || v.length > MAX_TEMPLATE_PARAM_LENGTH || /[\r\n\t]/.test(v)) {
      throw new WhatsAppInvalidPayloadError(`payload de messaging_outbox con un parametro de plantilla invalido (1-${MAX_TEMPLATE_PARAM_LENGTH} caracteres, sin saltos de linea ni tabuladores)`);
    }
  }
  return { name: t.name, language: t.language, params: t.params as readonly string[] };
}

function isValidButton(b: unknown): boolean {
  if (typeof b === "string") return true;
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.title === "string";
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
  if (p.buttons !== undefined && (!Array.isArray(p.buttons) || p.buttons.some((b) => !isValidButton(b)))) {
    throw new WhatsAppInvalidPayloadError('payload de messaging_outbox con "buttons" inválido (debe ser string[] o {id,title}[])');
  }
  const template = p.template === undefined || p.template === null ? undefined : parseTemplate(p.template);
  if (p.solicitar_ubicacion !== undefined && typeof p.solicitar_ubicacion !== "boolean") {
    throw new WhatsAppInvalidPayloadError('payload de messaging_outbox con "solicitar_ubicacion" invalido (debe ser booleano)');
  }
  return { to: p.to, phone_number_id: p.phone_number_id, body: p.body, buttons: p.buttons as readonly (string | OutboundButton)[] | undefined, template, transaccional: p.transaccional === true, critico: p.critico === true, solicitar_ubicacion: p.solicitar_ubicacion === true };
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

export type DispatchItemOutcome = "sent" | "retry" | "dead" | "skipped_circuit_open" | "suppressed" | "skipped_suppression_unavailable" | "omitido_cuota";

/** PL-31: catalogo de plantillas por organizacion. `estaAprobada` dice si la organizacion tiene esa plantilla en estado aprobada.
 *  Defensa de entrega, nunca de disponibilidad: si LANZA, el despachador la trata como no aprobada en el catalogo y decide la lista global. */
export interface CatalogoPlantillas {
  estaAprobada(organizationId: string, templateName: string): Promise<boolean>;
}

/** Motivo con que un mensaje suprimido se marca no enviado (`error_class` del outbox). Sin reintento. */
export const SUPPRESSED_ERROR_CLASS = "suprimido";

/** SA-L-46: decide si un telefono esta en la lista de supresion de plataforma (`true` = NO contactar). FAIL-CLOSED: si no
 *  puede verificarlo debe LANZAR; el dispatcher entonces no envia y deja el mensaje para la siguiente corrida. */
export type SuppressionGuard = (phone: string) => Promise<boolean>;

/** Contexto de un mensaje para el medidor mensual de mensajes por plan (PL-16). */
export interface ContextoMedicion {
  readonly label: string;
  readonly itemId: string;
  readonly organizationId: string;
  /** true = aviso proactivo (no es respuesta a un cliente que escribio). */
  readonly proactivo: boolean;
  /** true = proactivo que el plan nunca omite. */
  readonly critico: boolean;
}

/** Motivo con que un proactivo omitido por tope del plan se marca no enviado (`error_class` del outbox). Sin reintento. */
export const CUOTA_ERROR_CLASS = "tope_mensajes_plan";

/**
 * Medidor mensual de mensajes por plan. `antesDeEnviar` decide si el envio sale (solo un plan con accion `pausar` y tope consumido
 * omite proactivos no criticos; lo transaccional SIEMPRE sale); `despuesDeEnviar` registra el mensaje enviado. Es defensa de
 * facturacion, NUNCA un riesgo de disponibilidad: si cualquiera de los dos lanza, el dispatcher registra el error (sin PII) y
 * envia igual.
 */
export interface MedidorMensajes {
  antesDeEnviar(ctx: ContextoMedicion): Promise<{ readonly permitir: boolean; readonly motivo?: string }>;
  despuesDeEnviar(ctx: ContextoMedicion): Promise<void>;
}

export interface DispatchPendingOptions {
  readonly limit?: number;
  /** Sin medidor (`undefined`) el comportamiento es el anterior a PL-16: nada se mide ni se omite. */
  readonly medidor?: MedidorMensajes;
  /** Sin guard (`undefined`) el comportamiento es el anterior a SA-L-46. */
  readonly suppression?: SuppressionGuard;
  /** Sin catalogo (`undefined`) decide solo la lista global de plantillas aprobadas del entorno (comportamiento anterior a PL-31). */
  readonly plantillas?: CatalogoPlantillas;
}

export interface DispatchItemResult {
  readonly id: string;
  readonly outcome: DispatchItemOutcome;
  readonly error?: string;
  /** `true` si el fallo (reintento o muerto) vino del proveedor (Meta o la red hacia Meta): base de la alerta de proveedor caido. */
  readonly proveedor?: boolean;
  /** `error.code` de Graph API cuando lo hubo (190 = token invalido o vencido). */
  readonly graphCode?: number;
}

export interface DispatchSummary {
  readonly label: string;
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly dead: number;
  readonly skipped: number;
  /** Mensajes proactivos no enviados por la lista de supresion de plataforma. Solo presente cuando es mayor que 0. */
  readonly suppressed?: number;
  /** Proactivos omitidos por el tope de mensajes del plan (PL-16). Solo presente cuando es mayor que 0. */
  readonly omitidosCuota?: number;
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
  async dispatchPending(port: MessagingOutboxPort, opts: DispatchPendingOptions = {}): Promise<DispatchSummary> {
    const limit = opts.limit ?? DEFAULT_BATCH_LIMIT;
    const claimed = await port.claimBatch(limit, this.leaseSeconds);
    return this.dispatchClaimed(port, claimed, opts);
  }

  /** Lease (segundos) con que se reclama cada mensaje; el cron lo usa al reclamar de a uno. */
  get claimLeaseSeconds(): number {
    return this.leaseSeconds;
  }

  /** Envia mensajes YA reclamados (por `claimBatch`). Separado de `dispatchPending` para que el cron pueda reclamar de a
   *  UNO en una sesion corta y enviar + cerrar ese mensaje en otra: el envio por Graph API no tiene llave de idempotencia,
   *  asi que un ROLLBACK que deshaga un `markSent` ya entregado lo reenviaria (QA-restaurantes-R1-automatizacion-01). */
  async dispatchClaimed(port: MessagingOutboxPort, claimed: readonly MessagingOutboxItem[], opts: DispatchPendingOptions = {}): Promise<DispatchSummary> {
    const items: DispatchItemResult[] = [];
    let sent = 0;
    let retried = 0;
    let dead = 0;
    let skipped = 0;
    let suppressed = 0;
    let omitidosCuota = 0;

    for (const item of claimed) {
      const result = await this.dispatchOne(port, item, opts.suppression, opts.medidor, opts.plantillas);
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
        case "skipped_suppression_unavailable":
          skipped++;
          break;
        case "suppressed":
          suppressed++;
          break;
        case "omitido_cuota":
          omitidosCuota++;
          break;
      }
    }

    return { label: port.label, claimed: claimed.length, sent, retried, dead, skipped, ...(suppressed > 0 ? { suppressed } : {}), ...(omitidosCuota > 0 ? { omitidosCuota } : {}), items };
  }

  private async dispatchOne(
    port: MessagingOutboxPort,
    item: MessagingOutboxItem,
    suppression: SuppressionGuard | undefined,
    medidor: MedidorMensajes | undefined,
    plantillas: CatalogoPlantillas | undefined,
  ): Promise<DispatchItemResult> {
    let payload: ValidWhatsAppOutboxPayload;
    try {
      payload = parseWhatsAppOutboxPayload(item.payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await port.markDead(item.id, item.attempts + 1, message.slice(0, 120));
      return { id: item.id, outcome: "dead", error: message };
    }

    // SA-L-46: lista de supresion de plataforma, solo para avisos proactivos. Antes del breaker y de la red.
    if (suppression && !payload.transaccional) {
      let suprimido: boolean;
      try {
        suprimido = await suppression(payload.to);
      } catch (supErr) {
        // Diagnostico sin PII: solo SQLSTATE y clase del error (nunca el destino).
        console.error("whatsapp-dispatcher: lectura de la lista de supresion fallo (fail-closed)", (supErr as { code?: unknown })?.code ?? null, supErr instanceof Error ? supErr.name : typeof supErr);
        // FAIL-CLOSED: no se pudo verificar -> NO se contacta. No cuenta como intento (mismo criterio que el
        // breaker abierto): el mensaje queda reclamado y el lease vencido lo vuelve a ofrecer.
        return { id: item.id, outcome: "skipped_suppression_unavailable", error: "supresion_no_verificable" };
      }
      if (suprimido) {
        await port.markDead(item.id, item.attempts + 1, SUPPRESSED_ERROR_CLASS);
        return { id: item.id, outcome: "suppressed" };
      }
    }

    // PL-16: tope mensual de mensajes del plan. Solo mide si la vertical conoce la organizacion del mensaje.
    const medicion: ContextoMedicion | null =
      medidor && item.organizationId ? { label: port.label, itemId: item.id, organizationId: item.organizationId, proactivo: !payload.transaccional, critico: payload.critico } : null;
    if (medidor && medicion) {
      let decision: { readonly permitir: boolean; readonly motivo?: string } = { permitir: true };
      try {
        decision = await medidor.antesDeEnviar(medicion);
      } catch (medErr) {
        // Fail-open: un medidor roto nunca deja a un cliente sin respuesta. Diagnostico sin PII.
        console.error("whatsapp-dispatcher: el medidor de cuota fallo (se envia igual)", (medErr as { code?: unknown })?.code ?? null, medErr instanceof Error ? medErr.name : typeof medErr);
      }
      if (!decision.permitir) {
        await port.markDead(item.id, item.attempts + 1, (decision.motivo ?? CUOTA_ERROR_CLASS).slice(0, 120));
        return { id: item.id, outcome: "omitido_cuota", error: decision.motivo ?? CUOTA_ERROR_CLASS };
      }
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

    // PL-31: la organizacion declara en su catalogo que plantillas tiene aprobadas en Meta. Una consulta fallida cae a la lista global.
    let templateApproved = false;
    if (payload.template && plantillas && item.organizationId) {
      try {
        templateApproved = await plantillas.estaAprobada(item.organizationId, payload.template.name);
      } catch (catErr) {
        console.error("whatsapp-dispatcher: lectura del catalogo de plantillas fallo (se usa la lista global)", (catErr as { code?: unknown })?.code ?? null, catErr instanceof Error ? catErr.name : typeof catErr);
      }
    }

    try {
      const enviado = await this.graphClient.sendMessage({ to: payload.to, phoneNumberId: payload.phone_number_id, body: payload.body, buttons: payload.buttons, ...(payload.template ? { template: payload.template } : {}), ...(templateApproved ? { templateApproved: true } : {}), ...(payload.solicitar_ubicacion ? { solicitarUbicacion: true } : {}) });
      await this.breaker?.reportSuccess(payload.phone_number_id);
      await port.markSent(item.id, { providerMessageId: enviado.providerMessageId, ...(enviado.enviadoComo ? { enviadoComo: enviado.enviadoComo } : {}) });
      if (medidor && medicion) {
        try {
          await medidor.despuesDeEnviar(medicion);
        } catch (medErr) {
          console.error("whatsapp-dispatcher: el medidor de cuota no pudo registrar el mensaje enviado", (medErr as { code?: unknown })?.code ?? null, medErr instanceof Error ? medErr.name : typeof medErr);
        }
      }
      return { id: item.id, outcome: "sent" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof WhatsAppSendError ? err.retryable : true;
      const diagnostico = err instanceof WhatsAppSendError && err.info?.proveedor ? { proveedor: true as const, ...(err.info.graphCode !== undefined ? { graphCode: err.info.graphCode } : {}) } : {};
      await this.breaker?.reportFailure(payload.phone_number_id, message);

      const nextAttempts = item.attempts + 1;
      if (!retryable || nextAttempts >= this.maxAttempts) {
        await port.markDead(item.id, nextAttempts, message.slice(0, 120));
        return { id: item.id, outcome: "dead", error: message, ...diagnostico };
      }

      const backoffSeconds = computeBackoffSeconds(nextAttempts);
      const nextAttemptAtIso = new Date(this.now().getTime() + backoffSeconds * 1000).toISOString();
      await port.markRetry(item.id, nextAttempts, message.slice(0, 120), nextAttemptAtIso);
      return { id: item.id, outcome: "retry", error: message, ...diagnostico };
    }
  }
}
