// Fusiona `ProviderRouter`/`EnvProvider` de hoteles (fallback en cascada) con el gate
// de residencia de licitaciones (packages/agents/src/llm/router.ts,
// REQ-125/REQ-126/AG-06): 5 "componentes de tolerancia cero" que en licitaciones
// SIEMPRE van a un proveedor con `countryOfResidence === "US"`, sin excepción
// configurable. Aquí se generaliza esa misma regla a nivel de gateway compartido, más
// circuit breaker (nuevo, ./circuitBreaker.ts) y presupuesto por carril (nuevo,
// ./budget.ts) — ninguno de los dos existía en ningún repo origen.
import type { Vertical } from "@atiende/core-tenancy";
import type { CircuitBreaker } from "./circuitBreaker.ts";
import type { LaneBudgetTracker } from "./budget.ts";
import { LaneBudgetExceededError } from "./budget.ts";
import type { LlmCompleteParams, LlmCompletion, LlmProvider } from "./provider.ts";
import { ProviderHttpError, ProviderTransientError } from "./provider.ts";

/**
 * Un "carril" (lane) es la unidad de presupuesto y enrutamiento: organización +
 * vertical + rol de modelo. El rol es OPACO al gateway — cada domain-<vertical> define
 * su propio enum (hoteles: ModelRole "canal"|"enrutador"|"batch_nocturno"; licitaciones:
 * ModelTier "economico"|"estandar"|"premium" — el gateway no unifica esos nombres,
 * solo los trata como string para efectos de presupuesto/breaker).
 */
export interface AgentLane {
  readonly organizationId: string;
  readonly vertical: Vertical;
  readonly role: string;
}

export function laneKey(lane: AgentLane): string {
  return `${lane.organizationId}:${lane.vertical}:${lane.role}`;
}

/** Ningún proveedor CONFORME a la residencia exigida por un carril de tolerancia cero
 * está disponible — NUNCA degrada en silencio a un proveedor no conforme. */
export class NoCompliantProviderError extends Error {
  readonly lane: AgentLane;

  constructor(lane: AgentLane, requiredCountry: string, triedProviderIds: readonly string[]) {
    super(
      `el carril "${laneKey(lane)}" exige tolerancia cero de residencia (${requiredCountry}) y ningún proveedor ` +
        `conforme está disponible (probados: ${triedProviderIds.join(", ") || "ninguno"}).`,
    );
    this.name = "NoCompliantProviderError";
    this.lane = lane;
  }
}

/** Ningún proveedor elegible (disponible + breaker cerrado/half-open) quedó para este
 * carril, sin que aplicara la restricción de tolerancia cero. */
export class AllProvidersUnavailableError extends Error {
  readonly lane: AgentLane;

  constructor(lane: AgentLane, triedProviderIds: readonly string[]) {
    super(
      `el carril "${laneKey(lane)}" no tiene ningún proveedor disponible ` +
        `(probados: ${triedProviderIds.join(", ") || "ninguno"}).`,
    );
    this.name = "AllProvidersUnavailableError";
    this.lane = lane;
  }
}

export interface GatewayRouterOptions {
  readonly id?: string;
  /** Proveedores en orden de prioridad — el primero elegible de la lista es al que se llama. */
  readonly providers: readonly LlmProvider[];
  /** Circuit breaker por `providerId`. Un proveedor sin entrada en el mapa se trata
   * como si siempre estuviera disponible a nivel de breaker (`canAttempt() === true`). */
  readonly circuitBreakers: ReadonlyMap<string, CircuitBreaker>;
  /**
   * Carriles (`lane.role`, no vertical entera) que exigen SIEMPRE un proveedor con
   * `countryOfResidence === requiredCountryForZeroTolerance`. Generaliza
   * `ZERO_TOLERANCE_COMPONENTS` de licitaciones a nivel de gateway compartido — el set
   * en sí sigue viviendo en `domain-licitaciones`, el gateway solo consume la lista,
   * nunca la decide.
   */
  readonly zeroToleranceLaneRoles: ReadonlySet<string>;
  /** Política configurable (nunca eliminable): qué país exige un carril de tolerancia
   * cero. Default "US". Configurable en el sentido de "qué país", NUNCA en el sentido
   * de "si aplica o no" para un lane declarado zero-tolerance — eso sigue siendo
   * invariante de código, igual que AG-06 en licitaciones. */
  readonly requiredCountryForZeroTolerance?: string;
  /** Presupuesto persistente por carril (ver budget.ts). Opcional: sin él, el router
   * no aplica ningún techo de costo (solo enrutamiento + breaker + fallback). */
  readonly laneBudgetTracker?: LaneBudgetTracker;
  /** Estima el costo USD de una `LlmCompletion` ya resuelta, para registrarlo en
   * `laneBudgetTracker` — inyectable porque el pricing real (por modelo/proveedor) es
   * responsabilidad de cada domain-<vertical>/de un futuro `pricing.ts`, no de este
   * gateway. Sin `laneBudgetTracker` este campo no se usa. */
  readonly estimateCostUsd?: (completion: LlmCompletion, provider: LlmProvider) => number;
}

const DEFAULT_REQUIRED_COUNTRY = "US";

function passthroughBreaker(): CircuitBreaker {
  return {
    providerId: "sin-breaker-configurado",
    state: () => "closed",
    canAttempt: () => true,
    onSuccess: () => undefined,
    onFailure: () => undefined,
  };
}

export class GatewayRouter {
  readonly id: string;
  private readonly providers: readonly LlmProvider[];
  private readonly circuitBreakers: ReadonlyMap<string, CircuitBreaker>;
  private readonly zeroToleranceLaneRoles: ReadonlySet<string>;
  private readonly requiredCountry: string;
  private readonly laneBudgetTracker: LaneBudgetTracker | undefined;
  private readonly estimateCostUsd: ((completion: LlmCompletion, provider: LlmProvider) => number) | undefined;
  private lastUsedProviderId: string | undefined;

  constructor(options: GatewayRouterOptions) {
    if (options.providers.length === 0) {
      throw new Error("GatewayRouter requiere al menos un LlmProvider registrado.");
    }
    this.id = options.id ?? "gateway";
    this.providers = options.providers;
    this.circuitBreakers = options.circuitBreakers;
    this.zeroToleranceLaneRoles = options.zeroToleranceLaneRoles;
    this.requiredCountry = options.requiredCountryForZeroTolerance ?? DEFAULT_REQUIRED_COUNTRY;
    this.laneBudgetTracker = options.laneBudgetTracker;
    this.estimateCostUsd = options.estimateCostUsd;
  }

  getLastUsedProviderId(): string | undefined {
    return this.lastUsedProviderId;
  }

  private breakerFor(providerId: string): CircuitBreaker {
    return this.circuitBreakers.get(providerId) ?? passthroughBreaker();
  }

  private candidatesFor(lane: AgentLane): readonly LlmProvider[] {
    if (this.zeroToleranceLaneRoles.has(lane.role)) {
      return this.providers.filter((p) => p.countryOfResidence === this.requiredCountry);
    }
    return this.providers;
  }

  private eligible(lane: AgentLane): readonly LlmProvider[] {
    return this.candidatesFor(lane).filter((p) => p.isAvailable() && this.breakerFor(p.id).canAttempt());
  }

  /**
   * Resuelve (sin llamar) el proveedor que `complete()` intentaría primero para este
   * carril. Lanza `NoCompliantProviderError`/`AllProvidersUnavailableError` en vez de
   * devolver `undefined` — nunca hay un "no sé" silencioso.
   */
  route(lane: AgentLane): LlmProvider {
    const candidates = this.candidatesFor(lane);
    const eligible = candidates.filter((p) => p.isAvailable() && this.breakerFor(p.id).canAttempt());
    if (eligible.length === 0) {
      if (this.zeroToleranceLaneRoles.has(lane.role)) {
        throw new NoCompliantProviderError(
          lane,
          this.requiredCountry,
          candidates.map((p) => p.id),
        );
      }
      throw new AllProvidersUnavailableError(
        lane,
        this.providers.map((p) => p.id),
      );
    }
    return eligible[0]!;
  }

  /**
   * 1. Presupuesto: si `laneBudgetTracker` está configurado y el carril ya está
   *    agotado, `LaneBudgetExceededError` ANTES de intentar cualquier proveedor.
   * 2. Selecciona candidatos con `candidatesFor` (aplica el gate de tolerancia cero si
   *    corresponde) y los recorre en orden, saltando los que no estén elegibles
   *    (`isAvailable()` + `breaker.canAttempt()`).
   * 3. `ProviderTransientError` -> `breaker.onFailure()` + reintenta con el SIGUIENTE
   *    candidato elegible. `ProviderHttpError` se propaga tal cual, sin tocar el
   *    breaker ni reintentar. Éxito -> `breaker.onSuccess()` + registra costo real.
   * 4. Si el gate de tolerancia cero dejó CERO candidatos: `NoCompliantProviderError`
   *    (nunca degrada a un proveedor no conforme). Si ningún candidato es elegible por
   *    disponibilidad/breaker: `AllProvidersUnavailableError`.
   */
  async complete(lane: AgentLane, params: LlmCompleteParams): Promise<LlmCompletion> {
    if (this.laneBudgetTracker && (await this.laneBudgetTracker.agotado(lane))) {
      throw new LaneBudgetExceededError(lane);
    }

    const candidates = this.candidatesFor(lane);
    if (candidates.length === 0 && this.zeroToleranceLaneRoles.has(lane.role)) {
      throw new NoCompliantProviderError(lane, this.requiredCountry, []);
    }

    const tried: string[] = [];
    let lastTransientError: ProviderTransientError | undefined;

    for (const provider of candidates) {
      const breaker = this.breakerFor(provider.id);
      if (!provider.isAvailable() || !breaker.canAttempt()) continue;
      tried.push(provider.id);

      try {
        const completion = await provider.complete(params);
        breaker.onSuccess();
        this.lastUsedProviderId = provider.id;
        if (this.laneBudgetTracker && this.estimateCostUsd) {
          await this.laneBudgetTracker.registrarCostoUsd(lane, this.estimateCostUsd(completion, provider));
        }
        return completion;
      } catch (err) {
        if (err instanceof ProviderTransientError) {
          breaker.onFailure(err);
          lastTransientError = err;
          continue; // fallback en cascada al siguiente candidato
        }
        if (err instanceof ProviderHttpError) {
          throw err; // nunca dispara fallback, se propaga tal cual
        }
        throw err; // error inesperado del proveedor: no se enmascara
      }
    }

    if (this.zeroToleranceLaneRoles.has(lane.role)) {
      throw new NoCompliantProviderError(
        lane,
        this.requiredCountry,
        candidates.map((p) => p.id),
      );
    }
    if (tried.length === 0) {
      throw new AllProvidersUnavailableError(
        lane,
        this.providers.map((p) => p.id),
      );
    }
    // Se intentaron candidatos y todos fallaron de forma transitoria.
    throw (
      lastTransientError ??
      new AllProvidersUnavailableError(
        lane,
        this.providers.map((p) => p.id),
      )
    );
  }
}
