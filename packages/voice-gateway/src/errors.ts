// Jerarquía de errores de la capa de voz — puerto directo del mismo patrón
// de agent-core/gateway/errors.ts (GatewayError con flag `retryable`).

export class VoiceProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Puerto directo de ResidencyGateBlockedError/GatewayBudgetExceededError:
 *  un fallo de CONFIGURACIÓN o de NEGOCIO nunca es reintentable contra el
 *  mismo u otro proveedor. */
export class VoiceProviderConfigError extends VoiceProviderError {
  constructor(message: string) {
    super(message, false);
  }
}

/**
 * Selección explícita de un proveedor que hoy NO puede activarse (GPT-Live-1
 * sin API pública). Mismo principio exacto que ResidencyGateBlockedError en
 * agent-core: nunca degradar en silencio a otro proveedor cuando el
 * llamador pidió uno específico por nombre.
 */
export class VoiceProviderNotActivatableError extends VoiceProviderError {
  constructor(
    readonly providerId: string,
    readonly reason: string,
  ) {
    super(`el proveedor de voz "${providerId}" no puede activarse todavía: ${reason}`, false);
  }
}
