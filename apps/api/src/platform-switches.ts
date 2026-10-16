// Interruptores (kill switches) de plataforma: catalogo de lo que se puede
// detener y el guard con cache que consultan el gateway LLM y los crons.
//
// Catalogo EN TS ademas del CHECK de formato en la base
// (core.platform_switch.platform_switch_target_valido): la API solo acepta
// claves que existen de verdad -- evita guardar un interruptor para un agente
// o cron que nadie consulta (un "apagado" que no apaga nada es peor que no
// tenerlo).
import type { BlockedSwitch, SwitchScope } from "@atiende/db";

/** Roles de agente LLM detenibles. DEBE coincidir con los roles registrados en
 *  production/llm-gateway.ts (un test lo verifica contra ALL_PRODUCTION_ROLES). */
export const SWITCHABLE_AGENT_ROLES: readonly string[] = [
  "restaurantes:whatsapp_agent",
  "restaurantes:data_chat",
  "restaurantes:transcripcion",
  "hoteles:data_chat",
  "rentas:data_chat",
  "despachos:data_chat",
  "licitaciones:data_chat",
  "citas:data_chat",
  "hoteles:whatsapp_agent",
  "citas:whatsapp_agent",
  "licitaciones:requirement_extractor",
  "rentas:mensajeria_agent",
  "licitaciones:proposal_draft_agent",
  "despachos:conciliacion_llm_agent",
  "licitaciones:junta_question_agent",
  "reportes:analisis_financiero",
  "reportes:analisis_general",
  "reportes:redaccion_financiero",
  "reportes:redaccion_general",
  // MOD-12: roles auxiliares del Copiloto.
  "plataforma:enrutador_turno",
  "plataforma:compuerta_escalamiento",
  "plataforma:titulos_resumenes",
  "plataforma:compactacion_historial",
  // CHAT-16: Copiloto de superadmin. Apagado: el turno responde sin llamar al modelo (consultas directas disponibles).
  "superadmin:copiloto",
];

/** Crons detenibles (path exacto de vercel.json / withHeartbeat). */
export const SWITCHABLE_CRONS: readonly string[] = [
  "/internal/citas/confirmacion-cita",
  "/internal/citas/email-dispatch",
  "/internal/citas/google-calendar-sync",
  "/internal/despachos/cfdi-estatus-sat",
  "/internal/despachos/cobranza-reminders",
  "/internal/despachos/efos-69b/descarga",
  "/internal/despachos/email-dispatch",
  "/internal/despachos/vencimientos-barrido",
  "/internal/hoteles/aprobaciones-expiracion",
  "/internal/hoteles/email-dispatch",
  "/internal/hoteles/grupos-liberacion",
  "/internal/hoteles/holds-vencidos",
  "/internal/hoteles/housekeeping-dia",
  "/internal/hoteles/identidad-purga",
  "/internal/hoteles/night-audit",
  "/internal/hoteles/revenue-recommendations",
  "/internal/hoteles/tickets-sla",
  "/internal/licitaciones/alert-notifications",
  "/internal/licitaciones/deadline-reminders",
  "/internal/licitaciones/discover-tenders",
  "/internal/licitaciones/email-dispatch",
  "/internal/plataforma/prueba-avisos",
  "/internal/plataforma/privacidad-retencion",
  "/internal/rentas/acceso-huesped",
  "/internal/rentas/checkin-recordatorio",
  "/internal/rentas/checkout-sweep",
  "/internal/rentas/email-dispatch",
  "/internal/rentas/ical-sync",
  "/internal/rentas/mensajes-automaticos",
  "/internal/restaurantes/cierres-dia",
  "/internal/restaurantes/email-dispatch",
  "/internal/restaurantes/privacidad-retencion",
  "/internal/restaurantes/promover-programados",
  "/internal/restaurantes/repartidor-licencias",
  "/internal/restaurantes/softrestaurant-dispatch",
  "/internal/restaurantes/voz-huerfanas",
  "/internal/superadmin/alertas-cfo",
  "/internal/superadmin/mantenimiento",
  "/internal/superadmin/resumen-diario",
  "/internal/whatsapp/dispatch",
];

const GLOBAL_TARGETS: readonly string[] = ["llm", "crons"];

export function isSwitchableTarget(scope: SwitchScope, target: string): boolean {
  if (scope === "global") return GLOBAL_TARGETS.includes(target);
  if (scope === "agente") return SWITCHABLE_AGENT_ROLES.includes(target);
  if (scope === "cron") return SWITCHABLE_CRONS.includes(target);
  return false;
}

export function switchKey(scope: SwitchScope, target: string): string {
  return `${scope}:${target}`;
}

export interface PlatformSwitchGuard {
  /** Clave del interruptor que detiene este rol LLM, o null. */
  agentBlockedBy(role: string): Promise<string | null>;
  /** Clave del interruptor que detiene este cron (path), o null. */
  cronBlockedBy(cronName: string): Promise<string | null>;
  /** Descarta el cache (tras cambiar un interruptor en esta instancia). */
  invalidate(): void;
}

export interface PlatformSwitchGuardOptions {
  /** Cuanto tarda otra instancia serverless en enterarse de un cambio. */
  readonly ttlMs?: number;
  /** Tras un fallo de lectura se reintenta mas pronto (mantiene el ultimo set bueno). */
  readonly retryAfterErrorMs?: number;
  readonly now?: () => number;
  readonly onError?: (err: unknown) => void;
}

/**
 * Guard con cache y refresco deduplicado. FAIL-OPEN ante un fallo de lectura
 * (conserva el ultimo conjunto conocido, o vacio si nunca hubo uno) y lo
 * registra: es un control operativo de pausa; los topes de gasto siguen
 * fail-closed por su propio camino. Base sin migrar: el repo devuelve vacio.
 */
export function createPlatformSwitchGuard(loader: () => Promise<readonly BlockedSwitch[]>, options: PlatformSwitchGuardOptions = {}): PlatformSwitchGuard {
  const ttlMs = options.ttlMs ?? 10_000;
  const retryAfterErrorMs = options.retryAfterErrorMs ?? 2_000;
  const now = options.now ?? Date.now;
  const onError =
    options.onError ??
    ((err: unknown) =>
      console.error(JSON.stringify({ level: "error", event: "platform_switch_guard_load_failed", message: err instanceof Error ? err.message : String(err) })));

  let blocked: ReadonlySet<string> = new Set();
  let validUntil = 0;
  let inFlight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    try {
      const rows = await loader();
      blocked = new Set(rows.map((r) => switchKey(r.scope, r.target)));
      validUntil = now() + ttlMs;
    } catch (err) {
      onError(err);
      validUntil = now() + retryAfterErrorMs;
    }
  }

  async function current(): Promise<ReadonlySet<string>> {
    if (now() >= validUntil) {
      inFlight ??= refresh().finally(() => {
        inFlight = null;
      });
      await inFlight;
    }
    return blocked;
  }

  return {
    async agentBlockedBy(role) {
      const set = await current();
      if (set.has(switchKey("global", "llm"))) return switchKey("global", "llm");
      if (set.has(switchKey("agente", role))) return switchKey("agente", role);
      // El rol "escalado" de un agente y el rol de REINTENTO por guardia de cifras (`<vertical>:data_chat_retry`) se
      // detienen junto con su rol base.
      for (const suffix of ["_escalated", "_retry"]) {
        if (!role.endsWith(suffix)) continue;
        const base = role.slice(0, -suffix.length);
        if (set.has(switchKey("agente", base))) return switchKey("agente", base);
      }
      return null;
    },
    async cronBlockedBy(cronName) {
      const set = await current();
      if (set.has(switchKey("global", "crons"))) return switchKey("global", "crons");
      if (set.has(switchKey("cron", cronName))) return switchKey("cron", cronName);
      return null;
    },
    invalidate() {
      validUntil = 0;
    },
  };
}
