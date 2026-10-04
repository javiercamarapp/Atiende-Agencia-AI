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

export interface EventoToolWhatsApp {
  readonly evento: "whatsapp_tool";
  readonly correlationId: string;
  readonly organizationId: string;
  readonly propertyId: string | null;
  readonly tool: string;
  readonly vuelta: number;
  readonly latenciaMs: number;
  readonly resultado: ResultadoTool;
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
  readonly tools: ReadonlyArray<{ readonly tool: string; readonly latenciaMs: number; readonly resultado: ResultadoTool }>;
  readonly resultado: ResultadoTurno;
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
