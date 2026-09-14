// Formas mínimas compartidas del gateway de WhatsApp saliente. Deliberadamente
// desacoplado de cualquier esquema de `messaging_outbox` concreto — las 3
// verticales (citas/hoteles/restaurantes) adaptan su propio payload jsonb a esta
// forma en `outbox-port.ts` (ver ese archivo para el porqué de la validación ahí y
// no aquí).

/** Un mensaje de WhatsApp listo para enviar vía Graph API — el "to"/"body"/
 *  "phoneNumberId" ya resueltos, nada de lookups adicionales de este lado. */
export interface OutboundWhatsAppMessagePayload {
  /** Número del destinatario en formato E.164 con o sin "+" (Graph API acepta
   *  ambos; se pasa tal cual llegó del encolador). */
  readonly to: string;
  /** `phone_number_id` de Meta Business — cuál número REMITENTE de la
   *  plataforma envía este mensaje (1 por organización/property según la
   *  vertical, ver `whatsapp_config`/`whatsapp_channel_config` de cada dominio). */
  readonly phoneNumberId: string;
  readonly body: string;
  /** Hasta 3 botones de respuesta rápida (interactive/button de Graph API) — usado
   *  hoy por el recordatorio 24h de citas (Confirmar/Cancelar/Reagendar). Sin
   *  botones, se manda como mensaje de texto plano. */
  readonly buttons?: readonly string[];
}

export interface WhatsAppSendResult {
  /** `messages[0].id` que devuelve Graph API en un envío exitoso — se guarda solo
   *  para trazabilidad/logging, el dispatcher no lo persiste todavía (fuera de
   *  alcance: ligarlo a `messaging_outbox` requeriría una columna nueva, ver
   *  README de este paquete). */
  readonly providerMessageId: string;
}

/** Puerto que el dispatcher consume — `MetaGraphWhatsAppClient` es el adaptador de
 *  producción real; `FakeWhatsAppGraphClient` (providers/fake-graph-client.ts) es
 *  el doble determinista para tests, NUNCA toca la red. */
export interface WhatsAppGraphClient {
  sendMessage(message: OutboundWhatsAppMessagePayload): Promise<WhatsAppSendResult>;
}
