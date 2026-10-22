// R-PM-15: observabilidad por turno de WhatsApp (equivalente a `_shared/observability.ts` del original
// atiende-restaurantes: un `correlation_id` por efecto y solo la CLASE del error, nunca el contenido).
//
// El dominio NO sabe a donde van los eventos (Vercel/stdout, un agregador): recibe un `emitir` inyectado
// y solo construye eventos planos y serializables. Reglas de privacidad que este modulo hace cumplir:
//   - Nunca el texto del cliente, ni el de la respuesta, ni los argumentos o resultados de las tools.
//   - El telefono solo como HMAC con llave del servidor (`hashTelefonoParaLogs`) o ausente (null).
//   - Un error de herramienta solo aporta su resultado clasificado (ok / error_regla / error_sistema).
//   - Emitir NUNCA lanza ni retrasa el turno: un sumidero roto no puede tumbar la respuesta al cliente.
import { createHmac } from "node:crypto";

export type ResultadoTool = "ok" | "error_regla" | "error_sistema";

/** Como termino el turno: respuesta normal, escalado fijo antes del LLM, proveedor caido, presupuesto o loop agotado. */
export type ResultadoTurno = "ok" | "escalado_alto_riesgo" | "error_proveedor" | "presupuesto_agotado" | "loop_agotado" | "error_sistema";

/**
 * PM-R14: por que termino mal un turno. LISTA CERRADA derivada de la clase de la excepcion, su codigo HTTP o el patron de su mensaje; el mensaje
 * crudo nunca se guarda (puede traer fragmentos de la peticion o del proveedor).
 *   tope_llamada        la llamada al modelo vencio su tope de tiempo por llamada (el modelo no contesto).
 *   tope_turno          el reloj del turno ya vencio antes de la siguiente vuelta.
 *   presupuesto_agotado tope de gasto (mensual, diario, por corrida) o de turnos del rol, o HTTP 402 del proveedor.
 *   proveedor_5xx       el proveedor contesto 5xx/429 o su circuito esta abierto.
 *   proveedor_timeout   el proveedor no contesto a tiempo (408, timeout del cliente HTTP).
 *   red                 red o conexion cortada (proveedor o base de datos local).
 *   regla               el servidor lo rechazo por regla (gate de residencia, interruptor de plataforma) o el loop se agoto por rechazos de herramienta.
 *   herramienta         una herramienta fallo con error del sistema.
 *   otro                cualquier otra cosa.
 */
export const CAUSAS_ERROR_TURNO = ["tope_llamada", "tope_turno", "presupuesto_agotado", "proveedor_5xx", "proveedor_timeout", "red", "regla", "herramienta", "otro"] as const;
export type CausaErrorTurno = (typeof CAUSAS_ERROR_TURNO)[number];

/** Error propio del tope por llamada al modelo (`completarConTope`): se reconoce por clase, no por texto. */
export class TopeLlamadaLlmError extends Error {
  constructor() {
    super("tope de tiempo de la llamada al LLM");
    this.name = "TopeLlamadaLlmError";
  }
}

const NOMBRES_PRESUPUESTO = new Set(["GatewayBudgetExceededError", "MonthlyBudgetExceededError", "LlmMonthlyBudgetExceededError", "RoleDailyTurnLimitExceededError"]);
const NOMBRES_REGLA = new Set(["ResidencyGateBlockedError", "KillSwitchEngagedError"]);
const PATRON_RED = /connection terminated|econn(?:reset|refused|aborted)|enotfound|eai_again|epipe|network error|fetch failed|socket hang up|other side closed/i;
// Acotado a lo que emite el cliente del proveedor: un `statement timeout` de Postgres u otro 'timeout' suelto NO es del proveedor.
const PATRON_TIMEOUT = /openrouter timeout|timed out|etimedout|operation was aborted/i;

function porEstado(status: number): CausaErrorTurno | null {
  if (status === 402) return "presupuesto_agotado";
  if (status === 408) return "proveedor_timeout";
  if (status === 429 || status >= 500) return "proveedor_5xx";
  return null;
}

function porTexto(texto: string): CausaErrorTurno | null {
  const http = /\bOpenRouter (\d{3})\b/.exec(texto);
  if (http) {
    const c = porEstado(Number(http[1]));
    if (c) return c;
  }
  if (PATRON_RED.test(texto)) return "red";
  if (PATRON_TIMEOUT.test(texto)) return "proveedor_timeout";
  return null;
}

/** Clasifica la excepcion que corto el turno. Solo devuelve un valor de la lista cerrada: nada del mensaje sale de aqui. */
export function clasificarCausaError(err: unknown): CausaErrorTurno {
  const nodos: unknown[] = [];
  for (let cur: unknown = err, i = 0; i < 6 && cur !== null && cur !== undefined; i++) {
    nodos.push(cur);
    cur = typeof cur === "object" ? (cur as { cause?: unknown }).cause : undefined;
  }
  const objetos = nodos.filter((n): n is Record<string, unknown> => typeof n === "object" && n !== null);
  const nombres = objetos.map((n) => (typeof n.name === "string" ? n.name : ""));
  if (nombres.includes("TopeLlamadaLlmError")) return "tope_llamada";
  if (nombres.some((n) => NOMBRES_PRESUPUESTO.has(n))) return "presupuesto_agotado";
  if (nombres.some((n) => NOMBRES_REGLA.has(n))) return "regla";
  if (nombres.includes("CircuitOpenError")) return "proveedor_5xx";
  for (const n of objetos) {
    if (typeof n.status === "number") {
      const c = porEstado(n.status);
      if (c) return c;
    }
  }
  const textos: string[] = [];
  // Escalera agotada: los intentos van PRIMERO y en orden inverso (el ultimo corto el turno); `message` concatena todos y por eso va despues.
  for (const n of objetos) {
    if (Array.isArray(n.attempts)) {
      for (const a of [...n.attempts].reverse()) if (a && typeof (a as { error?: unknown }).error === "string") textos.push((a as { error: string }).error);
    }
  }
  for (const n of objetos) {
    if (typeof n.message === "string") textos.push(n.message);
    if (typeof n.code === "string") textos.push(n.code);
  }
  for (const t of textos) {
    const c = porTexto(t);
    if (c) return c;
  }
  if (nombres.some((n) => n === "AbortError" || n === "TimeoutError")) return "proveedor_timeout";
  return "otro";
}

export interface EventoToolWhatsApp {
  readonly evento: "whatsapp_tool";
  readonly correlationId: string;
  readonly organizationId: string;
  readonly propertyId: string | null;
  readonly tool: string;
  readonly vuelta: number;
  readonly latenciaMs: number;
  readonly resultado: ResultadoTool;
  /** PM-R14: codigo de la regla del flujo del pedido que rechazo la herramienta (lista cerrada, p. ej. `resumen_no_mostrado`); null si no hubo. Nunca texto libre. */
  readonly codigoRegla?: string | null;
  readonly telefonoHash: string | null;
}

export interface EventoTurnoWhatsApp {
  readonly evento: "whatsapp_turno";
  readonly correlationId: string;
  readonly organizationId: string;
  readonly propertyId: string | null;
  /** Rol de modelo de la ultima llamada del turno (null si el turno no llego a llamar al modelo). */
  readonly rolModelo: string | null;
  /** Roles distintos usados en el turno, en orden (p. ej. ["default", "escalated"]). */
  readonly rolesUsados: readonly string[];
  /** Vueltas del loop de tool-use que llamaron al modelo. */
  readonly vueltas: number;
  readonly latenciaTotalMs: number;
  readonly tools: ReadonlyArray<{ readonly tool: string; readonly latenciaMs: number; readonly resultado: ResultadoTool; readonly codigoRegla?: string | null }>;
  readonly resultado: ResultadoTurno;
  /** PM-R14: por que termino mal el turno (lista cerrada, sin mensaje crudo); null si el turno termino bien o escalo por alto riesgo. */
  readonly causaError?: CausaErrorTurno | null;
  /** PM-R14: la maquina de estados del cierre (RESTAURANTES_CIERRE_MAQUINA_ESTADOS) estaba activa en ESTE turno. */
  readonly cierreMaquina?: boolean;
  /** PM-R14: el turno se corto porque el modelo insistia en crear_pedido rechazado por regla (resultado `ok`, causaError `regla`). */
  readonly cierreCortado?: boolean;
  /** PM-R19: veces que la llamada al modelo se repitio contra el modelo alterno tras agotar su tope por llamada (solo un entero; nunca contenido). */
  readonly reintentosLlm?: number;
  /** PM-R19: el respaldo contesto y el turno siguio con esa respuesta. */
  readonly reintentoLlmRecuperado?: boolean;
  /** PM-R19: id del modelo alterno usado (lista cerrada de la escalera aprobada, p.ej. "deepseek/deepseek-v4.1-flash"); null si no hubo respaldo. Sin PII. */
  readonly modeloRespaldoLlm?: string | null;
  /** PM-R19: modelo que realmente contesto la ultima llamada del turno (lista cerrada `MODELOS_AGENTE` o "otro"); null si ninguna contesto. Sin PII. */
  readonly modeloRespondioLlm?: string | null;
  /** Motivo de escalacion A HUMANO (clasificador de alto riesgo o `escalar_a_humano`); null si no hubo. */
  readonly motivoEscalacion: string | null;
  /** Por que se subio de rol de modelo barato a caro dentro del turno; null si no se subio. */
  readonly motivoEscaladaDeRol: "fallo_crear_pedido" | null;
  readonly telefonoHash: string | null;
}

export type EventoObservabilidadWhatsApp = EventoToolWhatsApp | EventoTurnoWhatsApp;

export interface ObservabilidadTurno {
  readonly emitir: (evento: EventoObservabilidadWhatsApp) => void;
  /** HMAC del telefono con la llave del servidor; si falta, los eventos van SIN telefono. */
  readonly hashTelefono?: (telefono: string) => string | null;
}

/** `tel_` + HMAC-SHA256 truncado a 16 hex del telefono (solo digitos y `+`) con una llave del servidor.
 * El prefijo evita que un hash de solo digitos lo confunda el scrub de logs con una tarjeta o un telefono.
 * Permite correlacionar los turnos de un mismo numero sin que el log revele el numero ni sea reversible
 * por tabla arcoiris sin la llave. Llave vacia => null (se omite el telefono, nunca se hashea sin llave). */
export function hashTelefonoParaLogs(telefono: string, llave: string): string | null {
  if (!llave) return null;
  const normalizado = telefono.replace(/[^\d+]/g, "");
  return `tel_${createHmac("sha256", llave).update(normalizado).digest("hex").slice(0, 16)}`;
}

/** Emite sin dejar escapar jamas una excepcion del sumidero. */
export function emitirSeguro(obs: ObservabilidadTurno | undefined, evento: EventoObservabilidadWhatsApp): void {
  if (!obs) return;
  try {
    obs.emitir(evento);
  } catch {
    // Observabilidad best-effort: el turno del cliente no depende de ella.
  }
}

export function telefonoHashSeguro(obs: ObservabilidadTurno | undefined, telefono: string): string | null {
  if (!obs?.hashTelefono) return null;
  try {
    return obs.hashTelefono(telefono);
  } catch {
    return null;
  }
}
