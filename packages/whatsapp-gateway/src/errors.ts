// Jerarquía de errores del gateway de WhatsApp saliente — mismo patrón exacto que
// packages/agent-core/src/gateway/errors.ts (GatewayError con flag `retryable`) y
// packages/voice-gateway/src/errors.ts (VoiceProviderError): quien atrapa un error
// de esta jerarquía nunca tiene que adivinar si vale la pena reintentar, la clase lo
// dice.

export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Falla de CONFIGURACIÓN (falta accessToken, phone_number_id inválido de origen,
 *  etc.) — nunca reintentable: reintentar sin arreglar la configuración solo repite
 *  el mismo error. Mismo criterio que VoiceProviderConfigError. */
export class WhatsAppConfigError extends WhatsAppSendError {
  constructor(message: string) {
    super(message, false);
  }
}

/** El payload encolado en `messaging_outbox` no tiene la forma mínima que este
 *  dispatcher necesita (`to`/`phone_number_id`/`body`) — error de NEGOCIO del
 *  encolador, no de la red: reintentar no lo arregla, se marca `dead` de inmediato. */
export class WhatsAppInvalidPayloadError extends WhatsAppSendError {
  constructor(message: string) {
    super(message, false);
  }
}
