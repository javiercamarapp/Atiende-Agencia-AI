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
import type { HandoffAgentGate } from "../conversaciones/repository.ts";

import { redactSensitiveInfo } from "../redaction.ts";
import type { MetaInteractiveReply, TipoMensajeNoSoportado } from "./channel-config.ts";
import { resolveAppointmentButton } from "./appointment-buttons.ts";

export { redactSensitiveInfo };

/** Tope de turnos de MODELO por remitente (antes del LLM): el limite del webhook es por numero del NEGOCIO y un solo remitente podia gastar el cupo de
 * todos los pacientes. 20 turnos por 10 minutos alcanzan de sobra para una conversacion real. */
export const TOPE_TURNOS_POR_REMITENTE = { max: 20, ventanaSegundos: 600 } as const;
const AVISO_TOPE_REMITENTE = "Recibimos varios mensajes seguidos y por ahora no puedo atender más. Espere unos minutos y escríbanos de nuevo, o llame directamente al negocio.";

/** `true` si este remitente aun puede usar un turno de modelo. Falla ABIERTO ante un error de infraestructura (con SAVEPOINT: la sesion sigue
 * utilizable): un limite que falla nunca debe dejar a un paciente sin atencion. */
export async function consumirTurnoDeRemitente(repo: CitasRepository, organizationId: string, phoneHash: string): Promise<boolean> {
  try {
    return await repo.runWithRowSavepoint(() => repo.consumeRateLimit("wa-sender-turns", actorHash(`${organizationId}:${phoneHash}`), TOPE_TURNOS_POR_REMITENTE.max, TOPE_TURNOS_POR_REMITENTE.ventanaSegundos));
  } catch (err) {
    console.error("whatsapp: tope por remitente no disponible (se deja pasar):", err instanceof Error ? err.constructor.name : "error");
    return true;
  }
}

/** UN aviso por ventana al remitente que excedio el tope (o mando algo ilegible): las respuestas de aviso no pueden convertirse en spam saliente. */
async function consumirAvisoDeRemitente(repo: CitasRepository, organizationId: string, phoneHash: string): Promise<boolean> {
  try {
    return await repo.runWithRowSavepoint(() => repo.consumeRateLimit("wa-sender-aviso", actorHash(`${organizationId}:${phoneHash}`), 1, TOPE_TURNOS_POR_REMITENTE.ventanaSegundos));
  } catch {
    return true;
  }
}

const AVISO_NO_SOPORTADO: Readonly<Record<TipoMensajeNoSoportado, string>> = {
  audio: "Por ahora no puedo escuchar notas de voz. ¿Me escribe su mensaje, por favor? Si es algo urgente, llame directamente al negocio.",
  imagen: "Por ahora solo puedo leer mensajes de texto, no imágenes. ¿Me lo escribe, por favor? Si necesita enviar un documento, llame directamente al negocio.",
  video: "Por ahora solo puedo leer mensajes de texto, no videos. ¿Me lo escribe, por favor? Si es algo urgente, llame directamente al negocio.",
  documento: "Por ahora solo puedo leer mensajes de texto, no archivos. ¿Me lo escribe, por favor? Si necesita enviar un documento, llame directamente al negocio.",
  sticker: "Por ahora solo puedo leer mensajes de texto. ¿Me escribe en qué le ayudo, por favor?",
  ubicacion: "Por ahora solo puedo leer mensajes de texto. ¿Me escribe en qué le ayudo, por favor?",
  contacto: "Por ahora solo puedo leer mensajes de texto. ¿Me escribe en qué le ayudo, por favor?",
};

/** Rastro en el historial cuando el paciente manda contenido no soportado a una conversacion con toma humana: solo el tipo, nunca el contenido. */
const RASTRO_NO_SOPORTADO: Record<TipoMensajeNoSoportado, string> = {
  audio: "[El paciente envió una nota de voz]",
  imagen: "[El paciente envió una imagen]",
  video: "[El paciente envió un video]",
  documento: "[El paciente envió un archivo]",
  sticker: "[El paciente envió un sticker]",
  ubicacion: "[El paciente envió una ubicación]",
  contacto: "[El paciente envió un contacto]",
};

/**
 * Un mensaje que el agente no puede leer (nota de voz, imagen, archivo, ubicacion...): antes el webhook lo ignoraba y respondia 200 sin que nadie
 * contestara. Ahora se acusa recibo (dedupe at-least-once igual que el texto) y el paciente recibe un aviso fijo para que escriba; el aviso sale como
 * mucho una vez por ventana. No se guarda ni se interpreta el contenido.
 */
export async function handleUnsupportedWhatsAppMessage(
  repo: CitasRepository,
  args: {
    readonly organizationId: string;
    readonly messageId: string;
    readonly phone: string;
    readonly phoneNumberId: string;
    readonly tipo: TipoMensajeNoSoportado;
    /** C-11: con una toma humana abierta el bot calla tambien ante contenido no soportado. Sin puerto (o base sin migrar) responde el aviso fijo como siempre. */
    readonly handoffGate?: HandoffAgentGate;
  },
): Promise<InboundMessageOutcome> {
  const { organizationId, messageId, phone, phoneNumberId, tipo, handoffGate } = args;
  const phoneHash = actorHash(phone);
  const claimed = await repo.claimWhatsAppMessage(organizationId, messageId, phoneHash);
  if (!claimed) return { ok: true, retryable: false };
  try {
    const aviso = await repo.runWithRowSavepoint(async () => {
      // Con una persona atendiendo la conversacion el bot NO contesta (ni gasta el aviso de la ventana), pero deja un rastro de texto fijo en el
      // historial para que quien atiende sepa que llego un audio o una imagen. No se guarda ni se interpreta el contenido.
      if (handoffGate && (await handoffGate.estadoParaAgente(organizationId, phone))) {
        await repo.appendWhatsAppUserMessageOnce(organizationId, phone, { role: "user", content: RASTRO_NO_SOPORTADO[tipo] });
        await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "processed", null);
        return false;
      }
      const permitido = await consumirAvisoDeRemitente(repo, organizationId, phoneHash);
      if (permitido) {
        await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "whatsapp.inbound_no_soportado", `inbound-no-soportado:${messageId}`, {
          to: phone,
          phone_number_id: phoneNumberId,
          body: AVISO_NO_SOPORTADO[tipo],
          transaccional: true,
        });
      }
      await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "processed", null);
      return permitido;
    });
    return { ok: true, retryable: false, ...(aviso ? { reply: AVISO_NO_SOPORTADO[tipo] } : {}) };
  } catch (err) {
    const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
    await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "failed", errorClass);
    return { ok: false, retryable: true };
  }
}

export interface InboundMessageOutcome {
  readonly ok: boolean;
  /** true si Meta debe reintentar el batch firmado completo. */
  readonly retryable: boolean;
  readonly reply?: string;
  /** C-11: la conversacion esta en atencion humana (handoff abierto): el mensaje se guardo y NO se corrio el agente ni se respondio. */
  readonly silenciado?: boolean;
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
    /** C-11 -- handoff a humano (migracion 031). Sin este puerto, o con la base sin migrar, el agente responde siempre (comportamiento anterior). */
    readonly handoffGate?: HandoffAgentGate;
  },
): Promise<InboundMessageOutcome> {
  const { organizationId, messageId, phone, body, phoneNumberId, interactive, handoffGate } = args;
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
          const crisisCheck = button?.kind === "reply" ? { triggered: false as const } : await runCrisisGuardrail(repo, organizationId, phone, userText, handoffGate);
          // C-02 -- fast-path ARCO (acceso/rectificación/cancelación/oposición):
          // MISMA posición y filosofía que el guardrail de crisis (determinista, antes
          // del LLM), pero DESPUÉS de él -- una crisis siempre tiene prioridad. Solo
          // actúa sobre el teléfono que escribe (`phone` viene del webhook de Meta,
          // nunca del texto). Sin la migración 024 aplicada devuelve `null` y el
          // mensaje sigue al agente como antes (ver arco-intent.ts).
          const arco = crisisCheck.triggered || button ? null : await runArcoFastPath(repo, organizationId, phone, body);
          // C-11 -- handoff a humano: mientras haya una toma abierta (pendiente o tomada) el agente CALLA. El mensaje del cliente ya quedo guardado
          // arriba; aqui NO se llama al LLM (sin gasto), no se guarda respuesta y no se encola nada. La consulta tambien registra el ping del
          // cliente. Solo frena al agente conversacional: la crisis (arriba), ARCO y los botones del recordatorio son deterministas y siguen
          // funcionando. Sin puerto o con la base sin migrar devuelve null y todo sigue como antes.
          const aDeterminista = crisisCheck.triggered || button?.kind === "reply" || arco;
          const humanoActivo = !aDeterminista && handoffGate ? await handoffGate.estadoParaAgente(organizationId, phone) : null;
          if (humanoActivo) {
            await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "processed", null);
            return null;
          }
          // Tope por remitente ANTES del modelo (crisis, ARCO y botones son deterministas y no gastan modelo, asi que no cuentan).
          if (!aDeterminista) {
            if (!(await consumirTurnoDeRemitente(repo, organizationId, phoneHash))) {
              if (!(await consumirAvisoDeRemitente(repo, organizationId, phoneHash))) {
                await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "processed", null);
                return null;
              }
              await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "whatsapp.inbound_tope", `inbound-tope:${messageId}`, { to: phone, phone_number_id: phoneNumberId, body: AVISO_TOPE_REMITENTE, transaccional: true });
              await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "processed", null);
              return { reply: AVISO_TOPE_REMITENTE, appointmentId: null, propertyId: null };
            }
          }
          const turnoBase = crisisCheck.triggered
            ? { reply: crisisCheck.reply!, appointmentId: null, propertyId: null }
            : button?.kind === "reply"
              ? { reply: button.reply, appointmentId: null, propertyId: null }
              : arco
              ? { reply: arco.reply, appointmentId: null, propertyId: null }
              : await turnHandler.handleInboundMessage({ organizationId, phone, messages: messagesAfterUser, customer: await lookupCitasCustomer(repo, organizationId, phone) });

          // El turno pidio pasar a una persona (el paciente lo pidio, o el asistente no estuvo disponible): se abre la toma pendiente (con su
          // notificacion in-app) y la respuesta lo dice. Si no hay forma de abrirla (sin puerto o base sin migrar) la respuesta NUNCA promete una persona.
          let turn: { readonly reply: string; readonly appointmentId: string | null; readonly propertyId: string | null } = turnoBase;
          if ("humano" in turnoBase && turnoBase.humano) {
            const handoffId = handoffGate ? await handoffGate.solicitarHumano({ organizationId, phone, motivo: turnoBase.humano.motivo, crisis: false }) : null;
            turn = { reply: handoffId ? turnoBase.humano.replyAbierto : turnoBase.humano.replySinHandoff, appointmentId: turnoBase.appointmentId, propertyId: turnoBase.propertyId };
          }

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

    if (guardResult.result === null) return { ok: true, retryable: false, silenciado: true };
    return { ok: true, retryable: false, reply: guardResult.result?.reply };
  } catch (err) {
    const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
    await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "failed", errorClass);
    return { ok: false, retryable: true };
  }
}
