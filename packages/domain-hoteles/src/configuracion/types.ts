// H-P3-04 -- configuracion del hotel editable desde el panel (impuestos, politica de cancelacion, sobreventa y tarifas).
// Tipos y valores por omision. Las escrituras viven en `hoteles.set_*` (migrations/047), con bitacora.

/** Valores por omision cuando la property aun no tiene fila en `hoteles.tax_config` (el schema real los usa como DEFAULT de columna). */
export const TAX_CONFIG_DEFAULTS = { ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500, dsaPerNight: 0 } as const;

/** Valores por omision de `hoteles.cancellation_policy` (DEFAULT de columna de migrations/005). */
export const CANCELLATION_POLICY_DEFAULTS = { freeUntilHours: 24, penaltyPct: 0.5, guestText: null } as const;

export interface TaxSettings {
  readonly ivaRate: number;
  readonly ishRate: number;
  readonly discountThreshold: number;
  readonly dsaPerNight: number;
  /** `false` = la property todavia no guarda ninguna fila: los valores son los de omision, no una decision del hotel. */
  readonly configurado: boolean;
}

export interface SaveTaxSettingsInput {
  readonly propertyId: string;
  readonly organizationId: string;
  /** Quien edita (solo el adaptador en memoria lo usa para su bitacora; en Postgres la funcion toma `auth.uid()`). */
  readonly actorUserId: string;
  readonly ivaRate: number;
  readonly ishRate: number;
  readonly discountThreshold: number;
  readonly dsaPerNight: number;
}

export interface CancellationPolicySettings {
  readonly freeUntilHours: number;
  readonly penaltyPct: number;
  readonly guestText: string | null;
  readonly configurado: boolean;
}

export interface SaveCancellationPolicyInput {
  readonly propertyId: string;
  readonly organizationId: string;
  /** Quien edita (solo el adaptador en memoria lo usa para su bitacora; en Postgres la funcion toma `auth.uid()`). */
  readonly actorUserId: string;
  readonly freeUntilHours: number;
  readonly penaltyPct: number;
  readonly guestText: string | null;
}

export interface RoomTypeOverbookingSettings {
  readonly roomTypeId: string;
  readonly name: string;
  readonly maxOverbookRooms: number;
  readonly thresholdPct: number;
}

export interface SaveRoomTypeOverbookingInput {
  readonly propertyId: string;
  readonly organizationId: string;
  /** Quien edita (solo el adaptador en memoria lo usa para su bitacora; en Postgres la funcion toma `auth.uid()`). */
  readonly actorUserId: string;
  readonly roomTypeId: string;
  readonly maxOverbookRooms: number;
  readonly thresholdPct: number | null;
}

export interface RatePlanRow {
  readonly id: string;
  readonly roomTypeId: string;
  readonly roomTypeName: string;
  readonly date: string;
  readonly price: number;
  readonly currency: string;
  readonly minStay: number;
  readonly closedToArrival: boolean;
  readonly closedToDeparture: boolean;
  /** Momento en que un humano fijo el precio; mientras exista, el motor de revenue no lo sobreescribe. `null` = nunca fijado a mano (o base sin migrar). */
  readonly manualPriceAt: string | null;
}

export interface ListRatePlansQuery {
  readonly propertyId: string;
  readonly from: string;
  readonly to: string;
  readonly roomTypeId: string | null;
  readonly limit: number;
}

export interface SaveRatePriceInput {
  readonly propertyId: string;
  readonly organizationId: string;
  /** Quien edita (solo el adaptador en memoria lo usa para su bitacora; en Postgres la funcion toma `auth.uid()`). */
  readonly actorUserId: string;
  readonly rateId: string;
  readonly price: number;
  readonly minStay: number | null;
}

export type ConfigAuditArea = "impuestos" | "politica_cancelacion" | "sobreventa" | "tarifa" | "onboarding_omitido";

export interface ConfigAuditEntry {
  readonly id: string;
  readonly area: ConfigAuditArea;
  readonly entityId: string | null;
  readonly actorUserId: string | null;
  readonly valorAnterior: Record<string, unknown> | null;
  readonly valorNuevo: Record<string, unknown>;
  readonly createdAt: string;
}
