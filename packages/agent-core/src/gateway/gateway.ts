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
import { type OrgMonthlyBudgetStore, nextOrgMonthlyReservationId } from './org-monthly-budget.js';
import type { RoleDailyTurnStore } from './role-turn-limit.js';
import { deriveVerticalFromRole, NoopUsageRecorder, usdToMicroUsd, type UsageRecorder } from './usage.js';
import { applyResidencyGate, DEFAULT_RESIDENCY_POLICY, type ResidencyPolicy } from './residency.js';
import { isRetryableProviderError } from './retryable.js';
import { lookupModelPrice } from './prices.js';
import { AllProvidersFailedError, GatewayError } from './errors.js';
import { KillSwitchEngagedError, type GatewayKillSwitch } from './kill-switch.js';
import type { LlmCompletionRequest, LlmCompletionResult, LlmCostEstimator, LlmLane, LlmProvider } from './types.js';

/** Cota conservadora por defecto: ~1 token por 4 caracteres de entrada más
 *  el techo de salida solicitado, a $10/1M in + $30/1M out (tarifa cara
 *  genérica) — mismo espíritu que `cotaEntradaEnTokens`/`calcCost` en
 *  el proyecto origen: sobre-reservar es seguro, sub-reservar no. Un gateway real de
 *  producción pasaría un `LlmCostEstimator` propio por proveedor (con la
 *  tabla de precios real de cada modelo, como `PRICES` en el original). */
export const defaultCostEstimator: LlmCostEstimator = (provider, req) => {
  const toolsChars = req.tools ? JSON.stringify(req.tools).length : 0;
  const inputChars = req.system.length + toolsChars + req.messages.reduce((n, m) => n + m.content.length + (m.role === 'user' && m.audio ? m.audio.data.length : 0), 0);
  const estimatedTokensIn = Math.max(1, Math.ceil(inputChars / 4));
  // Con el tope REAL que manda el escalon (p.ej. el piso minMaxTokens de un modelo que razona), no el pedido: pedir 150
  // tokens a un modelo con piso de 1500 puede costar 1500 de salida.
  const estimatedTokensOut = provider.effectiveMaxOutputTokens?.(req) ?? req.maxOutputTokens ?? 500;
  // Con el precio real del modelo (tabla de respaldo, ver prices.ts) la reserva es ajustada; un
  // modelo sin fila cae al tope caro generico de abajo (sobre-reservar es seguro).
  const price = lookupModelPrice(provider.model);
  if (price) return (estimatedTokensIn * price.inPerM + estimatedTokensOut * price.outPerM) / 1_000_000;
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
  /** Tope MENSUAL por organización + tope GLOBAL de plataforma, persistente
   *  entre instancias (ver `org-monthly-budget.ts`) — DISTINTO de `budgetStore`
   *  (ese es el tope diario/de-corrida en memoria de proceso). Opcional:
   *  `undefined` preserva el comportamiento previo a este campo (ningún
   *  gateway/test existente que no lo pase se ve afectado). Cuando se pasa,
   *  se consulta ANTES de `budgetStore.reserve`, en el mismo punto
   *  "reserva-antes-de-gastar" — un tope mensual agotado nunca llega a tocar
   *  el resto de la escalera de presupuesto ni al proveedor. */
  orgMonthlyBudgetStore?: OrgMonthlyBudgetStore;
  /** Tope DIARIO de turnos por organización y rol (ver `role-turn-limit.ts`): se consulta UNA vez por `complete()`, antes de
   *  reservar presupuesto o tocar la red; el turno que lo excede lanza `RoleDailyTurnLimitExceededError` y no consume cupo.
   *  Opcional: `undefined` preserva el comportamiento previo. */
  roleTurnStore?: RoleDailyTurnStore;
  /** Puerto de registro de uso (control de gasto de API de LLM del back office
   *  de plataforma, ver `usage.ts`) — puramente observacional, nunca decide si
   *  una llamada procede. `NoopUsageRecorder` por defecto: ningún gateway/test
   *  existente que no lo pase se ve afectado. */
  usageRecorder?: UsageRecorder;
  /** Interruptor de plataforma (ver `kill-switch.ts`): consultado al INICIO de
   *  cada `complete()`, antes de residencia/red/presupuesto. Opcional:
   *  `undefined` preserva el comportamiento previo a este campo. */
  killSwitch?: GatewayKillSwitch;
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
  /** Modelo preferido para ESTA llamada (p.ej. el que eligio la organizacion en sus ajustes). Solo vale si ese modelo esta
   *  registrado para el rol: en la escalera del rol o en `registerAlternatives`. Pasa al frente y el resto de la escalera
   *  queda detras como respaldo; un modelo no registrado se IGNORA (nunca se llama a un modelo no listado). El rol, el
   *  interruptor de plataforma, el tope diario y el registro de uso siguen siendo los del rol: elegir modelo no los esquiva. */
  preferredModel?: string;
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
  private readonly orgMonthlyBudgetStore: OrgMonthlyBudgetStore | undefined;
  private readonly roleTurnStore: RoleDailyTurnStore | undefined;
  private readonly usageRecorder: UsageRecorder;
  private readonly killSwitch: GatewayKillSwitch | undefined;
  private readonly laddersByRole = new Map<string, LlmProvider[]>();
  /** Modelos elegibles por rol que NO van en la escalera por defecto (rol -> modelo -> proveedor). */
  private readonly alternativesByRole = new Map<string, Map<string, LlmProvider>>();

  constructor(opts: LlmGatewayOptions) {
    this.breaker = opts.breaker;
    this.budgetStore = opts.budgetStore;
    this.budgetLimits = opts.budgetLimits;
    this.residencyPolicy = opts.residencyPolicy ?? DEFAULT_RESIDENCY_POLICY;
    this.costEstimator = opts.costEstimator ?? defaultCostEstimator;
    this.orgMonthlyBudgetStore = opts.orgMonthlyBudgetStore;
    this.roleTurnStore = opts.roleTurnStore;
    this.usageRecorder = opts.usageRecorder ?? NoopUsageRecorder;
    this.killSwitch = opts.killSwitch;
  }

  /** Registra la escalera de proveedores (en orden de preferencia) para un
   *  rol lógico. "Proveedor plegable": se agrega o se quita aquí sin tocar
   *  `complete()`. */
  registerLadder(role: string, providers: LlmProvider[]): void {
    if (providers.length === 0) throw new Error(`gateway: la escalera de "${role}" no puede estar vacía`);
    this.laddersByRole.set(role, providers);
  }

  /** Registra modelos que un rol puede usar SOLO cuando el llamador los pide con `preferredModel`; nunca entran a la
   *  escalera por defecto (un fallo no cae a ellos). La clave es el `model` del proveedor. Si el modelo tambien esta en la
   *  escalera del rol, al elegirlo se usa ESTA alternativa y no el escalon (se quita de la escalera para no repetirlo). */
  registerAlternatives(role: string, providers: LlmProvider[]): void {
    const porModelo = new Map<string, LlmProvider>();
    for (const p of providers) {
      if (!p.model) throw new Error(`gateway: una alternativa del rol "${role}" debe declarar su modelo`);
      porModelo.set(p.model, p);
    }
    this.alternativesByRole.set(role, porModelo);
  }

  /** Escalera efectiva de una llamada: la del rol, con el modelo preferido (si esta registrado) al frente. */
  private ladderFor(role: string, preferredModel: string | undefined): LlmProvider[] {
    const base = this.laddersByRole.get(role);
    if (!base) throw new Error(`gateway: sin proveedores registrados para el rol "${role}" (llamar registerLadder primero)`);
    if (!preferredModel) return base;
    // La alternativa registrada manda sobre un escalon de la escalera con el mismo modelo: es la que el rol declaro para ELEGIR ese modelo
    // (p.ej. con la temperatura habilitada, que los escalones por defecto omiten).
    const elegido = this.alternativesByRole.get(role)?.get(preferredModel) ?? base.find((p) => p.model === preferredModel);
    if (!elegido) return base;
    return [elegido, ...base.filter((p) => p !== elegido && p.model !== elegido.model)];
  }

  async complete(opts: GatewayCallOptions): Promise<GatewayCallResult> {
    const ladder = this.ladderFor(opts.role, opts.preferredModel);

    // Interruptor de plataforma: ANTES de residencia, breaker, presupuesto y red.
    // Un fallo del propio puerto es fail-open (nunca tumba a los agentes por un
    // problema del mecanismo de pausa); la decision "bloqueado" SI es definitiva.
    if (this.killSwitch) {
      let blockedBy: string | null = null;
      try {
        blockedBy = await this.killSwitch.blockedBy(opts.role);
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', event: 'gateway_kill_switch_check_failed', role: opts.role, message: err instanceof Error ? err.message : String(err) }));
      }
      if (blockedBy) throw new KillSwitchEngagedError(blockedBy, opts.role);
    }

    const policy: ResidencyPolicy = { ...this.residencyPolicy, ...opts.residency };
    // Puede lanzar ResidencyGateBlockedError — se propaga tal cual, antes de
    // tocar presupuesto o red.
    const allowed = applyResidencyGate(ladder, policy);

    // Tope diario de turnos del rol: una vez por llamada (no por escalón de la escalera). Puede lanzar
    // `RoleDailyTurnLimitExceededError`, que se propaga de inmediato.
    if (this.roleTurnStore) await this.roleTurnStore.consume(opts.tenantId, opts.role);

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
      const estimateMicroUsd = usdToMicroUsd(estimate);

      // Tope MENSUAL (organización + plataforma), persistente entre
      // instancias — se consulta ANTES que el tope diario/de-corrida de abajo,
      // mismo criterio "reserva-antes-de-gastar": puede lanzar
      // `MonthlyBudgetExceededError`, que se propaga de inmediato sin probar
      // el resto de la escalera ni tocar `budgetStore` (misma razón que el
      // comentario de abajo: no es culpa del proveedor, es un tope de
      // negocio del tenant/plataforma).
      const monthlyReservationId = this.orgMonthlyBudgetStore ? nextOrgMonthlyReservationId() : undefined;
      if (this.orgMonthlyBudgetStore && monthlyReservationId) {
        await this.orgMonthlyBudgetStore.reserve(opts.tenantId, monthlyReservationId, estimateMicroUsd, opts.role);
      }

      // Puede lanzar GatewayBudgetExceededError — a diferencia de un fallo
      // de proveedor, esto NO es culpa del proveedor: se propaga de
      // inmediato sin probar el resto de la escalera, porque el presupuesto
      // es del tenant/corrida, no del proveedor (otro proveedor no libera
      // presupuesto).
      let reservation;
      try {
        reservation = await reserveBudget(this.budgetStore, budget, estimate);
      } catch (err) {
        // El tope diario/de-corrida frenó DESPUÉS de que el tope mensual ya
        // reservó su parte — libera esa reserva mensual a 0 antes de
        // propagar, para no dejar gasto fantasma contra un tope que nunca se
        // llegó a usar de verdad.
        if (this.orgMonthlyBudgetStore && monthlyReservationId) {
          await this.orgMonthlyBudgetStore.settle(opts.tenantId, monthlyReservationId, 0).catch(() => {});
        }
        throw err;
      }

      // GUARDA CONTRA TEXTO DUPLICADO: si el llamador hace streaming y este escalon ya le entrego texto
      // antes de fallar, pasar al siguiente escalon le haria llegar OTRA respuesta completa encima de la
      // parcial (texto duplicado/mezclado de dos modelos). En ese caso la escalera se detiene.
      let streamedText = false;
      const onTextDelta = opts.request.onTextDelta;
      const request: LlmCompletionRequest = onTextDelta
        ? {
            ...opts.request,
            onTextDelta: (delta) => {
              if (delta.length > 0) streamedText = true;
              onTextDelta(delta);
            },
          }
        : opts.request;

      try {
        const result = await provider.complete(request);
        const actualMicroUsd = usdToMicroUsd(result.costUsd);
        await settleBudget(this.budgetStore, budget, reservation, result.costUsd);
        if (this.orgMonthlyBudgetStore && monthlyReservationId) {
          // Ajuste del tope mensual best-effort: un fallo AQUÍ (Postgres caído
          // justo entre el reserve y el settle) deja la reserva conservadora
          // (la estimación, sobre-reservada a propósito) en vez del costo
          // real más bajo — seguro por diseño (nunca sub-cuenta), nunca debe
          // tumbar una llamada al LLM que YA tuvo éxito.
          await this.orgMonthlyBudgetStore.settle(opts.tenantId, monthlyReservationId, actualMicroUsd).catch(() => {});
        }
        await this.breaker.reportSuccess(provider.id);

        // Registro de uso — puramente observacional (control de gasto de API
        // de LLM del back office de plataforma). Envuelto en su propio
        // try/catch: un fallo de registro NUNCA convierte en error una
        // llamada al LLM que sí tuvo éxito (mismo criterio best-effort que
        // `ProductionHotelesFraudeAuditSink`/`ProductionDespachosAuditSink`
        // en apps/api/src/production/).
        try {
          await this.usageRecorder.record({
            organizationId: opts.tenantId,
            vertical: deriveVerticalFromRole(opts.role),
            role: opts.role,
            lane: opts.lane,
            providerId: provider.id,
            model: result.model,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            ...(result.tokensCached !== undefined ? { tokensCached: result.tokensCached } : {}),
            ...(result.tokensReasoning !== undefined ? { tokensReasoning: result.tokensReasoning } : {}),
            costMicroUsd: actualMicroUsd,
            fallbackUsed: i > 0,
            occurredAt: new Date().toISOString(),
          });
        } catch {
          // best-effort: nunca tumba la llamada al LLM que ya tuvo éxito.
        }

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
        if (this.orgMonthlyBudgetStore && monthlyReservationId) {
          await this.orgMonthlyBudgetStore.settle(opts.tenantId, monthlyReservationId, 0).catch(() => {});
        }
        const message = err instanceof Error ? err.message : String(err);
        attempts.push({ providerId: provider.id, error: message });

        const retryable = err instanceof GatewayError ? err.retryable : isRetryableProviderError(err);
        await this.breaker.reportFailure(provider.id, message);

        if (streamedText) {
          // Ya se emitio texto de este escalon: no se reintenta con otro modelo (duplicaria la salida).
          throw err;
        }

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
