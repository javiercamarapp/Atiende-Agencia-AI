// H-06 -- tipos, roles y errores de dominio de GRUPOS (cotizacion con vigencia, bloqueo de cuartos con fecha de
// liberacion, pickup, rooming list, anticipos registrados). La autoridad es la base (migracion 036: RLS + funciones
// security definer): estos tipos describen lo que ella devuelve. Dinero SIEMPRE en centavos enteros MXN.

export const QUOTE_STATUSES = ["borrador", "enviada", "aceptada", "rechazada", "vencida", "cancelada"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const BLOCK_STATUSES = ["activo", "liberado", "cancelado"] as const;
export type BlockStatus = (typeof BLOCK_STATUSES)[number];

export const RELEASE_KINDS = ["cutoff", "manual", "cancelacion"] as const;
export type ReleaseKind = (typeof RELEASE_KINDS)[number];

export const ROOMING_STATUSES = ["pendiente", "confirmada", "cancelada"] as const;
export type RoomingStatus = (typeof ROOMING_STATUSES)[number];

/** Espejo de los helpers SQL `can_view_groups` / `can_manage_groups` (la base es la autoridad final). */
export const GRUPOS_VIEW_ROLES = ["owner", "gm", "frontdesk", "reservations", "accountant"] as const;
export const GRUPOS_MANAGE_ROLES = ["owner", "gm", "reservations"] as const;
/** Rooming list: ademas de gestion, recepcion confirma pickup de sus huespedes. */
export const GRUPOS_ROOMING_ROLES = ["owner", "gm", "reservations", "frontdesk"] as const;
export const GRUPOS_DEPOSIT_ROLES = ["owner", "gm", "accountant"] as const;
/** Descuento por encima del tope vigente: solo owner/gm. */
export const GRUPOS_DISCOUNT_OVERRIDE_ROLES = ["owner", "gm"] as const;

export const MAX_GROUP_NIGHTS = 60;
export const MAX_QUOTE_LINES = 50;
export const MAX_ROOMS_PER_LINE = 1000;
/** Tarifa maxima por cuarto-noche: 1,000,000.00 MXN en centavos. */
export const MAX_RATE_CENTS = 100_000_000;
/** Tope de descuento por defecto cuando la property no configuro guardrails (espejo de agent_guardrail, 035). */
export const DEFAULT_GROUP_MAX_DISCOUNT_PCT = 30;

export interface GrupoActor {
  readonly userId: string | null;
  readonly role: string | null;
}

export interface QuoteLineInput {
  readonly roomTypeId: string;
  readonly rooms: number;
  /** Tarifa por cuarto-noche en centavos ENTEROS MXN. */
  readonly rateCents: number;
}

export interface QuoteLineRecord extends QuoteLineInput {
  readonly id: string;
}

export interface NewQuoteInput {
  readonly propertyId: string;
  readonly groupName: string;
  readonly contactName?: string | null;
  readonly contactEmail?: string | null;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly cutoffDate: string;
  /** ISO 8601 con zona: hasta cuando es valida la propuesta. */
  readonly validUntil: string;
  readonly discountBps: number;
  readonly depositRequiredCents: number;
  readonly lines: readonly QuoteLineInput[];
}

export interface QuoteRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly groupName: string;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly nights: number;
  readonly cutoffDate: string;
  readonly validUntil: string;
  readonly discountBps: number;
  readonly grossCents: number;
  readonly totalCents: number;
  readonly depositRequiredCents: number;
  readonly depositRecordedCents: number;
  readonly status: QuoteStatus;
  readonly sentAt: string | null;
  readonly acceptedAt: string | null;
  readonly closedReason: string | null;
  readonly createdAt: string;
}

export interface DepositRecord {
  readonly id: string;
  readonly amountCents: number;
  readonly reference: string;
  readonly recordedBy: string | null;
  readonly recordedAt: string;
}

export interface QuoteDetail extends QuoteRecord {
  readonly lines: readonly QuoteLineRecord[];
  readonly deposits: readonly DepositRecord[];
  /** Bloqueo creado al aceptar (null mientras no se acepte). */
  readonly blockId: string | null;
}

export interface QuoteListResult {
  /** false = la base aun no tiene la migracion 036 (lista vacia honesta, no un error). */
  readonly disponible: boolean;
  readonly cotizaciones: readonly QuoteRecord[];
}

export interface BlockNightRecord {
  readonly roomTypeId: string;
  readonly date: string;
  readonly blockedRooms: number;
  readonly pickedUpRooms: number;
  readonly releasedRooms: number;
}

export interface PickupSummary {
  readonly blockedRoomNights: number;
  readonly pickedUpRoomNights: number;
  readonly releasedRoomNights: number;
  /** Cuartos-noche aun retenidos y sin confirmar (blocked - picked - released). */
  readonly pendingRoomNights: number;
  /** Cuartos-noche retenidos hoy en el inventario (blocked - released). */
  readonly heldRoomNights: number;
  /** picked / blocked en porcentaje con un decimal (0 si no hay bloqueo). */
  readonly pickupPct: number;
}

export interface BlockRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly quoteId: string;
  readonly groupName: string;
  readonly status: BlockStatus;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly cutoffDate: string;
  readonly releasedAt: string | null;
  readonly releaseKind: ReleaseKind | null;
  readonly createdAt: string;
  readonly pickup: PickupSummary;
}

export interface RoomingEntryRecord {
  readonly id: string;
  readonly blockId: string;
  readonly roomTypeId: string;
  readonly guestName: string;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly status: RoomingStatus;
  readonly reservationId: string | null;
  readonly confirmedAt: string | null;
  readonly createdAt: string;
}

export interface BlockDetail extends BlockRecord {
  readonly nights: readonly BlockNightRecord[];
  readonly rooming: readonly RoomingEntryRecord[];
}

export interface BlockListResult {
  readonly disponible: boolean;
  readonly bloqueos: readonly BlockRecord[];
}

export interface NewRoomingEntryInput {
  readonly roomTypeId: string;
  readonly guestName: string;
  readonly checkInDate: string;
  readonly checkOutDate: string;
}

export interface ReleasedBlock {
  readonly blockId: string;
  readonly releasedRoomNights: number;
}

export class GruposNotFoundError extends Error {
  constructor(what = "Recurso") {
    super(`${what} no encontrado, o sin permiso para verlo.`);
    this.name = "GruposNotFoundError";
  }
}
export class GruposConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GruposConflictError";
  }
}
export class GruposInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GruposInvalidInputError";
  }
}
export class GruposAccessDeniedError extends Error {
  constructor(message = "No tienes permiso para esta operacion.") {
    super(message);
    this.name = "GruposAccessDeniedError";
  }
}
/** La base aun no tiene la migracion 036: las escrituras responden 503 honesto. */
export class GruposUnavailableError extends Error {
  constructor(public readonly operation: string) {
    super(`Grupos: la migracion 036 aun no esta aplicada (${operation}).`);
    this.name = "GruposUnavailableError";
  }
}
