// Resolución de tenant del webhook de WhatsApp de hoteles (diseño Fase 2 §2.1/§2.2).
// A diferencia de domain-restaurantes (resuelve ORGANIZACIÓN, multi-sucursal), aquí
// se resuelve directo a PROPERTY: en el origen real de hoteles cada número de Meta
// Cloud API atiende una sola property, así que el agente nunca necesita decidir
// "sucursal más cercana" — la property ya viene fija desde el routing del número.
import type { HotelesRepository } from "../repository.ts";
import type { WhatsAppPropertyRoute } from "../types.ts";

export type MetaTextMessage = {
  readonly id: string;
  readonly from: string;
  readonly type: "text";
  readonly text: { readonly body: string };
};

/** Port literal de extractMetaTextMessages — otros eventos (statuses de
 * entrega/lectura) no traen `messages`, se ignoran. */
export function extractMetaTextMessages(payload: unknown): MetaTextMessage[] {
  const root = payload as { entry?: unknown };
  if (!Array.isArray(root?.entry)) return [];
  const result: MetaTextMessage[] = [];
  for (const entry of root.entry) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown } })?.value?.messages;
      if (!Array.isArray(messages)) continue;
      for (const candidate of messages) {
        const message = candidate as Partial<MetaTextMessage>;
        if (
          message.type === "text" &&
          typeof message.id === "string" &&
          message.id.length >= 1 &&
          message.id.length <= 255 &&
          typeof message.from === "string" &&
          /^\d{7,20}$/.test(message.from) &&
          typeof message.text?.body === "string" &&
          message.text.body.trim().length >= 1 &&
          message.text.body.length <= 4000
        ) {
          result.push(message as MetaTextMessage);
        }
      }
    }
  }
  return result;
}

export function extractMetaPhoneNumberId(payload: unknown): string | null {
  const root = payload as { entry?: unknown };
  const entry = Array.isArray(root?.entry) ? root.entry[0] : undefined;
  const change = Array.isArray((entry as { changes?: unknown })?.changes) ? (entry as { changes: unknown[] }).changes[0] : undefined;
  const phoneNumberId = (change as { value?: { metadata?: { phone_number_id?: unknown } } })?.value?.metadata?.phone_number_id;
  return typeof phoneNumberId === "string" && phoneNumberId.length > 0 ? phoneNumberId : null;
}

/** Resuelve a qué property de hoteles pertenece un `phone_number_id` de Meta Cloud
 * API. `null` cuando el número no está configurado — el caller debe responder ack
 * silencioso (200), nunca reintento. */
export async function resolvePropertyByPhoneNumberId(repo: HotelesRepository, phoneNumberId: string): Promise<WhatsAppPropertyRoute | null> {
  return repo.resolvePropertyByPhoneNumberId(phoneNumberId);
}
