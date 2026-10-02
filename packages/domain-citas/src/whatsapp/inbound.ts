// Plomería determinista del webhook de WhatsApp de citas — Fase 1 de citas NO
// construyó nada de esto (a diferencia de restaurantes/hoteles, que ya traían el
// seam listo desde su Fase 1, ver diseño Fase 2 §0/§2.6). Puerto de negocio: dedupe
// de mensaje at-least-once (`claimWhatsAppMessage`) + append atómico
// (`whatsappAppendTurn`) — igual que domain-restaurantes — pero la serialización de
// mensajes casi-simultáneos del mismo teléfono (el problema real que aquí
// reemplazaría a `claim_whatsapp_conversation`/la lease de 120s de restaurantes) se
// resuelve adoptando `@atiende/core-conversation::withConversationLock` (diseño
// Fase 2 §2.6-b): esta fase es su primer consumidor real, citado explícitamente
// como uno de los 3 verticales con el bug de doble-booking por mensajes
// casi-simultáneos que ese paquete existe para resolver.
//
// Por qué SOLO citas usa este lock (hallazgo de auditoría de credenciales,
// fix/conversation-lock-upstash): restaurantes y hoteles ya resuelven la
// serialización de mensajes casi-simultáneos con una lease atómica REAL en
// Postgres (`claim_whatsapp_conversation`, 120s, ver
// packages/domain-restaurantes/migrations/004_whatsapp_atomic_append_and_rate_limit.sql
// y el equivalente de hoteles, 004_voz_whatsapp_fase2.sql) — esa lease SÍ protege
// entre instancias serverless por sí sola (Postgres es la única fuente de verdad,
// no hay caso donde dos instancias la vean distinto), así que conectarles además
// el lock de Redis sería redundante. `citas` nunca construyó esa lease (adoptó
// core-conversation en su lugar), así que aquí el lock SÍ es la única defensa
// contra 2 mensajes casi-simultáneos disparando 2 llamadas al LLM en paralelo
// (costo doble, respuestas duplicadas) — el EXCLUDE USING gist de
// `citas.appointments` (ver migrations/001_citas_schema.sql) es una defensa en
// profundidad DISTINTA: evita que 2 citas con horario traslapado lleguen a
// existir, pero no evita las 2 llamadas al LLM ni una respuesta duplicada si el
// traslape no aplica (p.ej. el cliente solo está platicando, o cancelando).
import { ConversationStateMachine, DEFAULT_BOOKING_TRANSITIONS, InMemoryLockStore, InMemoryStateStore, RedisLockStore, withConversationLock, type BookingState, type LockStore } from "@atiende/core-conversation";
import { runArcoFastPath } from "../arco-intent.ts";
import { runCrisisGuardrail } from "../crisis-guardrail.ts";
import { lookupCitasCustomer } from "../customers.ts";
import { actorHash } from "../rate-limit.ts";
import type { CitasRepository, ConversationMessage } from "../repository.ts";
import type { WhatsAppTurnHandler } from "./turn-handler.ts";

import { redactSensitiveInfo } from "../redaction.ts";
import type { MetaInteractiveReply } from "./channel-config.ts";
import { resolveAppointmentButton } from "./appointment-buttons.ts";

export { redactSensitiveInfo };

export interface InboundMessageOutcome {
  readonly ok: boolean;
  /** true si Meta debe reintentar el batch firmado completo. */
  readonly retryable: boolean;
  readonly reply?: string;
}

/**
 * Junta el lock distribuido + una máquina de estados real de
 * `@atiende/core-conversation` (tabla de transiciones por defecto — citas no
 * necesita hoy ningún estado multi-turno propio más allá de la serialización, así
 * que el flujo nunca transiciona fuera de reposo (`null`); el valor real de esta
 * pieza en Fase 2 es el LOCK, no la máquina de estados). Construible una sola vez
 * por proceso e inyectable — ver `createDefaultConversationGuard` para cómo
 * producción elige el `LockStore` real.
 */
export interface CitasConversationGuard {
  readonly lockStore: LockStore;
  readonly stateMachine: ConversationStateMachine<BookingState, Record<string, never>>;
}

/** Snapshot mínimo de entorno que necesita la selección de lock — mismo shape
 *  que `process.env` (valores pueden venir `undefined`), para poder inyectar un
 *  fixture en tests sin tocar variables de entorno reales. */
export interface ConversationGuardEnv {
  readonly UPSTASH_REDIS_REST_URL?: string;
  readonly UPSTASH_REDIS_REST_TOKEN?: string;
}

/**
 * Hallazgo de auditoría de credenciales (fix/conversation-lock-upstash) —
 * ANTES esta función siempre devolvía `InMemoryLockStore`, sin importar qué
 * credenciales de Upstash hubiera configuradas: pegar
 * `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` no tenía NINGÚN efecto en
 * este guard. Ahora elige de verdad:
 *
 *  - CON `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` configuradas (las
 *    MISMAS que usa `@atiende/core-ratelimit`, ver redis-lock-store.ts) —
 *    `RedisLockStore`: candado real entre instancias de Vercel Fluid Compute,
 *    la única forma de serializar mensajes casi-simultáneos entre DOS
 *    instancias distintas atendiendo al mismo cliente al mismo tiempo.
 *  - SIN esas credenciales — `InMemoryLockStore`: degradación EXPLÍCITA y
 *    documentada (ver `apps/api/src/integrations-status.ts`, integración
 *    `redis-conversation-lock`), no un fail-open silencioso — sigue
 *    serializando de verdad DENTRO de una misma instancia (a diferencia de
 *    `RedisLockStore` sin credenciales, que es fail-open puro y no serializa
 *    nada), que es la protección real disponible sin Redis.
 */
export function createDefaultConversationGuard(env: ConversationGuardEnv = process.env as ConversationGuardEnv): CitasConversationGuard {
  const hasUpstashCredentials = Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
  const lockStore: LockStore = hasUpstashCredentials
    ? new RedisLockStore({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN })
    : new InMemoryLockStore();
  return {
    lockStore,
    stateMachine: new ConversationStateMachine(new InMemoryStateStore(), DEFAULT_BOOKING_TRANSITIONS),
  };
}

/**
 * Procesa UN mensaje entrante de WhatsApp de punta a punta: dedupe -> lock de
 * conversación (core-conversation) -> append del mensaje del usuario (a salvo
 * aunque el turn handler tarde) -> memoria de cliente -> turno (inyectado, ver
 * turn-handler.ts) -> append de la respuesta. Cualquier fallo se marca
 * explícitamente como reintentable o no, nunca se pierde en silencio.
 */
export async function handleInboundWhatsAppMessage(
  repo: CitasRepository,
  turnHandler: WhatsAppTurnHandler,
  guard: CitasConversationGuard,
  args: {
    readonly organizationId: string;
    readonly messageId: string;
    readonly phone: string;
    /** Texto del mensaje; para una respuesta interactiva es el título que tocó el cliente. */
    readonly body: string;
    readonly phoneNumberId: string;
    /** C-01 -- presente solo cuando el mensaje es un `button_reply`/`list_reply` de Meta. */
    readonly interactive?: MetaInteractiveReply;
  },
): Promise<InboundMessageOutcome> {
  const { organizationId, messageId, phone, body, phoneNumberId, interactive } = args;
  const phoneHash = actorHash(phone);

  const claimed = await repo.claimWhatsAppMessage(organizationId, messageId, phoneHash);
  // Meta delivery es at-least-once; un id ya procesado/en curso se acusa sin reprocesar.
  if (!claimed) return { ok: true, retryable: false };

  try {
    const guardResult = await withConversationLock(
      { lockStore: guard.lockStore, stateMachine: guard.stateMachine, tenantId: organizationId, customerKey: phoneHash, conversationId: `${organizationId}:${phoneHash}` },
      // Hallazgo de revisores (19-sep-2026, mismo defecto que expuso PR #158 en los
      // 3 turn handlers): TODO este bloque corre en la ÚNICA transacción del
      // request (`ManagedPostgresEngine.withAppSession`, un solo `begin ... commit`).
      // `runCrisisGuardrail`, `appendWhatsAppUserMessageOnce`, `turnHandler.
      // handleInboundMessage`, `whatsappAppendTurn` y `enqueueMessagingOutbox`
      // pueden lanzar un error real de Postgres (SQLSTATE, no un `throw` de
      // negocio) que deja la transacción ABORTADA (25P02) — sin `SAVEPOINT`, el
      // `catch` de abajo (y el `finishWhatsAppMessage("processed", ...)` que
      // corría después de este bloque) reutilizarían esa MISMA sesión abortada,
      // fallarían también con 25P02, el error escaparía sin marcar nada, el
      // `COMMIT` de `withAppSession` lanzaría `AbortedTransactionCommitError` ->
      // 500 a Meta -> reintentos sin tope que re-corren el turno completo del LLM
      // (gasto real) mientras el cliente nunca recibe respuesta.
      // `runWithRowSavepoint` (mismo helper que ya protege `executeToolCall` en
      // llm-turn-handler.ts) deja la sesión UTILIZABLE de nuevo antes de
      // repropagar. `finishWhatsAppMessage("processed", ...)` se movió DENTRO de
      // este bloque (antes corría después del guard, sin ninguna protección) para
      // que también quede cubierto por el mismo SAVEPOINT.
      () =>
        repo.runWithRowSavepoint(async () => {
          // C-01 -- un toque a Confirmar/Cancelar/Reagendar del recordatorio 24h se
          // resuelve ANTES de cualquier otra capa: es determinista (sin LLM), no debe
          // pasar por el fast-path ARCO (el verbo "Cancelar" lo confundiría) ni por el
          // guardrail de crisis (el título de un botón no es texto libre). Un id que NO
          // es de cita (p. ej. `btn_N` de un recordatorio anterior a este cambio, o una
          // lista) devuelve `null` y sigue como texto normal con el título como cuerpo.
          const button = interactive ? await resolveAppointmentButton(repo, { organizationId, phone, interactive }) : null;
          const userText = button?.kind === "to_agent" ? button.text : body;

          const userMessage: ConversationMessage = { role: "user", content: redactSensitiveInfo(userText) };
          const messagesAfterUser = await repo.appendWhatsAppUserMessageOnce(organizationId, phone, userMessage);

          // Fase 6 §1 — guardia de crisis: capa DETERMINISTA que corre ANTES de
          // llamar al LLM. Un mensaje real de crisis en un rubro de salud nunca sigue
          // la conversación normal — se responde con el mensaje de crisis TAL CUAL
          // (nunca reformulado/resumido por el agente) y la escalación humana ya
          // quedó registrada, sin importar qué haría el turn handler con ese mismo
          // mensaje.
          const crisisCheck = button?.kind === "reply" ? { triggered: false as const } : await runCrisisGuardrail(repo, organizationId, phone, userText);
          // C-02 -- fast-path ARCO (acceso/rectificación/cancelación/oposición):
          // MISMA posición y filosofía que el guardrail de crisis (determinista, antes
          // del LLM), pero DESPUÉS de él -- una crisis siempre tiene prioridad. Solo
          // actúa sobre el teléfono que escribe (`phone` viene del webhook de Meta,
          // nunca del texto). Sin la migración 024 aplicada devuelve `null` y el
          // mensaje sigue al agente como antes (ver arco-intent.ts).
          const arco = crisisCheck.triggered || button ? null : await runArcoFastPath(repo, organizationId, phone, body);
          const turn = crisisCheck.triggered
            ? { reply: crisisCheck.reply!, appointmentId: null, propertyId: null }
            : button?.kind === "reply"
              ? { reply: button.reply, appointmentId: null, propertyId: null }
              : arco
              ? { reply: arco.reply, appointmentId: null, propertyId: null }
              : await turnHandler.handleInboundMessage({ organizationId, phone, messages: messagesAfterUser, customer: await lookupCitasCustomer(repo, organizationId, phone) });

          const assistantMessage: ConversationMessage = { role: "assistant", content: turn.reply };
          await repo.whatsappAppendTurn(organizationId, phone, [assistantMessage], turn.appointmentId ? "completed" : "active", turn.appointmentId, turn.propertyId);

          // Encola el envío REAL de la respuesta — antes de este cambio, `outcome.reply`
          // solo se guardaba en el historial de la conversación y nunca llegaba de
          // verdad al cliente (ver @atiende/whatsapp-gateway/README.md). `dedupeKey`
          // por `messageId` hace este encolado idempotente ante un reintento at-least-once
          // de Meta: `claimWhatsAppMessage` ya bloquea el reproceso, pero esta clave es
          // una segunda capa por si algún día este método se llama fuera de ese guard.
          await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "whatsapp.inbound_reply", `inbound-reply:${messageId}`, {
            to: phone,
            phone_number_id: phoneNumberId,
            body: turn.reply,
            transaccional: true, // SA-L-46: respuesta/confirmacion que el cliente pidio; la lista de supresion no la bloquea.
          });

          await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "processed", null);
          return turn;
        }),
    );

    if (!guardResult.locked) {
      // No se pudo serializar a tiempo contra otro mensaje casi-simultáneo del
      // mismo teléfono — el caller debe reintentar (Meta reintenta el batch
      // firmado completo), NUNCA procesar sin el lock tomado.
      await repo.markInboundEventFailed(organizationId, messageId, "ConversationLockTimeout");
      return { ok: false, retryable: true };
    }

    return { ok: true, retryable: false, reply: guardResult.result?.reply };
  } catch (err) {
    const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
    await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "failed", errorClass);
    return { ok: false, retryable: true };
  }
}
