// Cliente 360 (migracion 044): tipos de la memoria del cliente. Viven aparte de `types.ts` para no mezclar este
// dominio con el resto del catalogo de tipos del paquete.
import type { Customer, CustomerTier, PersistedOrderItem } from "../types.ts";

/** Categorias de gusto que se aprenden de pedidos confirmados (o que escribe el staff). */
export const PREFERENCE_KINDS = ["tortilla", "salsa", "omision", "nota", "pago", "propina", "canal", "sucursal"] as const;
export type PreferenceKind = (typeof PREFERENCE_KINDS)[number];

export function isPreferenceKind(value: unknown): value is PreferenceKind {
  return typeof value === "string" && (PREFERENCE_KINDS as readonly string[]).includes(value);
}

/** Domicilio guardado con todo lo que se sabe de el. El ultimo usado va primero en las listas. */
export interface CustomerAddressDetail {
  readonly id: string;
  readonly address: string;
  readonly label: string | null;
  readonly isDefault: boolean;
  readonly accessNotes: string | null;
  readonly mapsUrl: string | null;
  readonly colonia: string | null;
  readonly branchSlug: string | null;
  readonly lastUsedAt: string | null;
  readonly timesUsed: number;
}

export interface CustomerPreference {
  readonly id: string;
  readonly kind: PreferenceKind;
  readonly value: string;
  /** pedido = aprendido de un pedido confirmado; staff = lo escribio una persona del restaurante. */
  readonly source: "pedido" | "staff";
  readonly timesSeen: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly status: "activa" | "descartada";
}

/** Pedido anterior del MISMO cliente (sin cancelados), con lo necesario para listarlo y repetirlo. */
export interface PastOrder {
  readonly id: string;
  /** Numero de pedido que el cliente puede citar ("el pedido 1234"). */
  readonly orderNumber: number | null;
  readonly createdAt: string;
  readonly status: string;
  readonly total: number;
  readonly items: readonly PersistedOrderItem[];
  readonly branch: string | null;
  readonly propertyId: string | null;
  readonly paymentMethod: "efectivo" | "tarjeta" | null;
  readonly canal: "domicilio" | "recoger" | null;
  readonly propina: number | null;
  readonly source: string;
}

/** Cuentas de confiabilidad dentro de la ventana de la politica. */
export interface CustomerReliability {
  readonly noRecogidos90d: number;
  readonly pedidosFalsos: number;
  /** 0 = politica apagada. */
  readonly umbral: number;
  readonly ventanaDias: number;
}

/** Todo lo que el sistema recuerda de un cliente (lectura de la sesion de sistema, `cliente_memoria`). */
export interface CustomerMemory {
  readonly customer: Customer;
  readonly addresses: readonly CustomerAddressDetail[];
  /** Hasta 30 pedidos que cuentan (sin cancelados), el mas reciente primero. */
  readonly orders: readonly PastOrder[];
  readonly preferences: readonly CustomerPreference[];
  readonly reliability: CustomerReliability;
}

export interface ClosureAddress {
  readonly address: string;
  readonly label?: string;
  readonly accessNotes?: string;
  readonly mapsUrl?: string;
  readonly colonia?: string;
  readonly propertyId?: string;
}

export interface ClosureObservation {
  readonly kind: PreferenceKind;
  readonly value: string;
}

/** Cierre del ciclo del cliente tras crear un pedido: domicilio y gustos, idempotente por pedido. */
export interface OrderClosureInput {
  readonly organizationId: string;
  readonly orderId: string;
  readonly address: ClosureAddress | null;
  readonly observations: readonly ClosureObservation[];
}

/** Gusto propuesto al cliente: explicable (cuantas veces y desde cuando). */
export interface TasteProposal {
  readonly kind: PreferenceKind;
  readonly value: string;
  readonly fuente: "pedido" | "staff";
  readonly veces: number;
  readonly ultimaVez: string;
}

/** Politica de reincidencia ("no recogido" y pedido falso) de la organizacion. */
export interface CustomerPolicy {
  /** 0 = apagada. */
  readonly umbralNoRecogidos: number;
  readonly ventanaDias: number;
}

/** Politica por omision cuando la organizacion no ha configurado nada (o la base no tiene la migracion 044). */
export const POLITICA_POR_OMISION: CustomerPolicy = { umbralNoRecogidos: 2, ventanaDias: 90 };

export interface CustomerFicha {
  readonly customer: Customer & {
    readonly lastOrderAt: string | null;
    readonly createdAt: string;
    readonly fechaNacimientoDia: number | null;
    readonly fechaNacimientoMes: number | null;
    readonly staffNotes: string | null;
  };
  readonly addresses: readonly CustomerAddressDetail[];
  readonly preferences: readonly CustomerPreference[];
  readonly reliability: CustomerReliability;
  readonly tier: CustomerTier | null;
  readonly orders: ReadonlyArray<{
    readonly id: string;
    readonly orderNumber: number | null;
    readonly createdAt: string;
    readonly status: string;
    readonly total: number;
    readonly items: readonly PersistedOrderItem[];
    readonly branch: string | null;
    readonly source: string;
    readonly paymentMethod: string | null;
    readonly pedidoFalso: boolean;
  }>;
  readonly whatsapp: { readonly conversaciones: number; readonly ultimaActividad: string | null; readonly mensajes: number };
  readonly llamadas: ReadonlyArray<{ readonly id: string; readonly startedAt: string; readonly durationS: number | null; readonly resultado: string | null }>;
}

export interface CustomerProfilePatch {
  readonly name?: string | null;
  readonly staffNotes?: string | null;
  readonly fechaNacimientoDia?: number | null;
  readonly fechaNacimientoMes?: number | null;
}

export interface CustomerAddressChanges {
  readonly address?: string;
  readonly label?: string | null;
  readonly accessNotes?: string | null;
  readonly mapsUrl?: string | null;
  readonly colonia?: string | null;
  readonly propertyId?: string | null;
  readonly isDefault?: boolean;
}

export type PreferenceAction = "agregar" | "descartar" | "reactivar" | "eliminar";
