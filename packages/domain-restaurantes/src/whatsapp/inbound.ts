// Plomería determinista del webhook de WhatsApp — port literal de la parte
// SIN LLM de restaurantes/supabase/functions/whatsapp-webhook/index.ts: dedupe de
// mensaje at-least-once (claim_whatsapp_message), lease de conversación de 120s
// (claim_whatsapp_conversation, evita que mensajes casi-simultáneos del mismo
// teléfono corrompan el historial), append atómico (whatsapp_append_turn), y
// redacción de datos sensibles ANTES de guardar cualquier mensaje real del cliente.
import { redactarDatosDePago } from "@atiende/core-pii";
import { actorHash, consumeRateLimit } from "../rate-limit.ts";
import { lookupCustomerConPedidoReciente } from "../customers.ts";
import { esSoloSticker } from "./channel-config.ts";
import type { ConversationMessage, RestaurantesRepository } from "../repository.ts";
import { runArcoFastPath } from "../privacidad/arco-intent.ts";
import { matchesHighRiskOtherThan } from "./guards.ts";
import { composeWithPrivacyNotice, privacyNoticeWhatsApp } from "../privacidad/aviso.ts";
import type { PrivacidadRepository } from "../privacidad/repository.ts";
import type { HandoffAgentGate } from "../conversaciones/repository.ts";
import type { WhatsAppTurnHandler } from "./turn-handler.ts";
import { PM_COPY } from "./perfil-pm.ts";
import { resolverCuerpoConNotaDeVoz, type TranscripcionDeEntrada } from "./nota-de-voz.ts";

// Hallazgo real de la auditoría adversarial del origen (3-sep-2026): el agente le
// dijo a un cliente de prueba "no procesamos ni guardamos los datos que
// compartiste por chat" al mandar un número de tarjeta completo — pero el mensaje se
// guardaba tal cual, número/vencimiento/CVV incluidos, en texto plano. Este helper
// redacta esos patrones ANTES de guardar cualquier mensaje real, para que esa
// afirmación sea cierta de verdad.
export function redactSensitiveInfo(text: string): string {
  return redactarDatosDePago(text);
}

export interface InboundMessageOutcome {
  readonly ok: boolean;
  /** true si Meta debe reintentar el batch firmado completo (ver diseño Fase 1 §4.3c). */
  readonly retryable: boolean;
  readonly reply?: string;
  /** Pedido que el turno creo (si lo hubo). */
  readonly orderId?: string | null;
  /** El agente pidio una persona y se abrio la toma de handoff en este turno. */
  readonly escalated?: boolean;
}

/**
 * Procesa UN mensaje entrante de WhatsApp de punta a punta: dedupe -> lease ->
 * append del mensaje del usuario (a salvo aunque el turn handler tarde) -> memoria de
 * cliente -> turno (inyectado, ver turn-handler.ts) -> append de la respuesta ->
 * liberar el lease. Cualquier fallo se marca explícitamente como reintentable o no,
 * nunca se pierde en silencio — mismo contrato que el origen.
 */
/** Turnos del agente que un mismo telefono puede consumir por ventana antes de que se le deje de contestar con el modelo. Un pedido normal usa unos 6-12. */
export const REMITENTE_MAX_TURNOS = 20;
export const REMITENTE_VENTANA_SEGUNDOS = 600;
export const REMITENTE_EXCEDIDO_TEXTO = "Hemos recibido muchos mensajes seguidos suyos. Para atenderle bien, espere unos minutos y escríbanos de nuevo, o llame directamente a la sucursal.";

/** `null` = dentro del tope; `avisar` = primer mensaje fuera del tope de la ventana (se le avisa con un texto fijo, sin modelo); `callar` = los siguientes. Si el
 * contador no esta disponible (base sin migrar, error) NO se limita: nunca se deja sin respuesta a un cliente por un fallo del limitador. */
async function limiteDeRemitente(repo: RestaurantesRepository, organizationId: string, phone: string): Promise<"avisar" | "callar" | null> {
  try {
    const actor = `${organizationId}:${phone}`;
    const dentro = await repo.runWithRowSavepoint(() => consumeRateLimit(repo, "whatsapp-turno-remitente", actor, REMITENTE_MAX_TURNOS, REMITENTE_VENTANA_SEGUNDOS));
    if (dentro.allowed) return null;
    const primeraVez = await repo.runWithRowSavepoint(() => consumeRateLimit(repo, "whatsapp-turno-remitente-aviso", actor, 1, REMITENTE_VENTANA_SEGUNDOS));
    return primeraVez.allowed ? "avisar" : "callar";
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// INTERRUPTOR DURO DEL AGENTE POR SUCURSAL (migracion 053). Con el agente de WhatsApp apagado en la sucursal que recibio el mensaje NO se llama al modelo:
// se responde con un texto fijo y honesto y se abre una toma de handoff (motivo `agente_apagado`) para que la conversacion quede en la bandeja de una persona.
// Las tomas abiertas ya callan al agente (R-21), asi que la respuesta sale UNA vez por conversacion; el limitador de aviso es la red de seguridad si la toma no
// se pudo abrir (base sin la 028 / sin conversacion). Base sin migrar, sin sucursal o sin fila: el agente esta ENCENDIDO (como hasta hoy).
// ---------------------------------------------------------------------------------------------------------------------
export const AGENTE_APAGADO_TEXTO = "En este momento le atiende una persona del equipo. En cuanto pueda le responderá por este mismo medio.";
export const MOTIVO_AGENTE_APAGADO = "agente_apagado";
export const AGENTE_APAGADO_AVISO_VENTANA_SEGUNDOS = 6 * 3600;

/** `null` = agente encendido; `responder` = primera vez (texto fijo + handoff); `callar` = ya se aviso en esta ventana. */
async function decisionAgenteApagado(repo: RestaurantesRepository, organizationId: string, phone: string, propertyId: string | null | undefined): Promise<"responder" | "callar" | null> {
  if (!propertyId) return null;
  try {
    if (await repo.findAgenteWhatsappActivo(propertyId)) return null;
  } catch {
    return null; // un fallo al leer el interruptor nunca deja a un cliente sin respuesta: el agente atiende como hasta hoy
  }
  try {
    const primera = await repo.runWithRowSavepoint(() => consumeRateLimit(repo, "whatsapp-agente-apagado-aviso", `${organizationId}:${phone}`, 1, AGENTE_APAGADO_AVISO_VENTANA_SEGUNDOS));
    return primera.allowed ? "responder" : "callar";
  } catch {
    return "responder";
  }
}

export async function handleInboundWhatsAppMessage(
  repo: RestaurantesRepository,
  turnHandler: WhatsAppTurnHandler,
  args: {
    readonly organizationId: string;
    readonly messageId: string;
    readonly phone: string;
    readonly body: string;
    readonly phoneNumberId: string;
    /** Sucursal resuelta desde el numero que recibio el mensaje (`resolveWhatsAppChannel`). */
    readonly propertyId?: string | null;
    /** R-21: handoff a humano. Con una toma abierta para este telefono el agente NO responde (el mensaje se guarda
     * para la persona que atiende); sin la migracion 028 el gate devuelve `null` y todo sigue como antes. */
    readonly handoffGate?: HandoffAgentGate;
    /** PM PR-9: privacidad (aviso simplificado + asistente virtual en el primer mensaje, fast-path
     * ARCO determinista). Ausente = comportamiento anterior, sin aviso ni fast-path. */
    readonly privacy?: PrivacidadRepository;
    /** `false` = NO encola la respuesta en el outbox de WhatsApp (nada sale hacia Meta): la respuesta solo se guarda en
     * la conversacion y se devuelve en `outcome.reply`. Lo usa el widget demo (R-19); por omision `true` (webhook real). */
    readonly deliverReply?: boolean;
    /** R-32: el mensaje es una nota de voz. Con esto se intenta transcribirla DESPUES de reclamar el mensaje (un replay de Meta no la
     * transcribe dos veces); si no se puede, `body` (pedir que escriba) se conserva tal cual. */
    readonly transcripcion?: TranscripcionDeEntrada;
  },
): Promise<InboundMessageOutcome> {
  const { organizationId, messageId, phone, phoneNumberId, propertyId, handoffGate, privacy } = args;
  const deliverReply = args.deliverReply !== false;
  const phoneHash = actorHash(phone);

  const claimed = await repo.claimWhatsAppMessage(organizationId, messageId, phoneHash);
  // Meta delivery es at-least-once; un id ya procesado/en curso se acusa sin reprocesar.
  if (!claimed) return { ok: true, retryable: false };

  const lease = await repo.claimWhatsAppConversation(organizationId, phoneHash, messageId, 120);
  if (!lease) {
    await repo.markInboundEventFailed(organizationId, messageId, "ConversationBusy");
    return { ok: false, retryable: true };
  }

  try {
    // Hallazgo de revisores (19-sep-2026, mismo defecto que expuso PR #158 en los
    // 3 turn handlers): TODO este bloque corre en la ÚNICA transacción del
    // request (`ManagedPostgresEngine.withAppSession`, un solo `begin ... commit`).
    // Si `turnHandler.handleInboundMessage`, `appendWhatsAppUserMessageOnce`,
    // `whatsappAppendTurn` o `enqueueMessagingOutbox` lanzan un error real de
    // Postgres (SQLSTATE, no un `throw` de negocio), la transacción queda
    // ABORTADA (25P02) — sin `SAVEPOINT`, el `catch` de abajo reutilizaría esa
    // MISMA sesión abortada para `finishWhatsAppMessage(..., "failed", ...)`, esa
    // llamada fallaría también con 25P02, el error escaparía sin marcar nada, el
    // `COMMIT` de `withAppSession` lanzaría `AbortedTransactionCommitError` -> 500
    // a Meta -> reintentos sin tope que re-corren el turno completo del LLM
    // (gasto real) mientras el cliente nunca recibe respuesta. `runWithRowSavepoint`
    // (mismo helper que ya protege `executeToolCall` en turn-handler.ts) deja la
    // sesión UTILIZABLE de nuevo antes de repropagar, para que el `catch` de abajo
    // sí pueda registrar el fallo.
    return await repo.runWithRowSavepoint(async () => {
      const body = await resolverCuerpoConNotaDeVoz(repo, { organizationId, phone, body: args.body, transcripcion: args.transcripcion });
      const userMessage: ConversationMessage = { role: "user", content: redactSensitiveInfo(body) };
      const messagesAfterUser = await repo.appendWhatsAppUserMessageOnce(organizationId, phone, userMessage);

      // PM PR-9 -- derechos ARCO: fast-path determinista ANTES del LLM (el modelo nunca improvisa
      // una respuesta legal ni depende de "acordarse" de registrar la solicitud). La identidad es
      // el telefono que escribe (Meta lo autentica), nunca texto del mensaje. `null` = no es ARCO
      // (o la base no tiene la migracion 030): el turno sigue como antes. Corre tambien con una toma
      // de handoff abierta: es una obligacion legal y solo responde a frases explicitas de ARCO.
      // Un mensaje que mezcla ARCO con otro motivo de alto riesgo (alergia, cobro, queja...) NO toma el
      // fast-path: pasa al agente, cuyo clasificador de #226 escala al equipo con el texto completo.
      const arco = privacy && !matchesHighRiskOtherThan(body, "privacidad_arco") ? await runArcoFastPath(privacy, organizationId, phone, body, "whatsapp") : null;

      // R-21: con una toma de handoff abierta (pendiente o tomada) el agente calla; el mensaje del cliente ya
      // quedo guardado en el historial para quien atiende la conversacion.
      if (handoffGate && !arco) {
        const handoff = await handoffGate.estadoParaAgente(organizationId, phone);
        if (handoff) {
          const acuse = handoff === "pendiente" && handoffGate.acusePendiente ? await handoffGate.acusePendiente(organizationId, phone, ACUSE_PENDIENTE_ESPERA_MIN, ACUSE_PENDIENTE_REPETIR_MIN) : false;
          if (acuse) {
            await repo.whatsappAppendTurn(organizationId, phone, [{ role: "assistant", content: ACUSE_HANDOFF_PENDIENTE }], null, null, null);
            if (deliverReply) {
              await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "whatsapp.inbound_reply", `inbound-reply:${messageId}`, {
                to: phone,
                phone_number_id: phoneNumberId,
                body: ACUSE_HANDOFF_PENDIENTE,
                transaccional: true,
              });
            }
          }
          await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "processed", null);
          return acuse ? { ok: true, retryable: false, reply: ACUSE_HANDOFF_PENDIENTE, orderId: null, escalated: false } : { ok: true, retryable: false };
        }
      }

      // Tope por REMITENTE antes del LLM: cada mensaje de un mismo telefono es un turno pagado, y el unico tope del webhook es por NUMERO de la
      // sucursal (compartido por todos sus clientes). Pasado el tope no se llama al modelo: se avisa UNA vez por ventana y despues se calla (el
      // mensaje ya quedo en el historial para quien atienda). El ARCO (obligacion legal) no se limita.
      // Interruptor duro de la sucursal (053): antes del limite y del modelo, sin costo de IA. El ARCO (obligacion legal) corre aunque el agente este apagado.
      const apagado = arco ? null : await decisionAgenteApagado(repo, organizationId, phone, propertyId);
      if (apagado === "callar") {
        await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "processed", null);
        return { ok: true, retryable: false };
      }
      const limite = arco || apagado ? null : await limiteDeRemitente(repo, organizationId, phone);
      if (limite === "callar") {
        await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "processed", null);
        return { ok: true, retryable: false };
      }

      // Un sticker (el «gracias» de siempre) tras un pedido ya cerrado no se contesta: el mensaje queda en el historial y procesado.
      if (!arco && limite === null && (await stickerSobraTrasPedidoCerrado(repo, organizationId, phone, body))) {
        await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "processed", null);
        return { ok: true, retryable: false };
      }

      const turn = arco
        ? { reply: arco.reply, orderId: null, propertyId: propertyId ?? null }
        : apagado
          ? { reply: AGENTE_APAGADO_TEXTO, orderId: null, propertyId: propertyId ?? null, escalacion: { motivo: MOTIVO_AGENTE_APAGADO } }
          : limite === "avisar"
            ? { reply: REMITENTE_EXCEDIDO_TEXTO, orderId: null, propertyId: propertyId ?? null }
            : await turnHandler.handleInboundMessage({
                organizationId,
                phone,
                messages: messagesAfterUser,
                customer: await lookupCustomerConPedidoReciente(repo, organizationId, phone),
                propertyId: propertyId ?? null,
                messageId,
              });

      // PM PR-9 -- aviso de privacidad simplificado + "asistente virtual" en el PRIMER mensaje de
      // cada telefono (y de nuevo cuando se sube la version del aviso). La entrega queda registrada
      // en la misma transaccion; si el turno falla, el registro se revierte con el savepoint y el
      // reintento vuelve a anteponerlo. Base sin migrar: se usa "primer mensaje de la conversacion".
      let reply = turn.reply;
      if (privacy) {
        const config = await privacy.getPrivacyConfig(organizationId);
        const claimed = await privacy.claimPrivacyNotice(organizationId, phoneHash, "whatsapp", config.noticeVersion);
        const isFirstContact = claimed ?? messagesAfterUser.length === 1;
        if (isFirstContact) reply = composeWithPrivacyNotice(privacyNoticeWhatsApp(config), reply);
      }

      const assistantMessage: ConversationMessage = turn.orderId ? { role: "assistant", content: reply, pedidoCreado: true } : { role: "assistant", content: reply };
      await repo.whatsappAppendTurn(organizationId, phone, [assistantMessage], turn.orderId ? "completed" : "active", turn.orderId, turn.propertyId);

      // R-21: el agente pidio una persona -> abre la toma de handoff (misma transaccion que la conversacion).
      if (turn.escalacion && handoffGate) {
        await handoffGate.solicitarHumano({ organizationId, propertyId: turn.propertyId ?? propertyId ?? null, phone, motivo: turn.escalacion.motivo });
      }

      // Encola el envío REAL de la respuesta — antes de este cambio, `outcome.reply`
      // solo se guardaba en el historial de la conversación y nunca llegaba de
      // verdad al cliente (ver @atiende/whatsapp-gateway/README.md).
      if (deliverReply) {
        await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "whatsapp.inbound_reply", `inbound-reply:${messageId}`, {
          to: phone,
          phone_number_id: phoneNumberId,
          body: reply,
          transaccional: true, // SA-L-46: respuesta/confirmacion que el cliente pidio; la lista de supresion no la bloquea.
        });
        if (turn.pedirUbicacion) await encolarSolicitudUbicacion(repo, organizationId, `inbound-ubicacion:${messageId}`, phone, phoneNumberId);
      }

      await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "processed", null);
      return { ok: true, retryable: false, reply, orderId: turn.orderId ?? null, escalated: Boolean(turn.escalacion && handoffGate) };
    });
  } catch (err) {
    const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
    await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "failed", errorClass);
    return { ok: false, retryable: true };
  }
}

/** §5: encola, ademas de la respuesta de texto, el mensaje interactivo `location_request_message` (el cliente comparte su ubicacion con un toque).
 * Va en el mismo outbox y con el mismo `phone_number_id`: se envia dentro de la ventana de 24 h abierta por el mensaje del cliente. La llave de
 * idempotencia deriva del id del mensaje de Meta, asi un reintento del turno no la duplica. */
async function encolarSolicitudUbicacion(repo: RestaurantesRepository, organizationId: string, key: string, phone: string, phoneNumberId: string): Promise<void> {
  await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "whatsapp.inbound_reply", key, {
    to: phone,
    phone_number_id: phoneNumberId,
    body: PM_COPY.pedirUbicacion,
    solicitar_ubicacion: true,
    transaccional: true,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// ESPERA DE RAFAGAS (PM-C5, recomendacion 17 del analisis de chats reales de T7). El 19 % de los turnos del cliente trae 3 o mas
// mensajes seguidos (saludo, pedido, pin, pago por separado) y 25 mensajes se editaron despues de enviarse: responder al primero
// cuesta una respuesta equivocada por cada fragmento. Con `replyDebounceSeconds` > 0 (config del agente, apagada por omision) el
// webhook trabaja en DOS fases con una espera entre ellas:
//   Fase A (`recibirMensajeConEspera`, transaccion corta que SE CONFIRMA): reclama el mensaje (dedupe), lo agrega al historial y
//     toma el turno de responder si esta libre. Si otro mensaje de ese telefono ya tiene el turno, este queda "absorbido": su texto
//     ya esta en el historial y quien tiene el turno lo vera.
//   (espera de `replyDebounceSeconds`, SIN transaccion abierta: los mensajes que lleguen ahora se agregan y se absorben)
//   Fase B (`responderTrasEspera`, transaccion nueva): relee el historial COMPLETO, contesta todo lo pendiente en UN solo turno y,
//     antes de soltar el turno, revisa si llego algo mas (hasta `MAX_PASADAS_RAFAGA` turnos; despues de soltarlo lo revisa una vez
//     mas y, si hay algo sin contestar, vuelve a tomar el turno o deja que lo tome el mensaje nuevo).
// El camino sin espera (`handleInboundWhatsAppMessage`) conserva su logica; en el webhook solo se agrega la lectura de la config del agente (en savepoint) y el pedido reciente del cliente.
// Una correccion ("mejor 3", "perdon, son 2") llega como un mensaje mas: el prompt indica tomar el ultimo dato. WhatsApp Cloud API no
// avisa por webhook cuando un cliente EDITA un mensaje ya enviado.
// ---------------------------------------------------------------------------------------------------------------------

/** Turnos de respuesta que una misma fase B puede dar (cada uno contesta lo que llego durante el anterior). */
export const MAX_PASADAS_RAFAGA = 3;
/** Vigencia del turno de responder. La fase A ya la CONFIRMO: si la funcion muere (timeout de 30 s) el turno queda tomado hasta que venza, y mientras tanto los
 * mensajes del telefono se absorben sin respuesta. 45 s cubre la vida maxima de la funcion (30 s) y, si el dueno muere, se libera pronto: el siguiente mensaje
 * del cliente toma el turno y contesta TODO lo pendiente (el historial ya tiene los mensajes absorbidos). Tope del SQL: 300. */
export const LEASE_RAFAGA_SEGUNDOS = 45;
/** Una toma de handoff `pendiente` que nadie atiende: el agente calla (R-21), pero el cliente no puede quedarse horas sin NINGUNA respuesta. Pasados
 * `ACUSE_PENDIENTE_ESPERA_MIN` minutos sin que nadie la tome, el siguiente mensaje del cliente recibe UN acuse honesto (sin prometer una hora) y luego otro
 * cada `ACUSE_PENDIENTE_REPETIR_MIN`. El tiempo y la unicidad los decide la base (migracion 045); sin ella el agente sigue callando como antes. */
export const ACUSE_PENDIENTE_ESPERA_MIN = 15;
export const ACUSE_PENDIENTE_REPETIR_MIN = 60;
export const ACUSE_HANDOFF_PENDIENTE =
  "Seguimos esperando a que una persona del equipo tome su conversación; su aviso ya está registrado y no se perdió. Si lo prefiere, puede dejar aquí los detalles de su pedido para que los vean en cuanto la atiendan.";

/** Vida maxima de la funcion del webhook (`maxDuration` de vercel.json). */
export const FUNCION_MAX_MS = 30_000;
/** Tiempo que se le deja a la fase B (hasta 3 turnos del agente + envio) DESPUES de esperar. */
export const RESERVA_FASE_B_MS = 15_000;

/** Margen entre el fin del turno del agente y la muerte de la funcion: confirmar la transaccion, encolar la respuesta y despachar inline. */
export const MARGEN_CIERRE_TURNO_MS = 6_000;

/** Lo que se estima que tarda UNA pasada (turno del agente + escritura): no se empieza otra si no cabe antes del fin de la funcion. */
export const PASADA_ESTIMADA_MS = 7_000;

/** Espera real de la rafaga: la configurada, recortada para que despues de esperar todavia quepa la fase B; 0 = no hay tiempo, se responde ya. */
export function esperaEfectivaMs(esperaSegundos: number, transcurridoMs: number): number {
  const disponible = FUNCION_MAX_MS - RESERVA_FASE_B_MS - Math.max(0, transcurridoMs);
  return Math.max(0, Math.min(esperaSegundos * 1000, disponible));
}

/**
 * La fase B fallo de forma detectable (la transaccion no pudo confirmar): su `failed` quedo revertido con ella y el mensaje seguia en
 * 'processing' con el turno tomado. En una transaccion NUEVA se marca `failed` y se suelta el turno para que el reintento de Meta lo reclame
 * y los mensajes que lleguen no se absorban sin respuesta. Si la funcion muere por timeout esto no corre: ahi manda el vencimiento del lease.
 */
export async function liberarTurnoTrasFalloDeFaseB(
  repo: RestaurantesRepository,
  args: { readonly organizationId: string; readonly messageId: string; readonly phone: string },
): Promise<void> {
  await repo.finishWhatsAppMessage(args.organizationId, args.messageId, actorHash(args.phone), "failed", "FaseBFallo");
}

export type RecepcionConEspera =
  /** Ya reclamado o procesado (Meta entrega al menos una vez): nada que hacer. */
  | { readonly estado: "duplicado" }
  /** Otro mensaje de este telefono tiene el turno de responder y vera este texto en el historial. */
  | { readonly estado: "absorbido" }
  /** Este mensaje tiene el turno: hay que esperar y llamar a `responderTrasEspera`. */
  | { readonly estado: "responder" }
  /** Fallo real: Meta debe reintentar. */
  | { readonly estado: "fallo"; readonly retryable: true };

/** Mensajes del cliente despues de la ultima respuesta del agente (todos, si el agente aun no ha contestado). */
export function mensajesSinResponder(messages: readonly ConversationMessage[]): readonly ConversationMessage[] {
  let ultimaRespuesta = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") ultimaRespuesta = i;
  });
  return messages.slice(ultimaRespuesta + 1).filter((m) => m.role === "user");
}

/** Cuantos mensajes del cliente hay ANTES de la ultima respuesta del agente (los que ya tuvieron su turno). */
export function usuariosRespondidos(messages: readonly ConversationMessage[]): number {
  let ultimaRespuesta = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") ultimaRespuesta = i;
  });
  return messages.slice(0, ultimaRespuesta + 1).filter((m) => m.role === "user").length;
}

/**
 * Lo pendiente de contestar, contado por NUMERO de mensaje del cliente y no por posicion: un mensaje que llega mientras el agente
 * contesta se guarda ANTES de la respuesta de ese turno (que no lo vio), asi que por posicion parecería contestado. `vista` es el
 * historial que se le da al modelo: los pendientes van al final, despues de la ultima respuesta, para que los vea como lo nuevo.
 */
export function analizarHistorial(
  messages: readonly ConversationMessage[],
  respondidos: number,
): { readonly pendientes: readonly ConversationMessage[]; readonly vista: readonly ConversationMessage[]; readonly totalUsuarios: number } {
  let ordinal = 0;
  const pendientes: ConversationMessage[] = [];
  const resto: ConversationMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      if (ordinal >= respondidos) pendientes.push(m);
      else resto.push(m);
      ordinal += 1;
    } else {
      resto.push(m);
    }
  }
  return { pendientes, vista: [...resto, ...pendientes], totalUsuarios: ordinal };
}

export async function recibirMensajeConEspera(
  repo: RestaurantesRepository,
  args: { readonly organizationId: string; readonly messageId: string; readonly phone: string; readonly body: string; readonly transcripcion?: TranscripcionDeEntrada },
): Promise<RecepcionConEspera> {
  const { organizationId, messageId, phone } = args;
  const phoneHash = actorHash(phone);
  const claimed = await repo.claimWhatsAppMessage(organizationId, messageId, phoneHash);
  if (!claimed) return { estado: "duplicado" };
  try {
    return await repo.runWithRowSavepoint(async (): Promise<RecepcionConEspera> => {
      const body = await resolverCuerpoConNotaDeVoz(repo, { organizationId, phone, body: args.body, transcripcion: args.transcripcion });
      await repo.appendWhatsAppUserMessageOnce(organizationId, phone, { role: "user", content: redactSensitiveInfo(body) });
      const turno = await repo.claimWhatsAppConversation(organizationId, phoneHash, messageId, LEASE_RAFAGA_SEGUNDOS);
      if (!turno) {
        await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "processed", null);
        return { estado: "absorbido" };
      }
      return { estado: "responder" };
    });
  } catch {
    // Mismo contrato que el camino sin espera: el fallo se marca y Meta reintenta (el append quedo revertido por el savepoint).
    await repo.finishWhatsAppMessage(organizationId, messageId, phoneHash, "failed", "RecepcionConEsperaFallo");
    return { estado: "fallo", retryable: true };
  }
}

export async function responderTrasEspera(
  repo: RestaurantesRepository,
  turnHandler: WhatsAppTurnHandler,
  args: {
    readonly organizationId: string;
    readonly messageId: string;
    readonly phone: string;
    readonly phoneNumberId: string;
    readonly propertyId?: string | null;
    readonly handoffGate?: HandoffAgentGate;
    readonly privacy?: PrivacidadRepository;
    readonly deliverReply?: boolean;
    /** Instante (ms, mismo reloj que `reloj`) en que muere la funcion. Las pasadas 2 y 3 no empiezan si no caben antes; la pasada 1 siempre corre
     * (la reserva de la fase B la garantiza). Sin esto no hay limite de tiempo. */
    readonly finFuncionMs?: number;
    readonly reloj?: () => number;
  },
): Promise<InboundMessageOutcome> {
  const { organizationId, messageId, phone, phoneNumberId, propertyId, handoffGate, privacy } = args;
  const reloj = args.reloj ?? Date.now;
  const deliverReply = args.deliverReply !== false;
  const phoneHash = actorHash(phone);
  const leerHistorial = () => repo.whatsappAppendTurn(organizationId, phone, [], null, null, null);
  let owner = messageId;
  let ultimo: InboundMessageOutcome = { ok: true, retryable: false };
  let respondidos = -1; // se fija con el primer historial leido
  try {
    for (let pasada = 1; pasada <= MAX_PASADAS_RAFAGA; pasada++) {
      const historialCrudo = await leerHistorial();
      if (respondidos < 0) respondidos = usuariosRespondidos(historialCrudo);
      const { pendientes, vista: historial, totalUsuarios } = analizarHistorial(historialCrudo, respondidos);
      if (pendientes.length === 0) {
        // Nada que contestar (lo hizo una pasada anterior): se suelta el turno y se revisa una vez mas por si llego un mensaje justo ahora.
        await repo.finishWhatsAppMessage(organizationId, owner, phoneHash, "processed", null);
        if (analizarHistorial(await leerHistorial(), respondidos).pendientes.length === 0) return ultimo;
        owner = `${messageId}:p${pasada + 1}`;
        if (!(await repo.claimWhatsAppConversation(organizationId, phoneHash, owner, LEASE_RAFAGA_SEGUNDOS))) return ultimo; // otro mensaje tomo el turno: lo contestara
        continue;
      }
      if (pasada > 1 && args.finFuncionMs !== undefined && reloj() + PASADA_ESTIMADA_MS > args.finFuncionMs) {
        // No cabe otra pasada: un timeout a medias revertiria tambien la respuesta ya dada en las anteriores (misma transaccion). Se cierra aqui, lo
        // pendiente queda sin responder y se marca `failed` para que Meta reintente y el reintento lo conteste (esas respuestas ya estan en el historial).
        await repo.finishWhatsAppMessage(organizationId, owner, phoneHash, "failed", "SinTiempoParaPasada");
        return { ok: false, retryable: true };
      }
      const textoPendiente = pendientes.map((m) => m.content).join("\n");
      const turnoDePasada = await repo.runWithRowSavepoint(async (): Promise<{ readonly salida: InboundMessageOutcome; readonly silencio: boolean }> => {
        const arco = privacy && !matchesHighRiskOtherThan(textoPendiente, "privacidad_arco") ? await runArcoFastPath(privacy, organizationId, phone, textoPendiente, "whatsapp") : null;
        if (handoffGate && !arco) {
          const handoff = await handoffGate.estadoParaAgente(organizationId, phone);
          if (handoff) {
            const acuse = handoff === "pendiente" && handoffGate.acusePendiente ? await handoffGate.acusePendiente(organizationId, phone, ACUSE_PENDIENTE_ESPERA_MIN, ACUSE_PENDIENTE_REPETIR_MIN) : false;
            if (!acuse) return { salida: { ok: true, retryable: false }, silencio: true };
            await repo.whatsappAppendTurn(organizationId, phone, [{ role: "assistant", content: ACUSE_HANDOFF_PENDIENTE }], null, null, null);
            if (deliverReply) {
              await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "whatsapp.inbound_reply", pasada === 1 ? `inbound-reply:${messageId}` : `inbound-reply:${messageId}:p${pasada}`, {
                to: phone,
                phone_number_id: phoneNumberId,
                body: ACUSE_HANDOFF_PENDIENTE,
                transaccional: true,
              });
            }
            return { salida: { ok: true, retryable: false, reply: ACUSE_HANDOFF_PENDIENTE, orderId: null, escalated: false }, silencio: true };
          }
        }
        // Interruptor duro de la sucursal (053): sin modelo, texto fijo + toma de handoff; las pasadas siguientes las calla la propia toma abierta.
        const apagado = arco ? null : await decisionAgenteApagado(repo, organizationId, phone, propertyId);
        if (apagado === "callar") return { salida: { ok: true, retryable: false }, silencio: true };
        if (!arco && (await stickerSobraTrasPedidoCerrado(repo, organizationId, phone, textoPendiente))) return { salida: { ok: true, retryable: false }, silencio: true };
        const turn = arco
          ? { reply: arco.reply, orderId: null, propertyId: propertyId ?? null }
          : apagado
            ? { reply: AGENTE_APAGADO_TEXTO, orderId: null, propertyId: propertyId ?? null, escalacion: { motivo: MOTIVO_AGENTE_APAGADO } }
            : await turnHandler.handleInboundMessage({
                organizationId,
                phone,
                messages: historial,
                customer: await lookupCustomerConPedidoReciente(repo, organizationId, phone),
                propertyId: propertyId ?? null,
                messageId,
                ...(args.finFuncionMs !== undefined ? { finTurnoMs: args.finFuncionMs - MARGEN_CIERRE_TURNO_MS } : {}),
              });
        let reply = turn.reply;
        if (privacy) {
          const config = await privacy.getPrivacyConfig(organizationId);
          const claimed = await privacy.claimPrivacyNotice(organizationId, phoneHash, "whatsapp", config.noticeVersion);
          // Con varios mensajes antes de la primera respuesta el historial ya no tiene 1 solo: "primer contacto" = el agente nunca ha contestado.
          const isFirstContact = claimed ?? !historial.some((m) => m.role === "assistant");
          if (isFirstContact) reply = composeWithPrivacyNotice(privacyNoticeWhatsApp(config), reply);
        }
        await repo.whatsappAppendTurn(organizationId, phone, [turn.orderId ? { role: "assistant", content: reply, pedidoCreado: true } : { role: "assistant", content: reply }], turn.orderId ? "completed" : "active", turn.orderId, turn.propertyId);
        if (turn.escalacion && handoffGate) {
          await handoffGate.solicitarHumano({ organizationId, propertyId: turn.propertyId ?? propertyId ?? null, phone, motivo: turn.escalacion.motivo });
        }
        if (deliverReply) {
          await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "whatsapp.inbound_reply", pasada === 1 ? `inbound-reply:${messageId}` : `inbound-reply:${messageId}:p${pasada}`, {
            to: phone,
            phone_number_id: phoneNumberId,
            body: reply,
            transaccional: true, // SA-L-46: respuesta que el cliente pidio; la lista de supresion no la bloquea.
          });
          if (turn.pedirUbicacion) await encolarSolicitudUbicacion(repo, organizationId, pasada === 1 ? `inbound-ubicacion:${messageId}` : `inbound-ubicacion:${messageId}:p${pasada}`, phone, phoneNumberId);
        }
        return { salida: { ok: true, retryable: false, reply, orderId: turn.orderId ?? null, escalated: Boolean(turn.escalacion && handoffGate) }, silencio: false };
      });
      ultimo = turnoDePasada.salida;
      // Todo lo que el turno vio ya tuvo su respuesta; lo que llegue mientras tanto es lo siguiente.
      respondidos = totalUsuarios;
      // Con una toma de handoff abierta el agente calla: lo pendiente es de la persona que atiende, no se repite el intento.
      if (turnoDePasada.silencio) break;
    }
    await repo.finishWhatsAppMessage(organizationId, owner, phoneHash, "processed", null);
    return ultimo;
  } catch (err) {
    const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
    await repo.finishWhatsAppMessage(organizationId, owner, phoneHash, "failed", errorClass);
    return { ok: false, retryable: true };
  }
}

/** Minutos tras la confirmacion durante los que un sticker del cliente se considera el «gracias» de un pedido cerrado. */
export const STICKER_VENTANA_PEDIDO_CERRADO_MIN = 240;

/** Un sticker (y nada mas) con un pedido vigente confirmado hace poco: no se contesta. Sin pedido reciente el turno sigue y el agente lo toma como un gesto. */
async function stickerSobraTrasPedidoCerrado(repo: RestaurantesRepository, organizationId: string, phone: string, texto: string): Promise<boolean> {
  if (!esSoloSticker(texto)) return false;
  const cliente = await lookupCustomerConPedidoReciente(repo, organizationId, phone);
  const reciente = cliente.isNew ? undefined : cliente.pedidoReciente;
  return reciente !== undefined && reciente !== null && reciente.minutosDesdeConfirmacion <= STICKER_VENTANA_PEDIDO_CERRADO_MIN;
}
