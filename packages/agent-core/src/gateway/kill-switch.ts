// Interruptor de plataforma (kill switch) del gateway LLM.
//
// Puerto agnostico de Postgres (mismo criterio que `UsageRecorder`/
// `OrgMonthlyBudgetStore`): quien arma el gateway decide de donde sale la
// decision. El gateway lo consulta ANTES de tocar residencia, red o
// presupuesto -- una llamada detenida no gasta nada.
//
// Semantica de fallo del PUERTO: `blockedBy` nunca debe lanzar; si lo hace, el
// gateway lo trata como "no bloqueado" (fail-open) y registra el fallo. Es un
// control operativo de pausa, no un control de gasto: la proteccion de gasto
// real (topes por reserva) sigue fail-closed y es independiente.
import { GatewayError } from './errors.js';

export interface GatewayKillSwitch {
  /** Clave del interruptor que detiene este `role` (p. ej. `global:llm` o
   *  `agente:restaurantes:whatsapp_agent`), o `null` si no esta detenido. */
  blockedBy(role: string): Promise<string | null>;
}

/** El rol esta detenido por un interruptor de plataforma. NO reintentable: otro
 *  proveedor de la escalera no cambia la decision del operador. */
export class KillSwitchEngagedError extends GatewayError {
  constructor(
    readonly switchKey: string,
    readonly role: string,
  ) {
    super(`interruptor de plataforma activo (${switchKey}): las llamadas LLM del rol "${role}" estan detenidas`, false);
  }
}

export function isKillSwitchEngagedError(err: unknown): err is KillSwitchEngagedError {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur && typeof cur === 'object'; depth++) {
    if (cur instanceof KillSwitchEngagedError) return true;
    if ((cur as { name?: unknown }).name === 'KillSwitchEngagedError') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
