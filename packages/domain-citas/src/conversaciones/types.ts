// C-11 -- tipos de la bandeja de conversaciones de WhatsApp de citas con handoff a humano (migracion 031).
// PL-14 (handoff generico en core-conversation) sigue pendiente: cuando exista, estos tipos y el puerto migran ahi y
// este modulo queda como envoltorio fino (mismo criterio que domain-restaurantes/src/conversaciones).

/** `agente` = sin toma abierta ni historica (la atiende el agente). Los demas son los estados de `citas.conversation_handoff`. */
export type HandoffEstado = "agente" | "pendiente" | "tomada" | "devuelta" | "cerrada";
export const HANDOFF_ESTADOS: readonly HandoffEstado[] = ["agente", "pendiente", "tomada", "devuelta", "cerrada"];

/** Lectura con estado honesto: `disponible: false` = la base todavia no tiene la migracion 031 (nunca se confunde con "no hay datos"). */
export interface ConversacionesLectura<T> {
  readonly disponible: boolean;
  readonly valor: T;
}

export interface BandejaItem {
  readonly conversationId: string;
  /** Sucursal en la que se consulta la bandeja (una conversacion sin sucursal aparece en todas). */
  readonly propertyId: string;
  /** Telefono del cliente en claro: la capa HTTP lo enmascara antes de salir hacia el panel. */
  readonly telefono: string;
  readonly vistaPrevia: string;
  readonly actividadAt: string;
  readonly estado: HandoffEstado;
  readonly handoffId: string | null;
  readonly motivo: string | null;
  /** Hay una escalacion de crisis sin resolver de este telefono, o la toma nacio de una. */
  readonly crisis: boolean;
  readonly solicitadaAt: string | null;
  readonly ultimoClienteAt: string | null;
  readonly tomadaPor: string | null;
  readonly tomadaPorNombre: string | null;
  readonly tomadaAt: string | null;
  readonly citaId: string | null;
  readonly citaInicio: string | null;
  readonly citaEstado: string | null;
}

export interface BandejaFiltro {
  readonly estado?: HandoffEstado | null;
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
  readonly crisis: boolean;
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
  readonly rol: "cliente" | "agente" | "humano";
  readonly texto: string;
}

export interface ConversacionDetalle {
  readonly conversationId: string;
  readonly telefono: string;
  readonly mensajes: readonly MensajeConversacion[];
  readonly citaId: string | null;
  readonly handoff: HandoffDetalle | null;
  readonly notas: readonly NotaInterna[];
}

/** Tope de una nota interna y de una respuesta humana (mismos que los CHECK / validaciones de la base). */
export const NOTA_MAX = 2000;
export const RESPUESTA_MAX = 1000;

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
  constructor(message = "La conversación cambió de estado mientras la editabas. Recarga e intenta de nuevo.") {
    super(message);
    this.name = "ConversacionesConflictoError";
  }
}
export class SinNumeroWhatsappError extends Error {
  constructor() {
    super("El negocio no tiene un número de WhatsApp activo para responder.");
    this.name = "SinNumeroWhatsappError";
  }
}
export class ConversacionesValidacionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversacionesValidacionError";
  }
}
