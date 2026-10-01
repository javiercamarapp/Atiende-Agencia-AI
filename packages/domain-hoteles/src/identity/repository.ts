// Puerto de la boveda de identidad (H-01). Separado de `HotelesRepository` a proposito:
// esa interfaz ya tiene ~100 metodos y todo lo de esta superficie degrada distinto
// (base sin migrar = "no disponible aun", no el camino anterior).
//
// `actorUserId`: el adaptador Postgres lo IGNORA (la autoridad es `auth.uid()` de la
// sesion, ver migrations/031); existe para que el adaptador en memoria pueda aplicar el
// doble control sin sesion real.
import type {
  IdentityAccessLogRecord,
  IdentityListResult,
  IdentityPurgeRequestRecord,
  IdentityPurgeStatus,
  IdentityRetentionSweepResult,
  IdentityStatus,
  IdentityVaultRecord,
  MigratoryRegistrationRecord,
  MigratoryStatus,
  NewIdentityVaultInput,
  RevealedEnvelope,
} from "./types.ts";

export interface IdentityRepository {
  captureIdentity(input: NewIdentityVaultInput): Promise<IdentityVaultRecord>;
  listIdentities(propertyId: string, filters: { readonly guestId?: string; readonly status?: IdentityStatus; readonly limit: number }): Promise<IdentityListResult<IdentityVaultRecord>>;
  /** `null` si no existe en esa property (o el llamador no la ve). Base sin migrar: `null`. */
  findIdentity(propertyId: string, vaultId: string): Promise<IdentityVaultRecord | null>;
  verifyIdentity(vaultId: string, actorUserId: string): Promise<void>;
  /** Entrega el sobre cifrado y deja huella en la bitacora (misma transaccion). */
  revealIdentity(vaultId: string, reason: string, actorUserId: string): Promise<RevealedEnvelope>;
  listAccessLog(propertyId: string, filters: { readonly vaultId?: string; readonly limit: number }): Promise<IdentityListResult<IdentityAccessLogRecord>>;
  requestPurge(vaultId: string, reason: string, actorUserId: string): Promise<string>;
  listPurgeRequests(propertyId: string, filters: { readonly status?: IdentityPurgeStatus; readonly limit: number }): Promise<IdentityListResult<IdentityPurgeRequestRecord>>;
  findPurgeRequest(propertyId: string, requestId: string): Promise<IdentityPurgeRequestRecord | null>;
  /** Aprobar ya NO purga (migracion 032): bloquea la identidad y devuelve `en_bloqueo`. En una base sin 032
   *  el resultado es `ejecutada` (purga directa de 031). */
  decidePurge(requestId: string, approve: boolean, note: string | null, actorUserId: string): Promise<"ejecutada" | "rechazada" | "en_bloqueo">;
  /** Solo sesion de sistema. Con 031: purga las identidades vencidas de UNA property. Con 032 SOLO purga las
   *  bloqueadas con ventana vencida y sin retencion legal. */
  purgeExpired(propertyId: string, today: string): Promise<number>;
  /** Solo sesion de sistema (cron): bloquea lo vencido y purga lo bloqueado con ventana vencida (032). En una base
   *  sin 032 cae a `purgeExpired` (camino anterior, sin bloqueo). */
  sweepRetention(propertyId: string, today: string): Promise<IdentityRetentionSweepResult>;
  /** Acceso excepcional a una identidad BLOQUEADA: consume una aprobacion vigente del propio llamador (doble control). */
  revealBlockedIdentity(accessRequestId: string, actorUserId: string): Promise<RevealedEnvelope>;
  createMigratoryRegistration(input: { readonly propertyId: string; readonly reservationId: string; readonly guestId: string; readonly vaultId: string | null; readonly actorUserId: string }): Promise<MigratoryRegistrationRecord>;
  listMigratoryRegistrations(propertyId: string, filters: { readonly status?: MigratoryStatus; readonly limit: number }): Promise<IdentityListResult<MigratoryRegistrationRecord>>;
  /** `null` si no existe en esa property. */
  reportMigratoryRegistration(propertyId: string, registrationId: string, constanciaRef: string, actorUserId: string): Promise<MigratoryRegistrationRecord | null>;
}
