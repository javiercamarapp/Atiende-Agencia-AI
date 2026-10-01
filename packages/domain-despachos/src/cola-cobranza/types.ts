// D-11 -- cola de cobranza. Tipos del modulo (gestiones por factura/cliente, consentimiento de WhatsApp y
// outbox). Los montos de una promesa de pago son CENTAVOS enteros MXN; las fechas, "YYYY-MM-DD" de negocio
// (zona America/Mexico_City salvo configuracion de la property).
export const GESTION_TIPOS = ["promesa_pago", "recordatorio", "llamada", "nota"] as const;
export type GestionTipo = (typeof GESTION_TIPOS)[number];

export const GESTION_ESTADOS = ["pendiente", "cumplida", "incumplida", "cancelada"] as const;
export type GestionEstado = (typeof GESTION_ESTADOS)[number];

/** Estados a los que se puede RESOLVER una gestion pendiente. */
export const GESTION_ESTADOS_RESOLUCION = ["cumplida", "incumplida", "cancelada"] as const;
export type GestionEstadoResolucion = (typeof GESTION_ESTADOS_RESOLUCION)[number];

export interface GestionCobranza {
  readonly id: string;
  readonly receivableId: string;
  readonly tipo: GestionTipo;
  readonly estado: GestionEstado;
  readonly montoPromesaCentavos: number | null;
  readonly fechaPromesa: string | null;
  readonly fechaSeguimiento: string | null;
  readonly nota: string | null;
  readonly creadoEn: string;
  readonly actualizadoEn: string;
}

export interface NuevaGestionInput {
  readonly propertyId: string;
  readonly receivableId: string;
  readonly tipo: GestionTipo;
  readonly nota: string | null;
  readonly montoPromesaCentavos: number | null;
  readonly fechaPromesa: string | null;
  readonly fechaSeguimiento: string | null;
}

export interface FiltroGestiones {
  readonly receivableId?: string;
  readonly estado?: GestionEstado;
}

export type ConsentimientoWhatsAppEstado = "opt_in" | "opt_out";

export interface ConsentimientoWhatsApp {
  readonly rfcReceptor: string;
  readonly telefono: string;
  readonly estado: ConsentimientoWhatsAppEstado;
  readonly evidencia: string | null;
  readonly actualizadoEn: string;
}

export interface FijarConsentimientoInput {
  readonly propertyId: string;
  readonly rfcReceptor: string;
  readonly telefono: string;
  readonly estado: ConsentimientoWhatsAppEstado;
  readonly evidencia: string | null;
}

export type OutboxWhatsAppEstado = "pendiente" | "cancelado" | "enviado" | "fallido";

/** Mensaje en la cola. No incluye el telefono (el staff no lo recibe por esta tabla). */
export interface MensajeOutboxWhatsApp {
  readonly id: string;
  readonly receivableId: string;
  readonly rfcReceptor: string;
  readonly cuerpo: string;
  readonly estado: OutboxWhatsAppEstado;
  readonly creadoEn: string;
}

export interface EncolarWhatsAppInput {
  readonly propertyId: string;
  readonly receivableId: string;
  readonly cuerpo: string;
  readonly dedupeKey: string;
}

/** `disponible: false` = la migracion 017 aun no esta aplicada en esta base (lista vacia honesta, nunca un 500). */
export type ColaDisponible<T> = { readonly disponible: true; readonly valor: T } | { readonly disponible: false };

export class ColaEntradaInvalidaError extends Error {
  constructor(message = "La solicitud no es valida.") {
    super(message);
    this.name = "ColaEntradaInvalidaError";
  }
}
export class ColaNoEncontradaError extends Error {
  constructor(message = "No encontrado.") {
    super(message);
    this.name = "ColaNoEncontradaError";
  }
}
export class ColaSinAccesoError extends Error {
  constructor() {
    super("Sin acceso.");
    this.name = "ColaSinAccesoError";
  }
}
export class ColaCuotaExcedidaError extends Error {
  constructor(message = "Se alcanzo el limite permitido.") {
    super(message);
    this.name = "ColaCuotaExcedidaError";
  }
}
export class ColaEstadoInvalidoError extends Error {
  constructor(message = "La gestion ya estaba resuelta.") {
    super(message);
    this.name = "ColaEstadoInvalidoError";
  }
}
export class ColaSinConsentimientoError extends Error {
  constructor() {
    super("El cliente no tiene consentimiento opt-in vigente para WhatsApp.");
    this.name = "ColaSinConsentimientoError";
  }
}

export interface ColaCobranzaRepository {
  listarGestiones(propertyId: string, filtro?: FiltroGestiones): Promise<ColaDisponible<readonly GestionCobranza[]>>;
  crearGestion(input: NuevaGestionInput): Promise<ColaDisponible<{ readonly id: string }>>;
  resolverGestion(propertyId: string, gestionId: string, estado: GestionEstadoResolucion, nota: string | null): Promise<ColaDisponible<true>>;
  listarConsentimientos(propertyId: string): Promise<ColaDisponible<readonly ConsentimientoWhatsApp[]>>;
  fijarConsentimiento(input: FijarConsentimientoInput): Promise<ColaDisponible<true>>;
  encolarWhatsApp(input: EncolarWhatsAppInput): Promise<ColaDisponible<{ readonly id: string; readonly duplicado: boolean }>>;
  listarOutbox(propertyId: string): Promise<ColaDisponible<readonly MensajeOutboxWhatsApp[]>>;
}
