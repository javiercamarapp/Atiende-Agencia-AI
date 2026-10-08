// Plomería determinista del webhook de WhatsApp de hoteles — port de
// domain-restaurantes/src/whatsapp/inbound.ts: dedupe de mensaje at-least-once
// (claimWhatsAppMessage), lease de conversación de 120s (claimWhatsAppConversation,
// evita que mensajes casi-simultáneos del mismo teléfono corrompan el historial),
// append atómico (whatsappAppendTurn), y redacción de datos sensibles ANTES de
// guardar cualquier mensaje real del huésped. Partición por PROPERTY (no por
// organización) — ver channel-config.ts.
import { redactarDatosDePagoEIdentidad } from "@atiende/core-pii";
import { actorHash } from "../rate-limit.ts";
import type { HotelesRepository } from "../repository.ts";
import type { ConversacionesSistemaPort } from "../conversaciones/tipos.ts";
import type { ConversationMessage } from "../types.ts";
import type { HotelesWhatsAppTurnHandler } from "./turn-handler.ts";
import { anteponerPrimerContacto } from "./primer-contacto.ts";

// Mismo hallazgo real que documenta domain-restaurantes/whatsapp/inbound.ts: nunca
// basta con que el agente PROMETA no guardar datos sensibles — hay que redactarlos
// antes de persistir cualquier mensaje real, para que la promesa sea cierta.
// Paridad3 (H-P3-03): ademas de los datos de pago, el huesped escribe CURP, RFC y pasaporte al hacer check-in por chat;
// tambien se ocultan antes de guardar el mensaje (L-HIS-19).
export function redactSensitiveInfo(text: string): string {
  return redactarDatosDePagoEIdentidad(text);
}

export interface InboundMessageOutcome {
  readonly ok: boolean;
  /** true si Meta debe reintentar el batch firmado completo. */
  readonly retryable: boolean;
  readonly reply?: string;
  /** H-20: la conversacion esta en atencion humana: el mensaje se guardo y NO se respondio ni se corrio el agente. */
  readonly silenciado?: boolean;
}

/**
 * Procesa UN mensaje entrante de WhatsApp de punta a punta: dedupe -> lease ->
 * append del mensaje del huésped (a salvo aunque el turn handler tarde) -> turno
 * (inyectado, ver turn-handler.ts) -> append de la respuesta -> liberar el lease.
 * Cualquier fallo se marca explícitamente como reintentable o no, nunca se pierde en
 * silencio.
 */
export async function handleInboundWhatsAppMessage(
  repo: HotelesRepository,
  turnHandler: HotelesWhatsAppTurnHandler,
  args: { readonly organizationId: string; readonly propertyId: string; readonly messageId: string; readonly phone: string; readonly body: string; readonly phoneNumberId: string },
  /** H-20: estado de la conversacion (agente|humano|cerrada). Sin este puerto, o con la base sin la migracion 043, el agente responde siempre (comportamiento previo). */
  conversaciones?: ConversacionesSistemaPort,
  /** H-P3-03: primer contacto. Si se pasa, el PRIMER mensaje de una conversacion nueva lleva la linea de IA y el enlace del aviso de privacidad publico del
   *  hotel (lo pone el codigo, no el LLM). `resolverAvisoUrl` solo se invoca en el primer mensaje; si falla o devuelve `null`, el encabezado sale sin enlace. */
  primerContacto?: { readonly resolverAvisoUrl: () => Promise<string | null> },
): Promise<InboundMessageOutcome> {
  const { organizationId, propertyId, messageId, phone, body, phoneNumberId } = args;
  const phoneHash = actorHash(phone);

  const claimed = await repo.claimWhatsAppMessage(propertyId, messageId, phoneHash);
  // Meta delivery es at-least-once; un id ya procesado/en curso se acusa sin reprocesar.
  if (!claimed) return { ok: true, retryable: false };

  const lease = await repo.claimWhatsAppConversation(propertyId, phoneHash, messageId, 120);
  if (!lease) {
    await repo.markInboundEventFailed(propertyId, messageId, "ConversationBusy");
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
    // (gasto real) mientras el huésped nunca recibe respuesta. `runWithRowSavepoint`
    // (mismo helper que ya protege `executeToolCall` en turn-handler.ts) deja la
    // sesión UTILIZABLE de nuevo antes de repropagar, para que el `catch` de abajo
    // sí pueda registrar el fallo.
    return await repo.runWithRowSavepoint(async () => {
      const userMessage: ConversationMessage = { role: "user", content: redactSensitiveInfo(body) };
      const messagesAfterUser = await repo.appendWhatsAppUserMessageOnce(propertyId, phone, userMessage);

      // H-20: registra el entrante (no leido, reabre una conversacion cerrada) y, si la atiende una persona, el agente CALLA: el
      // mensaje ya quedo guardado arriba; no se corre el LLM (sin gasto), no se responde y la bandeja lo muestra como no leido.
      const modo = conversaciones ? await conversaciones.registrarEntrante(propertyId, phone) : null;
      if (modo === "humano") {
        await repo.finishWhatsAppMessage(propertyId, messageId, phoneHash, "processed", null);
        return { ok: true, retryable: false, silenciado: true };
      }

      const turn = await turnHandler.handleInboundMessage({ organizationId, propertyId, phone, messages: messagesAfterUser });

      // H-P3-03: el primer mensaje de una conversacion nueva (el historial solo tiene el del huesped) lleva la linea de IA y el enlace del aviso de
      // privacidad. Un fallo al resolver el enlace NUNCA tumba la respuesta: sale con la linea de IA y sin enlace.
      let reply = turn.reply;
      if (primerContacto && messagesAfterUser.length === 1) {
        let avisoUrl: string | null = null;
        try {
          avisoUrl = await primerContacto.resolverAvisoUrl();
        } catch (err) {
          console.error("whatsapp-hoteles: no se pudo resolver el enlace del aviso de privacidad del primer contacto", err instanceof Error ? err.name : typeof err);
        }
        reply = anteponerPrimerContacto(reply, avisoUrl);
      }

      const assistantMessage: ConversationMessage = { role: "assistant", content: reply };
      await repo.whatsappAppendTurn(propertyId, phone, [assistantMessage], turn.fnbOrderId ? "completed" : "active", turn.fnbOrderId);

      // Encola el envío REAL de la respuesta — antes de este cambio, `outcome.reply`
      // solo se guardaba en el historial de la conversación y nunca llegaba de
      // verdad al huésped (ver @atiende/whatsapp-gateway/README.md).
      await repo.enqueueMessagingOutbox(propertyId, organizationId, "whatsapp", "whatsapp.inbound_reply", `inbound-reply:${messageId}`, {
        to: phone,
        phone_number_id: phoneNumberId,
        body: reply,
        transaccional: true, // SA-L-46: respuesta/confirmacion que el cliente pidio; la lista de supresion no la bloquea.
      });

      // H-20: el agente (o el gobierno) pidio una persona: la conversacion pasa a humano y se notifica a recepcion/reservas. El puerto
      // es best-effort (nunca lanza ni deja la transaccion abortada): la respuesta de arriba ya esta encolada.
      if (turn.handoff && conversaciones) await conversaciones.derivarAHumano(propertyId, phone, turn.handoff.motivo);

      await repo.finishWhatsAppMessage(propertyId, messageId, phoneHash, "processed", null);
      return { ok: true, retryable: false, reply };
    });
  } catch (err) {
    const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
    await repo.finishWhatsAppMessage(propertyId, messageId, phoneHash, "failed", errorClass);
    return { ok: false, retryable: true };
  }
}
