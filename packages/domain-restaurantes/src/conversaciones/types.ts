// Tipos de la bandeja de conversaciones + handoff a humano + turnos por sucursal (migracion 028).
export type ConversacionCanal = "whatsapp" | "voz";
export const CONVERSACION_CANALES: readonly ConversacionCanal[] = ["whatsapp", "voz"];

/** `agente` = sin toma abierta ni historica (la atiende el agente). Los demas son los estados de
 * `restaurantes.conversation_handoff`. */
export type HandoffEstado = "agente" | "pendiente" | "tomada" | "devuelta" | "cerrada";
export const HANDOFF_ESTADOS: readonly HandoffEstado[] = ["agente", "pendiente", "tomada", "devuelta", "cerrada"];

/** Lectura con estado honesto: `disponible: false` = la base todavia no tiene la migracion 028
 * (nunca se confunde con "no hay datos"). */
export interface ConversacionesLectura<T> {
  readonly disponible: boolean;
  readonly valor: T;
}

export interface BandejaItem {
  readonly canal: ConversacionCanal;
  readonly conversationId: string;
  readonly propertyId: string;
  /** Solo WhatsApp (en voz el telefono nunca se guarda en claro). */
  readonly telefono: string | null;
  readonly vistaPrevia: string;
  readonly actividadAt: string;
  readonly estado: HandoffEstado;
  readonly handoffId: string | null;
  readonly motivo: string | null;
  readonly solicitadaAt: string | null;
  readonly ultimoClienteAt: string | null;
  readonly tomadaPor: string | null;
  readonly tomadaPorNombre: string | null;
  readonly tomadaAt: string | null;
  readonly resultadoVoz: string | null;
}

export interface BandejaFiltro {
  readonly estado?: HandoffEstado | null;
  readonly canal?: ConversacionCanal | null;
  readonly limit?: number;
  readonly offset?: number;
}

export interface BandejaPagina {
  readonly items: readonly BandejaItem[];
  readonly total: number;
}

export interface HandoffDetalle {
  readonly handoffId: string;
  readonly estado: Exclude<HandoffEstado, "agente">;
  readonly solicitadoPor: "agente" | "staff";
  readonly motivo: string | null;
  readonly solicitadaAt: string;
  readonly ultimoClienteAt: string | null;
  readonly tomadaPor: string | null;
  readonly tomadaPorNombre: string | null;
  readonly tomadaAt: string | null;
}

export interface NotaInterna {
  readonly id: string;
  readonly autorId: string | null;
  readonly autorNombre: string | null;
  readonly texto: string;
  readonly createdAt: string;
}

export interface MensajeConversacion {
  readonly rol: "cliente" | "agente" | "humano" | "herramienta";
  readonly texto: string;
  readonly createdAt: string | null;
}

export interface ConversacionDetalle {
  readonly canal: ConversacionCanal;
  readonly conversationId: string;
  readonly mensajes: readonly MensajeConversacion[];
  /** En voz, la transcripcion solo la leen owner/admin o el staff que tomo la llamada. */
  readonly transcripcionDisponible: boolean;
  readonly handoff: HandoffDetalle | null;
  readonly notas: readonly NotaInterna[];
}

// ---- Turnos de personal por sucursal ----
export interface TurnoMiembro {
  readonly userId: string;
  readonly nombre: string | null;
  /** 1 = principal; 2.. = respaldo. */
  readonly orden: number;
}

export interface TurnoPersonal {
  readonly id: string;
  readonly nombre: string;
  /** 0 = domingo .. 6 = sabado: dia en que el turno EMPIEZA. */
  readonly dias: readonly number[];
  readonly inicia: string;
  /** `termina <= inicia` = cruza la medianoche. */
  readonly termina: string;
  readonly miembros: readonly TurnoMiembro[];
}

export interface TurnoEntrada {
  readonly nombre: string;
  readonly dias: readonly number[];
  readonly inicia: string;
  readonly termina: string;
  readonly miembros: readonly { readonly userId: string; readonly orden: number }[];
}

// ---- Callbacks ----
export type CallbackResultado = "contactado" | "no_contesto" | "buzon" | "numero_invalido" | "reprogramar";
export const CALLBACK_RESULTADOS: readonly CallbackResultado[] = ["contactado", "no_contesto", "buzon", "numero_invalido", "reprogramar"];

export interface CallbackIntento {
  readonly id: string;
  readonly resultado: CallbackResultado;
  readonly nota: string | null;
  readonly proximoIntentoAt: string | null;
  readonly autor: string | null;
  readonly creadoAt: string;
}

/** Estado de trabajo de un callback (migracion 033). Una base sin 033 solo distingue abierto/resuelto: ahi el estado se
 * deriva de `resolved` (nuevo | resuelto) y no hay asignacion. */
export const CALLBACK_ESTADOS = ["nuevo", "en_curso", "resuelto"] as const;
export type CallbackEstado = (typeof CALLBACK_ESTADOS)[number];
export const CALLBACK_ACCIONES = ["tomar", "asignar", "liberar", "resolver", "reabrir"] as const;
export type CallbackAccion = (typeof CALLBACK_ACCIONES)[number];

export interface CallbackItem {
  readonly id: string;
  readonly propertyId: string | null;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly reason: string | null;
  readonly message: string | null;
  readonly source: "voice" | "whatsapp" | "web" | "admin";
  readonly resolved: boolean;
  readonly createdAt: string;
  readonly intentos: readonly CallbackIntento[];
  /** Campos de la migracion 033; ausentes (undefined) en una base sin migrar. */
  readonly estado?: CallbackEstado;
  readonly asignadoA?: string | null;
  readonly asignadoNombre?: string | null;
  readonly asignadoAt?: string | null;
  readonly tomadoAt?: string | null;
  readonly resueltoAt?: string | null;
  readonly resueltoPorNombre?: string | null;
  readonly notaResolucion?: string | null;
}

export interface CallbackIntentoEntrada {
  readonly resultado: CallbackResultado;
  readonly nota: string | null;
  readonly proximoIntentoAt: string | null;
}

export const NOTA_MAX = 2000;
export const RESPUESTA_MAX = 1000;
export const TURNOS_MAX = 4;
export const MIEMBROS_POR_TURNO_MAX = 10;

// ---- Errores (las rutas los traducen a 503 / 403 / 409 / 400) ----
export class ConversacionesNoDisponibleError extends Error {
  constructor() {
    super("Las conversaciones con handoff a humano todavía no están disponibles en esta base de datos.");
    this.name = "ConversacionesNoDisponibleError";
  }
}
export class ConversacionesRechazadaError extends Error {
  constructor(message = "No tienes acceso a esta sucursal o conversación.") {
    super(message);
    this.name = "ConversacionesRechazadaError";
  }
}
export class HandoffYaTomadoError extends Error {
  constructor() {
    super("Esta conversación ya la tiene otra persona.");
    this.name = "HandoffYaTomadoError";
  }
}
export class ConversacionesConflictoError extends Error {
  constructor(message = "Ya existe un registro con esos datos (por ejemplo, un turno con el mismo nombre).") {
    super(message);
    this.name = "ConversacionesConflictoError";
  }
}
export class SinNumeroWhatsappError extends Error {
  constructor() {
    super("La sucursal no tiene un número de WhatsApp configurado para responder.");
    this.name = "SinNumeroWhatsappError";
  }
}
/** Pasaron mas de 24 h desde el ultimo mensaje del cliente: WhatsApp solo admite una plantilla aprobada, no texto libre. */
export const VENTANA_WHATSAPP_HORAS = 24;
export class VentanaWhatsappCerradaError extends Error {
  constructor() {
    super("Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp ya no permite una respuesta de texto libre. Contáctelo por llamada o espere a que vuelva a escribir.");
    this.name = "VentanaWhatsappCerradaError";
  }
}
export class ConversacionesValidacionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversacionesValidacionError";
  }
}
