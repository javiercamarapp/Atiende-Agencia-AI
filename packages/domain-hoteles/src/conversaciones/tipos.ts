// H-20 -- bandeja de conversaciones de WhatsApp con handoff a humano. Tipos y reglas puras, sin I/O.
// Misma forma que restaurantes (bandeja / detalle / tomar / devolver / cerrar / notas / responder) pero LOCAL a hoteles: en
// hoteles la conversacion es una por (property, telefono) y el estado vive en la misma fila (migracion 043). PL-14 (plataforma)
// podra absorberlo.
import type { HotelRole } from "../roles.ts";

export const CONVERSACION_MODOS = ["agente", "humano", "cerrada"] as const;
export type ConversacionModo = (typeof CONVERSACION_MODOS)[number];
/** Filtro de la bandeja: un modo, o `por_atender` (en humano y sin responsable: nadie la ha tomado). */
export const CONVERSACION_FILTROS = [...CONVERSACION_MODOS, "por_atender"] as const;
export type ConversacionFiltro = (typeof CONVERSACION_FILTROS)[number];

/** Quienes ven y atienden conversaciones (los mismos que gestionan reservas). */
export const CONVERSACIONES_ROLES: readonly HotelRole[] = ["owner", "gm", "frontdesk", "reservations"];
/** Quienes ven el telefono completo; el resto lo ve enmascarado. */
export const CONVERSACIONES_PII_ROLES: readonly HotelRole[] = ["owner", "gm"];

export const CONVERSACION_TEXTO_MAX = 1000;

/** Estado de envio de una respuesta humana (derivado de `messaging_outbox.status`). */
export type EstadoEnvio = "pendiente_envio" | "enviando" | "enviado" | "fallido";

export function estadoEnvioDeOutbox(status: string | null | undefined): EstadoEnvio | null {
  switch (status) {
    case "pending":
      return "pendiente_envio";
    case "processing":
      return "enviando";
    case "sent":
      return "enviado";
    case "failed":
    case "dead":
      return "fallido";
    default:
      return null;
  }
}

export interface ConversacionActor {
  readonly userId: string;
  readonly role: HotelRole;
}

export interface ConversacionItem {
  readonly id: string;
  readonly telefono: string;
  readonly modo: ConversacionModo;
  readonly responsableId: string | null;
  readonly responsableNombre: string | null;
  readonly tomadaEn: string | null;
  readonly motivo: string | null;
  readonly handoffEn: string | null;
  readonly noLeidos: number;
  readonly ultimoEntranteEn: string | null;
  readonly actividadEn: string;
  readonly vistaPrevia: string | null;
  readonly ultimoRol: "user" | "assistant" | null;
  readonly huespedId: string | null;
  readonly huespedNombre: string | null;
}

export interface ConversacionMensaje {
  readonly rol: "user" | "assistant";
  /** huesped | agente | personal (respuesta humana desde la bandeja). */
  readonly origen: "huesped" | "agente" | "personal";
  readonly texto: string;
  readonly creadoEn: string | null;
  readonly autorId: string | null;
  /** Solo las respuestas humanas llevan estado de envio. */
  readonly envio: EstadoEnvio | null;
}

export interface ConversacionNota {
  readonly id: string;
  readonly autorId: string | null;
  readonly autorNombre: string | null;
  readonly texto: string;
  readonly creadaEn: string;
}

export interface ConversacionDetalle extends ConversacionItem {
  readonly propertyId: string;
  readonly handoffN: number;
  readonly cerradaEn: string | null;
  readonly totalMensajes: number;
  readonly mensajes: readonly ConversacionMensaje[];
  readonly notas: readonly ConversacionNota[];
}

export interface ConversacionBandeja {
  /** `false` si la migracion 043 aun no esta aplicada: lista vacia honesta, no "sin conversaciones". */
  readonly disponible: boolean;
  readonly total: number;
  readonly items: readonly ConversacionItem[];
}

export interface ConversacionesFiltro {
  readonly modo: ConversacionFiltro | null;
  readonly soloNoLeidas: boolean;
  /** Ultimos digitos del telefono del huesped (7 a 10) para enlazar desde la ficha. */
  readonly telefonoClave: string | null;
  readonly limit: number;
  readonly offset: number;
}

export interface TomarResultado {
  readonly modo: ConversacionModo;
  readonly responsableId: string | null;
  readonly tomadaEn: string | null;
}

export interface ResponderResultado {
  readonly outboxId: string;
  readonly envio: EstadoEnvio;
}

export type ConversacionConflictoCodigo =
  | "ya_tomada"
  | "cerrada"
  | "ya_cerrada"
  | "no_en_humano"
  | "no_eres_responsable"
  | "ventana_24h"
  | "canal_no_configurado";

export class ConversacionesNoDisponibleError extends Error {
  constructor(readonly operacion: string) {
    super("Las conversaciones con handoff todavía no están disponibles en esta base de datos (falta aplicar la migración 043).");
    this.name = "ConversacionesNoDisponibleError";
  }
}
export class ConversacionesNoEncontradaError extends Error {
  constructor() {
    super("Conversación no encontrada.");
    this.name = "ConversacionesNoEncontradaError";
  }
}
export class ConversacionesRechazadaError extends Error {
  constructor(message = "No tienes permiso para esta acción sobre la conversación.") {
    super(message);
    this.name = "ConversacionesRechazadaError";
  }
}
export class ConversacionesValidacionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversacionesValidacionError";
  }
}
export class ConversacionesConflictoError extends Error {
  constructor(
    readonly codigo: ConversacionConflictoCodigo,
    message: string,
  ) {
    super(message);
    this.name = "ConversacionesConflictoError";
  }
}

export const CONFLICTO_MENSAJES: Readonly<Record<ConversacionConflictoCodigo, string>> = {
  ya_tomada: "Otra persona ya tomó esta conversación.",
  cerrada: "La conversación está cerrada; se reabre cuando el huésped vuelva a escribir.",
  ya_cerrada: "La conversación ya está cerrada.",
  no_en_humano: "La conversación no está en atención humana: tómala antes de continuar.",
  no_eres_responsable: "Solo la persona que tomó la conversación puede responder.",
  ventana_24h: "Pasaron más de 24 horas desde el último mensaje del huésped: WhatsApp solo permite responder con una plantilla aprobada.",
  canal_no_configurado: "La propiedad no tiene un número de WhatsApp habilitado: configúralo en Mensajería.",
};

/** Mismo criterio que las notas del huesped (038): 13 a 19 digitos seguidos (con espacios o guiones) = tarjeta o documento. */
export function textoTieneDatoSensible(texto: string): boolean {
  return /[0-9]{13,19}/.test(texto.replace(/[ -]/g, ""));
}

/** Valida un texto libre (nota o respuesta): recortado, 1 a 1000 caracteres y sin datos sensibles. Lanza validacion. */
export function validarTextoConversacion(raw: unknown, campo: string): string {
  if (typeof raw !== "string") throw new ConversacionesValidacionError(`${campo}: texto de 1 a ${CONVERSACION_TEXTO_MAX} caracteres.`);
  const t = raw.trim();
  if (t.length < 1 || t.length > CONVERSACION_TEXTO_MAX) throw new ConversacionesValidacionError(`${campo}: texto de 1 a ${CONVERSACION_TEXTO_MAX} caracteres.`);
  if (textoTieneDatoSensible(t)) throw new ConversacionesValidacionError(`${campo}: no incluyas números de tarjeta ni de documento.`);
  return t;
}

/** Ultimos 10 digitos del telefono, o null si no hay al menos 7: clave para enlazar huesped y conversacion. */
export function claveTelefonoConversacion(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : null;
}

/** Telefono enmascarado para roles sin acceso a PII completa: solo los ultimos 4 digitos. */
export function enmascararTelefono(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length <= 4 ? "••••" : `••••${digits.slice(-4)}`;
}

/** Minimizacion para roles sin PII completa: correos y secuencias de 7+ digitos (telefonos, documentos) se ocultan del texto. */
export function minimizarTextoPii(texto: string): string {
  return texto
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[correo]")
    // Una sola clase de caracteres con cuantificador simple (tiempo lineal, sin grupos repetidos): la corrida se oculta solo si
    // lleva 7 o mas digitos; los espacios de los extremos se conservan.
    .replace(/[\d\s().+-]{7,}/g, (m) => (m.replace(/\D/g, "").length >= 7 ? `${/^\s/.test(m) ? " " : ""}[número]${/\s$/.test(m) ? " " : ""}` : m));
}

/** Motivo de derivacion (codigo corto, sin PII) -> texto para la UI. */
export function motivoHandoffTexto(motivo: string | null): string | null {
  switch (motivo) {
    case null:
      return null;
    case "agente_derivo":
      return "El agente pidió que lo atienda una persona";
    case "agente_pausado":
      return "El agente está pausado";
    case "agente_presupuesto_agotado":
      return "El agente agotó su presupuesto del mes";
    case "tomada_por_personal":
      return "Tomada por el personal";
    default:
      return "Derivada a una persona";
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Puerto de SISTEMA (webhook de WhatsApp): sesion sin usuario. Nunca lanza por "base sin migrar": degrada a `null`.
// ---------------------------------------------------------------------------------------------------------------------
export interface DerivacionResultado {
  readonly conversationId: string;
  readonly organizationId: string;
  readonly handoffN: number;
  /** true solo en la derivacion que cambio el estado (la que notifica). */
  readonly transicion: boolean;
}

export interface ConversacionesSistemaPort {
  /** Registra el mensaje entrante ya guardado. Devuelve el modo resultante, o null si la conversacion no existe o la base no tiene la 043. */
  registrarEntrante(propertyId: string, phone: string): Promise<ConversacionModo | null>;
  /** Deriva a una persona (agente la pidio, pausado o sin presupuesto). Best-effort: nunca lanza; null = no se pudo (base sin migrar). */
  derivarAHumano(propertyId: string, phone: string, motivo: string): Promise<DerivacionResultado | null>;
}

export const HANDOFF_MOTIVO_RE = /^[a-z0-9_]{1,80}$/;
