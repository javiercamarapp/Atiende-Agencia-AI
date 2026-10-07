// Cableado del Copiloto de superadmin (CHAT-16) en `AppDeps.superadminCopiloto`. Opcional: sin el, las rutas responden "no activado" (nunca 500).
//
// GASTO PROPIO (decision documentada en la migracion 0048): el Copiloto de plataforma NO pasa por el gateway compartido de los tenants (su registro de
// uso, `core.llm_usage_daily`, y sus topes por organizacion exigen una organizacion real: `organization_id` es obligatorio). Usa un
// gateway DEDICADO (`buildSuperadminCopilotoLlmGateway`, con su propio circuit breaker, su tope de corrida/dia en memoria y el interruptor de
// plataforma) y su gasto REAL queda en la fila de resumen de cada turno de `core.data_chat_query_log` (vertical 'plataforma'). El tope mensual propio se
// compara contra `core.get_copiloto_plataforma_gasto_mes` y, ademas, contra un acumulador en memoria de la instancia (cubre la base sin migrar y la ventana
// entre el commit de un turno y el siguiente). El valor del tope y el presupuesto real en produccion los fija Javier (SA-44).
import type { DataChatAuditSink, DataChatCompletion, DataChatRateLimiter } from "@atiende/agent-core/data-chat";
import { gatewayCompletion } from "@atiende/agent-core/data-chat";
import type { LlmGateway } from "@atiende/agent-core";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { ConversacionesRepository } from "../data-chat/conversaciones.ts";
import { dataChatRateLimiter } from "../data-chat/deps.ts";
import { SUPERADMIN_COPILOTO_ROLE } from "../production/llm-models.ts";
import { PLATAFORMA_ORG_CLAVE } from "./alcance.ts";
import type { FuentesPlataforma } from "./fuentes.ts";
import type { PinsPlataformaRepository } from "./pins.ts";

/** Tope mensual por defecto del Copiloto de plataforma: 25 USD. Valor PROVISIONAL de seguridad hasta que Javier fije el presupuesto real (SA-44). */
export const TOPE_MENSUAL_COPILOTO_MICRO_USD = 25_000_000;

/** Acumulador del gasto del mes EN ESTA INSTANCIA (micro-USD). Complementa a la bitacora; se reinicia al cambiar de mes. */
export interface LedgerMensual {
  sumar(microUsd: number, ahora?: Date): void;
  mes(ahora?: Date): number;
}

export function crearLedgerMensual(): LedgerMensual {
  let clave = "";
  let total = 0;
  const alinear = (ahora: Date): void => {
    const k = ahora.toISOString().slice(0, 7);
    if (k !== clave) {
      clave = k;
      total = 0;
    }
  };
  return {
    sumar(microUsd, ahora = new Date()) {
      alinear(ahora);
      if (Number.isFinite(microUsd) && microUsd > 0) total += Math.trunc(microUsd);
    },
    mes(ahora = new Date()) {
      alinear(ahora);
      return total;
    },
  };
}

export interface SuperadminCopilotoDeps {
  /** undefined = ningun proveedor LLM configurado: el chat responde "no activado" (las consultas directas sin modelo siguen funcionando). */
  readonly completion: DataChatCompletion | undefined;
  readonly rateLimiter: DataChatRateLimiter;
  readonly ledger: LedgerMensual;
  /** Tope mensual propio (micro-USD); sin el, `TOPE_MENSUAL_COPILOTO_MICRO_USD`. */
  readonly topeMensualMicroUsd?: number;
  /** Para pruebas: fuentes de datos en lugar de las de produccion (`fuentesDeProduccion`). */
  readonly fuentes?: (db: TenantDbSession, callerId: string) => FuentesPlataforma;
  /** Para pruebas: repositorio de conversaciones en lugar del de Postgres. */
  readonly conversaciones?: (db: TenantDbSession) => ConversacionesRepository;
  /** Para pruebas: repositorio de fijados de plataforma en lugar del de Postgres. */
  readonly pins?: (db: TenantDbSession) => PinsPlataformaRepository;
  /** Para pruebas: bitacora en lugar de `PostgresPlataformaAuditSink`. */
  readonly audit?: (db: TenantDbSession) => DataChatAuditSink;
}

/** `gateway` = el gateway DEDICADO del Copiloto de superadmin (nunca el de los tenants). */
export function buildProductionSuperadminCopiloto(gateway: LlmGateway | undefined): SuperadminCopilotoDeps {
  return {
    completion: gateway ? gatewayCompletion(gateway, { tenantId: PLATAFORMA_ORG_CLAVE, role: SUPERADMIN_COPILOTO_ROLE }) : undefined,
    rateLimiter: dataChatRateLimiter,
    ledger: crearLedgerMensual(),
  };
}
