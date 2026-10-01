// Tipos de la boveda de identidad (H-01). `IdentityVaultRecord` son SOLO metadatos: el
// documento en claro (`IdentityPayload`) existe unicamente en memoria durante captura y
// revelacion; en la base vive como sobre cifrado (migrations/031).

export const IDENTITY_DOCUMENT_TYPES = ["ine", "pasaporte", "licencia_conducir", "forma_migratoria", "otro"] as const;
export type IdentityDocumentType = (typeof IDENTITY_DOCUMENT_TYPES)[number];

export type IdentityStatus = "activo" | "purgado";
export type IdentityPurgeStatus = "pendiente" | "ejecutada" | "rechazada";
export type MigratoryStatus = "pendiente" | "reportado";

export type IdentityAccessAction =
  | "captura"
  | "verificacion"
  | "revelacion"
  | "purga_solicitada"
  | "purga_aprobada"
  | "purga_rechazada"
  | "purga_por_retencion";

/** Documento en claro (nunca persiste ni se loguea). */
export interface IdentityPayload {
  readonly fullName: string;
  readonly documentNumber: string;
  readonly birthDate: string | null;
  readonly issuingCountry: string | null;
  readonly expiryDate: string | null;
  readonly mrz: string | null;
}

export interface IdentityVaultRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly guestId: string;
  readonly reservationId: string | null;
  readonly documentType: IdentityDocumentType;
  readonly nationality: string | null;
  readonly documentLast4: string | null;
  readonly keyVersion: number;
  readonly status: IdentityStatus;
  readonly retentionUntil: string;
  readonly verifiedAt: string | null;
  readonly verifiedBy: string | null;
  readonly capturedBy: string | null;
  readonly createdAt: string;
  readonly purgedAt: string | null;
}

export interface NewIdentityVaultInput {
  readonly id: string;
  readonly propertyId: string;
  readonly guestId: string;
  readonly reservationId: string | null;
  readonly documentType: IdentityDocumentType;
  readonly nationality: string | null;
  readonly documentLast4: string | null;
  readonly payloadEnc: string;
  readonly keyVersion: number;
  readonly retentionUntil: string;
  /** Quien captura (el adaptador Postgres lo ignora: el trigger sella auth.uid()). */
  readonly actorUserId: string;
}

export interface IdentityAccessLogRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly vaultId: string;
  readonly actorUserId: string | null;
  readonly action: IdentityAccessAction;
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface IdentityPurgeRequestRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly vaultId: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly status: IdentityPurgeStatus;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly createdAt: string;
}

export interface MigratoryRegistrationRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly reservationId: string;
  readonly guestId: string;
  readonly vaultId: string | null;
  readonly nationality: string | null;
  readonly arrivalDate: string;
  readonly departureDate: string;
  readonly status: MigratoryStatus;
  readonly constanciaRef: string | null;
  readonly reportedAt: string | null;
  readonly reportedBy: string | null;
  readonly createdAt: string;
}

/** Resultado de una lectura que puede degradar a vacio honesto en una base sin migrar. */
export interface IdentityListResult<T> {
  /** `false` = la migracion 031 aun no esta aplicada: `items` vacio, estado "no disponible aun". */
  readonly available: boolean;
  readonly items: readonly T[];
}

export interface RevealedEnvelope {
  readonly envelope: string;
  readonly keyVersion: number;
}
