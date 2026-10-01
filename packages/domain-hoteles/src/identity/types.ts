// Tipos de la boveda de identidad (H-01). `IdentityVaultRecord` son SOLO metadatos: el
// documento en claro (`IdentityPayload`) existe unicamente en memoria durante captura y
// revelacion; en la base vive como sobre cifrado (migrations/031).

export const IDENTITY_DOCUMENT_TYPES = ["ine", "pasaporte", "licencia_conducir", "forma_migratoria", "otro"] as const;
export type IdentityDocumentType = (typeof IDENTITY_DOCUMENT_TYPES)[number];

/** `bloqueada` (migracion 032): vencida o con purga aprobada; sin acceso operativo, se purga al vencer la ventana. */
export type IdentityStatus = "activo" | "bloqueada" | "purgado";
export type IdentityBlockReason = "retencion_vencida" | "solicitud_purga" | "arco" | "manual";
/** `en_bloqueo` (032): purga aprobada, la identidad esta bloqueada y se purgara al vencer la ventana. */
export type IdentityPurgeStatus = "pendiente" | "ejecutada" | "rechazada" | "en_bloqueo";
export type MigratoryStatus = "pendiente" | "reportado";

export type IdentityAccessAction =
  | "captura"
  | "verificacion"
  | "revelacion"
  | "purga_solicitada"
  | "purga_aprobada"
  | "purga_rechazada"
  | "purga_por_retencion"
  | "bloqueo"
  | "purga_por_bloqueo_vencido"
  | "acceso_excepcional_solicitado"
  | "acceso_excepcional_aprobado"
  | "acceso_excepcional_rechazado"
  | "acceso_excepcional_revelacion"
  | "retencion_legal_aplicada"
  | "retencion_legal_liberada";

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
  /** Bloqueo (migracion 032). En una base sin 032 todos son `null`. */
  readonly blockedAt: string | null;
  readonly blockedUntil: string | null;
  readonly blockWindowDays: number | null;
  readonly blockReason: IdentityBlockReason | null;
  readonly blockedBy: string | null;
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

/** Resultado del barrido de retencion de una property (cron). */
export interface IdentityRetentionSweepResult {
  /** Identidades activas con retencion vencida que pasaron a `bloqueada`. */
  readonly blocked: number;
  /** Identidades bloqueadas con ventana vencida (y sin retencion legal) que se purgaron. */
  readonly purged: number;
  /** `false` = la base no tiene 032: se uso el camino anterior (purga directa de 031). */
  readonly viaBloqueo: boolean;
}
