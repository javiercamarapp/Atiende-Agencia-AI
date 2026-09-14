// ═══════════════════════════════════════════════════════════════════════════
// LlmGateway — el gateway LLM ÚNICO del monorepo fusionado.
//
// Combina, por cada llamada:
//   1. GATE DE RESIDENCIA (residency.ts, puerto de licitaciones/router.ts):
//      filtra la escalera de proveedores a los que cumplen el país exigido
//      —si el gate está activo—, ANTES de tocar red o presupuesto.
//   2. CIRCUIT BREAKER por proveedor (circuit-breaker.ts, puerto de
//      atiende.ai/llm/circuit-breaker.ts): si el proveedor en turno está
//      OPEN, se salta sin gastar presupuesto.
//   3. PRESUPUESTO reserva-antes-de-gastar (budget.ts, puerto de
//      proyecto-origen/llm/budget.ts): se reserva el costo estimado ANTES de llamar
//      al proveedor; si no hay presupuesto, no se llama.
//   4. ESCALERA DE FALLBACK (puerto de proyecto-origen/llm/openrouter.ts +
//      atiende.ai/llm/orchestrator.ts): si el proveedor falla con un error
//      reintentable, se reporta la falla al breaker, se libera la reserva y
//      se intenta el SIGUIENTE proveedor de la escalera (ya filtrada por el
//      gate de residencia). Un error NO reintentable detiene la escalera de
//      inmediato — no tiene sentido repetir un error de negocio en otro
//      proveedor.
//
// Si la escalera entera se agota, se lanza `AllProvidersFailedError` con el
// detalle de cada intento — el llamador decide qué mostrarle al usuario
// final, igual que `OrchestratorBothFailedError` en el original.
// ═══════════════════════════════════════════════════════════════════════════

import { CircuitBreaker } from './circuit-breaker.js';
import { type BudgetLedgerStore, type GatewayBudgetLimits, createGatewayBudget, reserveBudget, settleBudget } from './budget.js';
import { applyResidencyGate, DEFAULT_RESIDENCY_POLICY, type ResidencyPolicy } from './residency.js';
import { isRetryableProviderError } from './retryable.js';
import { AllProvidersFailedError, GatewayError } from './errors.js';
import type { LlmCompletionRequest, LlmCompletionResult, LlmCostEstimator, LlmLane, LlmProvider } from './types.js';

/** Cota conservadora por defecto: ~1 token por 4 caracteres de entrada más
 *  el techo de salida solicitado, a $10/1M in + $30/1M out (tarifa cara
 *  genérica) — mismo espíritu que `cotaEntradaEnTokens`/`calcCost` en
 *  el proyecto origen: sobre-reservar es seguro, sub-reservar no. Un gateway real de
 *  producción pasaría un `LlmCostEstimator` propio por proveedor (con la
 *  tabla de precios real de cada modelo, como `PRICES` en el original). */
export const defaultCostEstimator: LlmCostEstimator = (_provider, req) => {
  const inputChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
  const estimatedTokensIn = Math.max(1, Math.ceil(inputChars / 4));
  const estimatedTokensOut = req.maxOutputTokens ?? 500;
  const CARO_IN = 10 / 1_000_000;
  const CARO_OUT = 30 / 1_000_000;
  return estimatedTokensIn * CARO_IN + estimatedTokensOut * CARO_OUT;
};

export interface LlmGatewayOptions {
  breaker: CircuitBreaker;
  budgetStore: BudgetLedgerStore;
  budgetLimits: GatewayBudgetLimits;
  residencyPolicy?: ResidencyPolicy;
  costEstimator?: LlmCostEstimator;
}

export interface GatewayCallOptions {
  tenantId: string;
  runId: string;
  lane: LlmLane;
  /** Nombre lógico del rol/componente que hace la llamada (para logging y,
   *  a futuro, para políticas de residencia por componente — hoy la política
   *  es por llamada vía `residency`). */
  role: string;
  request: LlmCompletionRequest;
  /** Sobreescribe la política de residencia por defecto del gateway SOLO
   *  para esta llamada (p.ej. un tenant de licitación de gobierno la activa,
   *  el resto de las verticales no). */
  residency?: Partial<ResidencyPolicy>;
}

export interface GatewayCallResult extends LlmCompletionResult {
  providerId: string;
  /** true si el proveedor que respondió NO es el primero de la escalera
   *  (tras el gate de residencia) — equivalente a `fallbackUsed` en
   *  atiende.ai orchestrator.ts. */
  fallbackUsed: boolean;
  attempts: { providerId: string; error: string }[];
}

export class LlmGateway {
  private readonly breaker: CircuitBreaker;
  private readonly budgetStore: BudgetLedgerStore;
  private readonly budgetLimits: GatewayBudgetLimits;
  private readonly residencyPolicy: ResidencyPolicy;
  private readonly costEstimator: LlmCostEstimator;
  private readonly laddersByRole = new Map<string, LlmProvider[]>();

  constructor(opts: LlmGatewayOptions) {
    this.breaker = opts.breaker;
    this.budgetStore = opts.budgetStore;
    this.budgetLimits = opts.budgetLimits;
    this.residencyPolicy = opts.residencyPolicy ?? DEFAULT_RESIDENCY_POLICY;
    this.costEstimator = opts.costEstimator ?? defaultCostEstimator;
  }

  /** Registra la escalera de proveedores (en orden de preferencia) para un
   *  rol lógico. "Proveedor plegable": se agrega o se quita aquí sin tocar
   *  `complete()`. */
  registerLadder(role: string, providers: LlmProvider[]): void {
    if (providers.length === 0) throw new Error(`gateway: la escalera de "${role}" no puede estar vacía`);
    this.laddersByRole.set(role, providers);
  }

  async complete(opts: GatewayCallOptions): Promise<GatewayCallResult> {
    const ladder = this.laddersByRole.get(opts.role);
    if (!ladder) throw new Error(`gateway: sin proveedores registrados para el rol "${opts.role}" (llamar registerLadder primero)`);

    const policy: ResidencyPolicy = { ...this.residencyPolicy, ...opts.residency };
    // Puede lanzar ResidencyGateBlockedError — se propaga tal cual, antes de
    // tocar presupuesto o red.
    const allowed = applyResidencyGate(ladder, policy);

    const budget = createGatewayBudget(opts.tenantId, opts.runId, opts.lane, this.budgetLimits);
    const attempts: { providerId: string; error: string }[] = [];

    for (let i = 0; i < allowed.length; i++) {
      const provider = allowed[i]!;

      // Puede lanzar CircuitOpenError — se cuenta como intento fallido de
      // ESTE proveedor y se pasa al siguiente, igual que un fallo de red:
      // un breaker abierto es información de que este proveedor está mal,
      // no una razón para abortar toda la escalera.
      try {
        await this.breaker.checkCircuit(provider.id);
      } catch (err) {
        attempts.push({ providerId: provider.id, error: err instanceof Error ? err.message : String(err) });
        continue;
      }

      const estimate = this.costEstimator(provider, opts.request);
      // Puede lanzar GatewayBudgetExceededError — a diferencia de un fallo
      // de proveedor, esto NO es culpa del proveedor: se propaga de
      // inmediato sin probar el resto de la escalera, porque el presupuesto
      // es del tenant/corrida, no del proveedor (otro proveedor no libera
      // presupuesto).
      const reservation = await reserveBudget(this.budgetStore, budget, estimate);

      try {
        const result = await provider.complete(opts.request);
        await settleBudget(this.budgetStore, budget, reservation, result.costUsd);
        await this.breaker.reportSuccess(provider.id);
        return {
          ...result,
          providerId: provider.id,
          fallbackUsed: i > 0,
          attempts,
        };
      } catch (err) {
        // El proveedor falló DESPUÉS de reservar: no se cobró nada real, se
        // libera la reserva a $0 — mismo criterio que el proyecto origen en el catch de
        // `once()`/`attempt()` (BACKEND-19C2-1): no liquidar al monto
        // reservado en un error donde no hubo uso real.
        await settleBudget(this.budgetStore, budget, reservation, 0);
        const message = err instanceof Error ? err.message : String(err);
        attempts.push({ providerId: provider.id, error: message });

        const retryable = err instanceof GatewayError ? err.retryable : isRetryableProviderError(err);
        await this.breaker.reportFailure(provider.id, message);

        if (!retryable) {
          // Error de negocio (p.ej. 400 por input inválido): no tiene
          // sentido repetirlo contra otro proveedor. Se detiene la
          // escalera de inmediato, igual que `classifyError` → 'non_retryable'
          // en licitaciones/errors.ts.
          throw err;
        }
        // Reintentable: seguir con el siguiente proveedor de la escalera.
      }
    }

    throw new AllProvidersFailedError(attempts);
  }
}
