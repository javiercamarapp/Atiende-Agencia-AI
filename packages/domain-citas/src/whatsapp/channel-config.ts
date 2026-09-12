// Port literal de domain-restaurantes/src/whatsapp/channel-config.ts — resolución de
// tenant multi-negocio para el webhook de WhatsApp: varios negocios de citas
// comparten la misma URL de webhook; Meta identifica el número destino en
// `entry[].changes[].value.metadata.phone_number_id`. Una sola Meta App compartida
// por la plataforma — `phone_number_id` SOLO rutea, el app_secret de plataforma
// (nunca en esta tabla) verifica todas las firmas (ver citas.whatsapp_config,
// migrations/003_waitlist_and_rate_limit.sql).
import type { CitasRepository } from "../repository.ts";

export type MetaTextMessage = {
  readonly id: string;
  readonly from: string;
  readonly type: "text";
  readonly text: { readonly body: string };
};

/** Otros eventos (statuses de entrega/lectura) no traen `messages`, se ignoran.
 * Meta puede agrupar varios entry/changes/messages; se conserva el orden del
 * payload y se procesan todos. */
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

/** Resuelve qué organización de citas es dueña de un `phone_number_id` de Meta
 * Cloud API. `null` cuando el número no está configurado en la plataforma — el
 * caller debe responder ack silencioso (200), nunca reintento. */
export async function resolveOrganizationByPhoneNumberId(repo: CitasRepository, phoneNumberId: string): Promise<string | null> {
  return repo.resolveOrganizationByPhoneNumberId(phoneNumberId);
}
