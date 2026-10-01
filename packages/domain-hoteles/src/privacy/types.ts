// Tipos de privacidad de hoteles (H-02): aviso versionado, ledger de consentimientos, ARCO,
// retencion legal, incidentes y acceso excepcional a identidades bloqueadas. Modelo SQL en
// migrations/032_hoteles_consentimiento_arco_incidentes.sql.
//
// AVISO: implementacion tecnica de decisiones de producto. NO es asesoria legal; ver
// `PRIVACY_LEGAL_DISCLAIMER` y `PRIVACY_LAWYER_CHECKLIST` en ./rules.ts.

export const ARCO_RIGHTS = ["acceso", "rectificacion", "cancelacion", "oposicion"] as const;
export type ArcoRight = (typeof ARCO_RIGHTS)[number];
export const ARCO_STATUSES = ["recibida", "en_revision", "procedente", "improcedente", "ejecutada"] as const;
export type ArcoStatus = (typeof ARCO_STATUSES)[number];
/** Estados a los que se puede avanzar (`recibida` solo es el estado inicial). */
export type ArcoTargetStatus = Exclude<ArcoStatus, "recibida">;
export const ARCO_CHANNELS = ["mostrador", "correo", "whatsapp", "web", "telefono", "otro"] as const;
export type ArcoChannel = (typeof ARCO_CHANNELS)[number];
export type ArcoExtensionPhase = "respuesta" | "ejecucion";

export const CONSENT_CHANNELS = ["mostrador", "tableta", "qr", "whatsapp", "web", "telefono", "otro"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
export const CONSENT_EVIDENCE_METHODS = ["aviso_simplificado_mostrado", "casilla_electronica", "firma_electronica", "firma_autografa", "mecanismo_autenticacion"] as const;
export type ConsentEvidenceMethod = (typeof CONSENT_EVIDENCE_METHODS)[number];
/** Metodos que cuentan como consentimiento EXPRESO Y POR ESCRITO (datos sensibles). */
export const CONSENT_WRITTEN_METHODS: readonly ConsentEvidenceMethod[] = ["firma_electronica", "firma_autografa", "mecanismo_autenticacion"];

export const INCIDENT_TYPES = ["acceso_no_autorizado", "perdida_robo", "alteracion", "divulgacion", "otro"] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];
export const INCIDENT_SEVERITIES = ["baja", "media", "alta"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export type IncidentStatus = "detectada" | "contenida" | "cerrada";
export type IncidentAction = "contener" | "registrar_notificacion" | "cerrar";

export type LegalHoldStatus = "activa" | "liberada";
export type BlockedAccessStatus = "pendiente" | "aprobada" | "rechazada" | "usada";
export type PrivacyEventSubject = "arco" | "incidente" | "retencion_legal" | "aviso" | "consentimiento" | "configuracion" | "acceso_excepcional";

export interface PrivacyNoticeRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly version: string;
  readonly simplifiedText: string;
  readonly integralUrl: string | null;
  readonly mandatoryPurposes: readonly string[];
  readonly optionalPurposes: readonly string[];
  readonly contentSha256: string | null;
  readonly isCurrent: boolean;
  readonly publishedBy: string | null;
  readonly publishedAt: string;
}

export interface NewPrivacyNoticeInput {
  readonly version: string;
  readonly simplifiedText: string;
  readonly integralUrl: string | null;
  readonly mandatoryPurposes: readonly string[];
  readonly optionalPurposes: readonly string[];
  readonly contentSha256: string | null;
}

export interface ConsentRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly guestId: string;
  readonly vaultId: string | null;
  readonly noticeId: string;
  /** Version del aviso ACEPTADO (copiada por la base desde el aviso). */
  readonly noticeVersion: string;
  readonly acceptedMandatory: readonly string[];
  readonly acceptedOptional: readonly string[];
  readonly channel: ConsentChannel;
  readonly evidenceMethod: ConsentEvidenceMethod;
  readonly sensitiveData: boolean;
  readonly consentedAt: string;
  readonly capturedBy: string | null;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
}

export interface NewConsentInput {
  readonly id: string;
  readonly guestId: string;
  readonly vaultId: string | null;
  readonly noticeId: string;
  readonly acceptedMandatory: readonly string[];
  readonly acceptedOptional: readonly string[];
  readonly channel: ConsentChannel;
  readonly evidenceMethod: ConsentEvidenceMethod;
  readonly sensitiveData: boolean;
}

export interface PrivacySettingsRecord {
  /** Ventana de bloqueo previa a la purga, en dias (3-30; default 7). */
  readonly blockWindowDays: number;
  /** `true` = no hay fila: se usa el default. */
  readonly isDefault: boolean;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

export interface ArcoRequestRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly folio: string;
  readonly rightType: ArcoRight;
  readonly guestId: string | null;
  readonly vaultId: string | null;
  readonly requesterName: string;
  readonly requesterContact: string | null;
  readonly channel: ArcoChannel;
  readonly description: string | null;
  readonly receivedOn: string;
  readonly responseDueOn: string;
  readonly executionDueOn: string | null;
  readonly status: ArcoStatus;
  readonly decidedOn: string | null;
  readonly decisionNote: string | null;
  readonly extensionPhase: ArcoExtensionPhase | null;
  readonly extensionReason: string | null;
  readonly extendedAt: string | null;
  readonly extendedBy: string | null;
  readonly executedAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface NewArcoRequestInput {
  readonly rightType: ArcoRight;
  readonly requesterName: string;
  readonly requesterContact: string | null;
  readonly channel: ArcoChannel;
  readonly description: string | null;
  /** Fecha de recepcion (YYYY-MM-DD, fecha de negocio). */
  readonly receivedOn: string;
  readonly guestId: string | null;
  readonly vaultId: string | null;
}

export interface PrivacyIncidentRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly folio: string;
  readonly incidentType: IncidentType;
  readonly severity: IncidentSeverity;
  readonly title: string;
  readonly description: string;
  readonly detectedAt: string;
  readonly affectedCount: number | null;
  readonly significantRisk: boolean;
  readonly status: IncidentStatus;
  readonly containedAt: string | null;
  readonly notifiedAt: string | null;
  readonly notifiedBy: string | null;
  readonly notificationChannel: string | null;
  readonly notificationRef: string | null;
  readonly noNotificationReason: string | null;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly closingNote: string | null;
  readonly reportedBy: string | null;
  readonly createdAt: string;
}

export interface NewIncidentInput {
  readonly incidentType: IncidentType;
  readonly severity: IncidentSeverity;
  readonly title: string;
  readonly description: string;
  /** Instante ISO de deteccion (no puede estar en el futuro). */
  readonly detectedAt: string;
  readonly affectedCount: number | null;
  readonly significantRisk: boolean;
}

export interface LegalHoldRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly vaultId: string;
  readonly incidentId: string | null;
  readonly folio: string;
  readonly reason: string;
  readonly authorizationRef: string;
  readonly status: LegalHoldStatus;
  readonly placedBy: string;
  readonly placedAt: string;
  readonly reviewDueOn: string;
  readonly releasedBy: string | null;
  readonly releasedAt: string | null;
  readonly releaseNote: string | null;
}

export interface NewLegalHoldInput {
  readonly vaultId: string;
  readonly folio: string;
  readonly reason: string;
  readonly authorizationRef: string;
  readonly incidentId: string | null;
}

export interface BlockedAccessRequestRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly vaultId: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly status: BlockedAccessStatus;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly expiresAt: string | null;
  readonly usedAt: string | null;
  readonly createdAt: string;
}

export interface PrivacyEventRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly subjectType: PrivacyEventSubject;
  readonly subjectId: string | null;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly note: string | null;
  readonly createdAt: string;
}

/** Lectura que puede degradar a vacio honesto en una base sin la migracion 032. */
export interface PrivacyListResult<T> {
  /** `false` = la migracion 032 aun no esta aplicada: `items` vacio, estado "no disponible aun". */
  readonly available: boolean;
  readonly items: readonly T[];
}
