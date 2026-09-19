// Motor puro de "Salud operativa" -- SIN I/O, 100% testeable. Traduce el
// estado crudo que llega de `@atiende/db::SaludRepository` (latidos de
// cron, salud de colas, últimas corridas de fuentes de licitaciones) y del
// gasto de LLM (`@atiende/db::LlmPlatformBudgetRow`, ya expuesto por
// `apps/api/src/routes/superadmin-llm-usage.ts` -- reutilizado, NUNCA
// duplicado aquí) en un veredicto DETERMINISTA: nunca un LLM opinando sobre
// si algo está sano.
//
// Principio rector, repetido en cada función de abajo: `null` (no se pudo
// leer esa fuente) es SIEMPRE distinto de "cero"/"vacío" (sí se leyó, no hay
// nada) -- un fallo de lectura se convierte en alerta propia ("no se pudo
// leer"), NUNCA se interpreta como "todo bien".

export type CronHeartbeatStatus = "ok" | "error";

export interface CronHeartbeatRow {
  readonly cronName: string;
  readonly lastStartedAt: string | null;
  readonly lastFinishedAt: string | null;
  readonly lastStatus: CronHeartbeatStatus | null;
  readonly lastError: string | null;
  readonly lastDurationMs: number | null;
  readonly consecutiveFailures: number;
}

/** `ok` = corrió dentro de su cadencia esperada + tolerancia, sin error.
 *  `vencido` = pasó la cadencia esperada + tolerancia sin un latido nuevo
 *  (distingue "apagado a propósito" -- cadencia 0/indeterminada, nunca
 *  vence -- de "muerto"). `sin_latido` = nunca se registró un latido para
 *  este cron. `error` = el último latido registrado terminó en error
 *  (independiente de qué tan reciente sea -- un cron que SIGUE corriendo
 *  pero siempre falla no debe leerse como "ok" solo por ser puntual). */
export type EstadoCron = "ok" | "vencido" | "sin_latido" | "error";

/** Tolerancia (minutos) sobre la cadencia esperada antes de declarar
 *  "vencido" -- separa un cron que corrió unos minutos tarde (normal en
 *  cualquier scheduler real) de uno realmente muerto. */
export const TOLERANCIA_VENCIDO_MIN = 20;

/** Fallos consecutivos a partir de los cuales, incluso si el cron sigue
 *  corriendo puntual, se levanta una alerta propia (más allá de la alerta
 *  de estado "error" del latido más reciente) -- un cron que falla 1 vez es
 *  ruido; uno que falla 3+ veces seguidas es una tendencia real. */
export const UMBRAL_FALLOS_CONSECUTIVOS = 3;

/**
 * Clasifica UN cron. Pura: ninguna llamada a `Date.now()`/reloj propio --
 * `ahora` siempre se recibe como parámetro (testeable con cualquier fecha
 * fija).
 *
 * `cadenciaMin`: minutos esperados entre corridas, derivados de
 * `vercel.json::crons` (ver `./cadencia.ts::minutosEsperadosDeCron`). `0` o
 * negativo = cadencia indeterminada/sin cron automático -- este cron NUNCA
 * se declara `vencido` (evita inventar una cadencia que no existe).
 */
export function juzgarLatido(latido: CronHeartbeatRow | null, cadenciaMin: number, ahora: Date): EstadoCron {
  if (!latido || !latido.lastFinishedAt || !latido.lastStatus) return "sin_latido";
  if (latido.lastStatus === "error") return "error";

  if (cadenciaMin > 0) {
    const finishedAt = new Date(latido.lastFinishedAt);
    const minutosTranscurridos = (ahora.getTime() - finishedAt.getTime()) / 60_000;
    if (minutosTranscurridos > cadenciaMin + TOLERANCIA_VENCIDO_MIN) return "vencido";
  }
  return "ok";
}

export interface OutboxQueueHealthRow {
  readonly queueName: string;
  readonly pendingCount: number;
  readonly processingCount: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly deadCount: number;
  readonly oldestPendingSeconds: number | null;
  readonly lastSentAt: string | null;
}

/** Umbral de "pendiente más viejo" (horas) a partir del cual una cola entra
 *  en alerta -- una cola puede tener pendientes normales (el próximo drenado
 *  del cron todavía no corre); solo cuando el más viejo lleva más de esto
 *  esperando se vuelve una señal real de atasco. */
export const OLDEST_PENDING_ALERT_HOURS = 2;

export interface LicitacionesFuenteRunRow {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly source: string;
  readonly state: string;
  readonly finishedAt: string;
  readonly message: string;
}

export interface LlmPlatformBudgetSalud {
  readonly monthlyCapMicroUsd: number;
  readonly alertThresholdPct: number;
  readonly spendThisMonthMicroUsd: number;
}

export type SeveridadAlerta = "critica" | "alta" | "media";

export interface Alerta {
  readonly severidad: SeveridadAlerta;
  readonly titulo: string;
  readonly detalle: string;
  readonly href: string;
}

export interface CronConEstado {
  readonly cronName: string;
  readonly estado: EstadoCron;
  readonly heartbeat: CronHeartbeatRow | null;
}

/** Cada sección es `T[] | null` -- `null` significa "esta lectura falló",
 *  nunca "esta lectura devolvió cero filas" (eso es `[]`, y NO genera
 *  ninguna alerta de "no se pudo leer"). */
export interface CalcularAlertasInput {
  readonly crons: readonly CronConEstado[] | null;
  readonly colas: readonly OutboxQueueHealthRow[] | null;
  readonly licitacionesFuentes: readonly LicitacionesFuenteRunRow[] | null;
  readonly llmPlatformBudget: LlmPlatformBudgetSalud | null;
}

const HREF_CRONS = "/superadmin/salud/crons";
const HREF_COLAS = "/superadmin/salud/colas";
const HREF_LICITACIONES_FUENTES = "/superadmin/salud/licitaciones-fuentes";
const HREF_GASTO_API = "/superadmin/gasto-api";

function alertasCrons(crons: readonly CronConEstado[] | null): Alerta[] {
  if (crons === null) {
    return [{ severidad: "alta", titulo: "No se pudo leer el estado de los crons", detalle: "La lectura de core.cron_heartbeat falló -- no se puede confirmar si los crons corrieron.", href: HREF_CRONS }];
  }
  const alertas: Alerta[] = [];
  for (const cron of crons) {
    if (cron.estado === "vencido") {
      alertas.push({
        severidad: "alta",
        titulo: `Cron vencido: ${cron.cronName}`,
        detalle: "No hay un latido nuevo dentro de su cadencia esperada más 20 minutos de tolerancia.",
        href: HREF_CRONS,
      });
    } else if (cron.estado === "error") {
      alertas.push({
        severidad: "critica",
        titulo: `Cron con error: ${cron.cronName}`,
        detalle: cron.heartbeat?.lastError ?? "La última corrida registrada terminó en error.",
        href: HREF_CRONS,
      });
    }
    if (cron.heartbeat && cron.heartbeat.consecutiveFailures >= UMBRAL_FALLOS_CONSECUTIVOS) {
      alertas.push({
        severidad: "critica",
        titulo: `Cron con ${cron.heartbeat.consecutiveFailures} fallos consecutivos: ${cron.cronName}`,
        detalle: cron.heartbeat.lastError ?? "Varias corridas seguidas terminaron en error.",
        href: HREF_CRONS,
      });
    }
  }
  return alertas;
}

function alertasColas(colas: readonly OutboxQueueHealthRow[] | null): Alerta[] {
  if (colas === null) {
    return [{ severidad: "alta", titulo: "No se pudo leer la salud de las colas de mensajería", detalle: "La lectura agregada de outbox (core.get_outbox_health_for_superadmin) falló.", href: HREF_COLAS }];
  }
  const alertas: Alerta[] = [];
  for (const cola of colas) {
    if (cola.deadCount > 0) {
      alertas.push({
        severidad: "critica",
        titulo: `Cola ${cola.queueName}: ${cola.deadCount} mensaje(s) muerto(s)`,
        detalle: "Requieren revisión manual -- una cola no reintenta un mensaje 'dead' por sí sola.",
        href: HREF_COLAS,
      });
    }
    if (cola.oldestPendingSeconds !== null && cola.oldestPendingSeconds > OLDEST_PENDING_ALERT_HOURS * 3600) {
      const horas = (cola.oldestPendingSeconds / 3600).toFixed(1);
      alertas.push({
        severidad: "alta",
        titulo: `Cola ${cola.queueName}: el pendiente más viejo lleva ${horas} h esperando`,
        detalle: `Supera el umbral de ${OLDEST_PENDING_ALERT_HOURS} h -- el drenado (cron o disparo inline) no está alcanzando este mensaje.`,
        href: HREF_COLAS,
      });
    }
  }
  return alertas;
}

/** Estados de `licitaciones.source_run` que NO son una alerta: `ok` (sano) y
 *  `not_configured` (fuente registrada en el connector-registry pero sin
 *  credenciales/acceso -- una decisión de producto conocida, no una falla
 *  operativa nueva, ver `packages/domain-licitaciones/src/connector-registry.ts`). */
const ESTADOS_FUENTE_SIN_ALERTA = new Set(["ok", "not_configured"]);

function alertasLicitacionesFuentes(fuentes: readonly LicitacionesFuenteRunRow[] | null): Alerta[] {
  if (fuentes === null) {
    return [{ severidad: "alta", titulo: "No se pudo leer el estado de las fuentes de licitaciones", detalle: "La lectura de licitaciones.source_run falló.", href: HREF_LICITACIONES_FUENTES }];
  }
  const alertas: Alerta[] = [];
  for (const fuente of fuentes) {
    if (!ESTADOS_FUENTE_SIN_ALERTA.has(fuente.state)) {
      alertas.push({
        severidad: "media",
        titulo: `Fuente de licitaciones "${fuente.source}" (${fuente.organizationName}): ${fuente.state}`,
        detalle: fuente.message,
        href: HREF_LICITACIONES_FUENTES,
      });
    }
  }
  return alertas;
}

function alertasGastoLlm(budget: LlmPlatformBudgetSalud | null): Alerta[] {
  if (budget === null) {
    return [{ severidad: "alta", titulo: "No se pudo leer el gasto de API de LLM", detalle: "La lectura del tope de plataforma (core.get_llm_platform_budget_for_superadmin) falló.", href: HREF_GASTO_API }];
  }
  if (budget.monthlyCapMicroUsd <= 0) return [];
  const pct = (budget.spendThisMonthMicroUsd / budget.monthlyCapMicroUsd) * 100;
  if (pct < budget.alertThresholdPct) return [];
  return [
    {
      severidad: pct >= 100 ? "critica" : "alta",
      titulo: `Gasto de API de LLM al ${pct.toFixed(1)}% del tope de plataforma este mes`,
      detalle: `${(budget.spendThisMonthMicroUsd / 1_000_000).toFixed(2)} de ${(budget.monthlyCapMicroUsd / 1_000_000).toFixed(2)} USD.`,
      href: HREF_GASTO_API,
    },
  ];
}

/** Junta las 4 secciones en una sola lista de alertas accionables, cada una
 *  clasificada de forma DETERMINISTA (nunca un LLM opinando). Orden: crons,
 *  colas, fuentes de licitaciones, gasto de LLM -- mismo orden que las
 *  tablas de la pantalla `/superadmin/salud`. */
export function calcularAlertas(input: CalcularAlertasInput): Alerta[] {
  return [...alertasCrons(input.crons), ...alertasColas(input.colas), ...alertasLicitacionesFuentes(input.licitacionesFuentes), ...alertasGastoLlm(input.llmPlatformBudget)];
}
