// ═══════════════════════════════════════════════════════════════════════════
// Tope DIARIO de turnos LLM por organización y rol (CHAT-07). Un "turno" es una llamada al gateway
// (`complete()`); cada rol tiene un tope por día, configurable por organización con un default.
//
// Igual que `org-monthly-budget.ts`, este archivo define el CONTRATO (puerto) y una implementación de
// referencia en memoria (`InMemoryRoleDailyTurnStore`, con reloj inyectable para probar el cambio de día
// sin esperar); el store Postgres real (`apps/api/src/production/llm-role-turn-store.ts`) llama a
// `core.consume_llm_role_turn`, que cuenta de forma atómica entre instancias.
//
// Semántica: `consume` sube el contador solo si hay cupo; el turno N+1 lanza `RoleDailyTurnLimitExceededError`
// SIN consumir. Un rol sin tope (ni default ni de organización) no se limita.
// ═══════════════════════════════════════════════════════════════════════════
import { RoleDailyTurnLimitExceededError } from './errors.js';

export interface RoleDailyTurnStore {
  /** Consume un turno de `role` para `organizationId` en el día en curso; lanza `RoleDailyTurnLimitExceededError` si ya se llegó al tope. */
  consume(organizationId: string, role: string): Promise<void>;
}

export interface InMemoryRoleDailyTurnOptions {
  /** Tope diario por rol cuando la organización no tiene uno propio. Un rol ausente no tiene tope. */
  readonly defaultLimits: Readonly<Record<string, number>>;
  /** Topes propios: clave `"<organizationId>|<role>"`. */
  readonly orgLimits?: Readonly<Record<string, number>>;
  /** Reloj inyectable (pruebas). Por defecto la hora real; el día se mide en UTC, igual que `current_date` de la base. */
  readonly now?: () => Date;
}

export class InMemoryRoleDailyTurnStore implements RoleDailyTurnStore {
  private readonly counts = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly opts: InMemoryRoleDailyTurnOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  async consume(organizationId: string, role: string): Promise<void> {
    const limit = this.opts.orgLimits?.[`${organizationId}|${role}`] ?? this.opts.defaultLimits[role];
    if (limit === undefined) return;
    const key = `${this.now().toISOString().slice(0, 10)}|${organizationId}|${role}`;
    const used = this.counts.get(key) ?? 0;
    // Sin await entre la lectura y la escritura: dos turnos "en paralelo" se serializan en el bucle de eventos.
    if (used >= limit) throw new RoleDailyTurnLimitExceededError(role, organizationId, used, limit);
    this.counts.set(key, used + 1);
  }

  /** Solo para tests. */
  reset(): void {
    this.counts.clear();
  }
}
