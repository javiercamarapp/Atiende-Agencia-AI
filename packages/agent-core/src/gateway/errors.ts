// Jerarquía de errores del gateway. Cada uno declara si es reintentable
// dentro de la escalera de fallback (mismo criterio que `classifyError` en
// licitaciones/packages/agents/src/errors.ts: 429/5xx y errores de red son
// reintentables, 4xx de negocio no lo son).

export class GatewayError extends Error {
  constructor(message: string, readonly retryable: boolean = false) {
    super(message);
    this.name = new.target.name;
  }
}

/** El circuit breaker de este proveedor está OPEN: no se intenta la llamada,
 *  se salta directo al siguiente proveedor de la escalera (o se rechaza si
 *  no hay más). Puerto de `CircuitOpenError` en
 *  atiende.ai/src/lib/llm/circuit-breaker.ts. */
export class CircuitOpenError extends GatewayError {
  constructor(readonly providerId: string, readonly retryAfterSeconds: number) {
    super(`circuit breaker de "${providerId}" está OPEN — reintente en ${retryAfterSeconds}s`, true);
  }
}

/** Puerto de `LlmBudgetExceededError` en Likida/src/lib/llm/budget.ts. */
export class GatewayBudgetExceededError extends GatewayError {
  constructor(
    readonly scope: 'run' | 'tenant' | 'lane',
    readonly requestedUsd: number,
    readonly limitUsd: number,
  ) {
    super(
      scope === 'run'
        ? `presupuesto de la corrida agotado: se requieren $${requestedUsd.toFixed(6)} y el límite por corrida es $${limitUsd.toFixed(6)}`
        : scope === 'tenant'
          ? `presupuesto diario del tenant agotado: se requieren $${requestedUsd.toFixed(6)} y el techo diario es $${limitUsd.toFixed(6)}`
          : `presupuesto del carril agotado (la reserva restante es de "interactive"): se requieren $${requestedUsd.toFixed(6)} y la parte de este carril es $${limitUsd.toFixed(6)}`,
      false,
    );
  }
}

/**
 * Atraviesa la cadena de `cause` para reconocer un tope de presupuesto
 * aunque venga envuelto en otro error (p.ej. `AllProvidersFailedError`).
 * Mismo motivo que `esErrorDePresupuesto` en Likida budget.ts (auditoría 24,
 * TC-N1): un `instanceof` desnudo se pierde en cuanto el error viaja
 * envuelto.
 */
export function isBudgetExceededError(err: unknown): err is GatewayBudgetExceededError {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur && typeof cur === 'object'; depth++) {
    if (cur instanceof GatewayBudgetExceededError) return true;
    if ((cur as { name?: unknown }).name === 'GatewayBudgetExceededError') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * El gate de residencia bloqueó la ruta: ningún proveedor de la escalera
 * cumple `countryOfResidence === requiredCountry` con el gate activo.
 * Puerto de `NoCompliantProviderError` en
 * licitaciones/packages/agents/src/llm/router.ts.
 */
export class ResidencyGateBlockedError extends GatewayError {
  constructor(readonly requiredCountry: string, readonly candidateIds: string[]) {
    super(
      `gate de residencia activo (país requerido: ${requiredCountry}): ningún proveedor de la escalera lo cumple ` +
        `(candidatos evaluados: ${candidateIds.join(', ') || 'ninguno'})`,
      false,
    );
  }
}

/** Todos los proveedores de la escalera (tras el gate de residencia)
 *  fallaron. Puerto de `OrchestratorBothFailedError` en
 *  atiende.ai/src/lib/llm/orchestrator.ts, generalizado a N proveedores en
 *  vez de solo primary+fallback. */
export class AllProvidersFailedError extends GatewayError {
  constructor(readonly attempts: { providerId: string; error: string }[]) {
    super(
      `todos los proveedores de la escalera fallaron: ${attempts.map((a) => `${a.providerId} (${a.error})`).join('; ')}`,
      false,
    );
  }
}
