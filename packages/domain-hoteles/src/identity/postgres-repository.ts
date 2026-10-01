// Adaptador Postgres de la boveda de identidad (H-01) sobre `TenantDbSession`
// (auth.uid() real por request). REGLA DURA DE COMPATIBILIDAD: toda operacion corre dentro
// de `runWithSavepointFallback` -- `dbSession` es UNA transaccion por request, y un error
// de Postgres (p. ej. 42P01 en una base sin la migracion 031) la dejaria ABORTADA (25P02).
// Con SAVEPOINT la sesion queda utilizable: las lecturas degradan a vacio honesto
// (`available: false`), las escrituras a `IdentityUnavailableError` (503).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, isUndefinedColumnError, runWithSavepointFallback } from "@atiende/db";
import {
  IdentityAccessDeniedError,
  IdentityBlockedError,
  IdentityConflictError,
  IdentityDoubleControlError,
  IdentityInvalidInputError,
  IdentityPurgedError,
  IdentityRequestResolvedError,
  IdentityUnavailableError,
} from "./errors.ts";
import type { IdentityRepository } from "./repository.ts";
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

// `payload_enc` JAMAS aparece en una lista de columnas de SELECT (sin GRANT de columna).
// Columnas de la boveda de 031 (base SIN la migracion 032: no existen las de bloqueo -> 42703).
const VAULT_COLUMNS_LEGACY = `id, property_id, guest_id, reservation_id, document_type, nationality, document_last4, key_version,
       status, retention_until::text as retention_until, verified_at::text as verified_at, verified_by, captured_by,
       created_at::text as created_at, purged_at::text as purged_at`;
// Con 032 se agregan las columnas de bloqueo (metadatos; el sobre sigue sin GRANT).
const VAULT_COLUMNS = `${VAULT_COLUMNS_LEGACY}, blocked_at::text as blocked_at, blocked_until::text as blocked_until,
       block_window_days, block_reason, blocked_by`;
const PURGE_COLUMNS = `id, property_id, vault_id, requested_by, reason, status, decided_by, decided_at::text as decided_at,
       decision_note, created_at::text as created_at`;
const MIGRATORY_COLUMNS = `id, property_id, reservation_id, guest_id, vault_id, nationality, arrival_date::text as arrival_date,
       departure_date::text as departure_date, status, constancia_ref, reported_at::text as reported_at, reported_by,
       created_at::text as created_at`;

interface VaultRow {
  id: string; property_id: string; guest_id: string; reservation_id: string | null; document_type: IdentityVaultRecord["documentType"];
  nationality: string | null; document_last4: string | null; key_version: number; status: IdentityStatus; retention_until: string;
  verified_at: string | null; verified_by: string | null; captured_by: string | null; created_at: string; purged_at: string | null;
  // Ausentes en una base sin 032 (consulta con columnas legadas).
  blocked_at?: string | null; blocked_until?: string | null; block_window_days?: number | null;
  block_reason?: IdentityVaultRecord["blockReason"]; blocked_by?: string | null;
}
interface PurgeRow {
  id: string; property_id: string; vault_id: string; requested_by: string; reason: string; status: IdentityPurgeStatus;
  decided_by: string | null; decided_at: string | null; decision_note: string | null; created_at: string;
}
interface MigratoryRow {
  id: string; property_id: string; reservation_id: string; guest_id: string; vault_id: string | null; nationality: string | null;
  arrival_date: string; departure_date: string; status: MigratoryStatus; constancia_ref: string | null; reported_at: string | null;
  reported_by: string | null; created_at: string;
}
interface LogRow {
  id: string; property_id: string; vault_id: string; actor_user_id: string | null; action: IdentityAccessLogRecord["action"];
  reason: string | null; created_at: string;
}

const toVault = (r: VaultRow): IdentityVaultRecord => ({
  id: r.id, propertyId: r.property_id, guestId: r.guest_id, reservationId: r.reservation_id, documentType: r.document_type,
  nationality: r.nationality, documentLast4: r.document_last4, keyVersion: Number(r.key_version), status: r.status,
  retentionUntil: r.retention_until, verifiedAt: r.verified_at, verifiedBy: r.verified_by, capturedBy: r.captured_by,
  createdAt: r.created_at, purgedAt: r.purged_at,
  blockedAt: r.blocked_at ?? null, blockedUntil: r.blocked_until ?? null,
  blockWindowDays: r.block_window_days == null ? null : Number(r.block_window_days), blockReason: r.block_reason ?? null, blockedBy: r.blocked_by ?? null,
});
const toPurge = (r: PurgeRow): IdentityPurgeRequestRecord => ({
  id: r.id, propertyId: r.property_id, vaultId: r.vault_id, requestedBy: r.requested_by, reason: r.reason, status: r.status,
  decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note, createdAt: r.created_at,
});
const toMigratory = (r: MigratoryRow): MigratoryRegistrationRecord => ({
  id: r.id, propertyId: r.property_id, reservationId: r.reservation_id, guestId: r.guest_id, vaultId: r.vault_id,
  nationality: r.nationality, arrivalDate: r.arrival_date, departureDate: r.departure_date, status: r.status,
  constanciaRef: r.constancia_ref, reportedAt: r.reported_at, reportedBy: r.reported_by, createdAt: r.created_at,
});
const toLog = (r: LogRow): IdentityAccessLogRecord => ({
  id: r.id, propertyId: r.property_id, vaultId: r.vault_id, actorUserId: r.actor_user_id, action: r.action, reason: r.reason, createdAt: r.created_at,
});

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: string }).code) : undefined;
}
function pgMessage(err: unknown): string {
  return err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string" ? (err as { message: string }).message : "";
}

/** Traduce los errores de las funciones/triggers de la migracion 031 a errores de
 *  dominio. Lo desconocido se repropaga tal cual (nunca se enmascara). */
export function mapIdentityPgError(err: unknown, operation: string): unknown {
  const code = pgCode(err);
  const message = pgMessage(err);
  if (code === "42501") {
    if (message.startsWith("doble_control")) return new IdentityDoubleControlError();
    if (message.startsWith("identidad_purgada")) return new IdentityPurgedError();
    if (message.startsWith("identidad_bloqueada")) return new IdentityBlockedError();
    // Guardas de datos de 032: la purga solo pasa por bloqueo, con ventana vencida y sin retencion legal.
    if (message.startsWith("purga_sin_bloqueo") || message.startsWith("bloqueo_vigente") || message.startsWith("retencion_legal")) {
      return new IdentityConflictError(message.replace(/^[a-z_]+:\s*/, ""));
    }
    if (message.startsWith("registro_migratorio")) return new IdentityConflictError("El registro migratorio ya fue reportado y no se puede modificar.");
    return new IdentityAccessDeniedError(operation);
  }
  if (code === "P0001") {
    if (message.startsWith("identidad_purgada")) return new IdentityPurgedError();
    if (message.startsWith("identidad_bloqueada")) return new IdentityBlockedError();
    if (message.startsWith("solicitud_resuelta")) return new IdentityRequestResolvedError();
    if (message.startsWith("acceso_no_vigente")) return new IdentityConflictError(message.replace(/^[a-z_]+:\s*/, ""));
  }
  if (code === "22023") return new IdentityInvalidInputError(message.replace(/^[a-z_]+:\s*/, ""));
  if (code === "23503") return new IdentityInvalidInputError(message.replace(/^[a-z_]+:\s*/, "") || "Referencia invalida (huesped, reserva o identidad de otra property).");
  if (code === "23505") {
    return new IdentityConflictError(
      message.includes("identity_purge_request") ? "Ya existe una solicitud de purga pendiente para esta identidad." : "Ya existe un registro migratorio para esta reserva y huesped.",
    );
  }
  if (code === "23514") return new IdentityInvalidInputError("Los datos no cumplen las restricciones del modelo (formato del sobre cifrado, estado o constancia).");
  return err;
}

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async write<T>(operation: string, functionName: string | undefined, primary: () => Promise<T>): Promise<T> {
    try {
      return await runWithSavepointFallback({
        session: this.db,
        primary,
        isRecoverable: (e) => isMigrationPendingError(e, functionName),
        fallback: () => {
          throw new IdentityUnavailableError("migracion_pendiente", operation);
        },
      });
    } catch (err) {
      throw mapIdentityPgError(err, operation);
    }
  }

  private read<T>(operation: string, primary: () => Promise<T>, unavailable: T): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary,
      isRecoverable: (e) => isMigrationPendingError(e),
      fallback: () => {
        console.warn(`identidad.${operation}: migracion 031 pendiente -- degradando a "no disponible aun".`);
        return Promise.resolve(unavailable);
      },
    });
  }

  /** Lee filas de la boveda; en una base con 031 pero sin 032 (42703 por las columnas de bloqueo) repite con las columnas legadas. */
  private vaultRows(sql: (columns: string) => string, params: unknown[]): Promise<VaultRow[]> {
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => (await this.db.query<VaultRow>(sql(VAULT_COLUMNS), params)).rows,
      isRecoverable: isUndefinedColumnError,
      fallback: async () => (await this.db.query<VaultRow>(sql(VAULT_COLUMNS_LEGACY), params)).rows,
    });
  }

  async captureIdentity(input: NewIdentityVaultInput): Promise<IdentityVaultRecord> {
    const params = [input.id, input.propertyId, input.guestId, input.reservationId, input.documentType, input.nationality, input.documentLast4, input.payloadEnc, input.keyVersion, input.retentionUntil];
    const insert = async (columns: string): Promise<IdentityVaultRecord> => {
      const { rows } = await this.db.query<VaultRow>(
        `insert into hoteles.identity_vault (id, property_id, guest_id, reservation_id, document_type, nationality, document_last4, payload_enc, key_version, retention_until)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning ${columns};`,
        params,
      );
      return toVault(rows[0]!);
    };
    return this.write("capture", undefined, () =>
      // Base con 031 pero sin 032: el RETURNING con columnas de bloqueo da 42703 -> se repite con las legadas.
      runWithSavepointFallback({ session: this.db, primary: () => insert(VAULT_COLUMNS), isRecoverable: isUndefinedColumnError, fallback: () => insert(VAULT_COLUMNS_LEGACY) }),
    );
  }

  async listIdentities(propertyId: string, filters: { guestId?: string; status?: IdentityStatus; limit: number }): Promise<IdentityListResult<IdentityVaultRecord>> {
    return this.read<IdentityListResult<IdentityVaultRecord>>(
      "list",
      async () => {
        const rows = await this.vaultRows(
          (cols) => `select ${cols} from hoteles.identity_vault
           where property_id = $1 and ($2::uuid is null or guest_id = $2) and ($3::text is null or status = $3)
           order by created_at desc, id limit $4;`,
          [propertyId, filters.guestId ?? null, filters.status ?? null, filters.limit],
        );
        return { available: true, items: rows.map(toVault) };
      },
      { available: false, items: [] },
    );
  }

  async findIdentity(propertyId: string, vaultId: string): Promise<IdentityVaultRecord | null> {
    return this.read<IdentityVaultRecord | null>(
      "find",
      async () => {
        const rows = await this.vaultRows((cols) => `select ${cols} from hoteles.identity_vault where property_id = $1 and id = $2;`, [propertyId, vaultId]);
        return rows[0] ? toVault(rows[0]) : null;
      },
      null,
    );
  }

  async verifyIdentity(vaultId: string, actorUserId: string): Promise<void> {
    void actorUserId; // la funcion sella auth.uid().
    await this.write("verify", "verify_identity", async () => {
      await this.db.query(`select hoteles.verify_identity($1);`, [vaultId]);
    });
  }

  async revealIdentity(vaultId: string, reason: string, actorUserId: string): Promise<RevealedEnvelope> {
    void actorUserId;
    return this.write("reveal", "reveal_identity", async () => {
      const { rows } = await this.db.query<{ out_payload_enc: string; out_key_version: number }>(
        `select out_payload_enc, out_key_version from hoteles.reveal_identity($1, $2);`,
        [vaultId, reason],
      );
      const row = rows[0];
      if (!row) throw new IdentityAccessDeniedError("reveal");
      return { envelope: row.out_payload_enc, keyVersion: Number(row.out_key_version) };
    });
  }

  async listAccessLog(propertyId: string, filters: { vaultId?: string; limit: number }): Promise<IdentityListResult<IdentityAccessLogRecord>> {
    return this.read<IdentityListResult<IdentityAccessLogRecord>>(
      "access-log",
      async () => {
        const { rows } = await this.db.query<LogRow>(
          `select id, property_id, vault_id, actor_user_id, action, reason, created_at::text as created_at
           from hoteles.identity_access_log
           where property_id = $1 and ($2::uuid is null or vault_id = $2)
           order by created_at desc, id limit $3;`,
          [propertyId, filters.vaultId ?? null, filters.limit],
        );
        return { available: true, items: rows.map(toLog) };
      },
      { available: false, items: [] },
    );
  }

  async requestPurge(vaultId: string, reason: string, actorUserId: string): Promise<string> {
    void actorUserId;
    return this.write("purge-request", "request_identity_purge", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select hoteles.request_identity_purge($1, $2) as id;`, [vaultId, reason]);
      return rows[0]!.id;
    });
  }

  async listPurgeRequests(propertyId: string, filters: { status?: IdentityPurgeStatus; limit: number }): Promise<IdentityListResult<IdentityPurgeRequestRecord>> {
    return this.read<IdentityListResult<IdentityPurgeRequestRecord>>(
      "purge-list",
      async () => {
        const { rows } = await this.db.query<PurgeRow>(
          `select ${PURGE_COLUMNS} from hoteles.identity_purge_request
           where property_id = $1 and ($2::text is null or status = $2)
           order by created_at desc, id limit $3;`,
          [propertyId, filters.status ?? null, filters.limit],
        );
        return { available: true, items: rows.map(toPurge) };
      },
      { available: false, items: [] },
    );
  }

  async findPurgeRequest(propertyId: string, requestId: string): Promise<IdentityPurgeRequestRecord | null> {
    return this.read<IdentityPurgeRequestRecord | null>(
      "purge-find",
      async () => {
        const { rows } = await this.db.query<PurgeRow>(`select ${PURGE_COLUMNS} from hoteles.identity_purge_request where property_id = $1 and id = $2;`, [propertyId, requestId]);
        return rows[0] ? toPurge(rows[0]) : null;
      },
      null,
    );
  }

  async decidePurge(requestId: string, approve: boolean, note: string | null, actorUserId: string): Promise<"ejecutada" | "rechazada" | "en_bloqueo"> {
    void actorUserId;
    return this.write("purge-decide", "decide_identity_purge", async () => {
      const { rows } = await this.db.query<{ result: "ejecutada" | "rechazada" | "en_bloqueo" }>(`select hoteles.decide_identity_purge($1, $2, $3) as result;`, [requestId, approve, note]);
      return rows[0]!.result;
    });
  }

  async purgeExpired(propertyId: string, today: string): Promise<number> {
    return this.write("purge-expired", "purge_expired_identities", async () => {
      const { rows } = await this.db.query<{ n: number }>(`select hoteles.purge_expired_identities($1, $2::date) as n;`, [propertyId, today]);
      return Number(rows[0]?.n ?? 0);
    });
  }

  async sweepRetention(propertyId: string, today: string): Promise<IdentityRetentionSweepResult> {
    try {
      return await runWithSavepointFallback<IdentityRetentionSweepResult>({
        session: this.db,
        primary: async () => {
          const { rows } = await this.db.query<{ out_blocked: number; out_purged: number }>(
            `select out_blocked, out_purged from hoteles.sweep_identity_retention($1, $2::date);`,
            [propertyId, today],
          );
          return { blocked: Number(rows[0]?.out_blocked ?? 0), purged: Number(rows[0]?.out_purged ?? 0), viaBloqueo: true };
        },
        isRecoverable: (e) => isMigrationPendingError(e, "sweep_identity_retention"),
        // Base sin 032: camino anterior (purga directa de 031), sin bloqueo.
        fallback: async () => ({ blocked: 0, purged: await this.purgeExpired(propertyId, today), viaBloqueo: false }),
      });
    } catch (err) {
      throw mapIdentityPgError(err, "sweep");
    }
  }

  async revealBlockedIdentity(accessRequestId: string, actorUserId: string): Promise<RevealedEnvelope> {
    void actorUserId;
    return this.write("reveal-blocked", "reveal_blocked_identity", async () => {
      const { rows } = await this.db.query<{ out_payload_enc: string; out_key_version: number }>(
        `select out_payload_enc, out_key_version from hoteles.reveal_blocked_identity($1);`,
        [accessRequestId],
      );
      const row = rows[0];
      if (!row) throw new IdentityAccessDeniedError("reveal-blocked");
      return { envelope: row.out_payload_enc, keyVersion: Number(row.out_key_version) };
    });
  }

  async createMigratoryRegistration(input: { propertyId: string; reservationId: string; guestId: string; vaultId: string | null; actorUserId: string }): Promise<MigratoryRegistrationRecord> {
    return this.write("migratory-create", undefined, async () => {
      const { rows } = await this.db.query<MigratoryRow>(
        `insert into hoteles.migratory_registration (property_id, reservation_id, guest_id, vault_id)
         values ($1, $2, $3, $4) returning ${MIGRATORY_COLUMNS};`,
        [input.propertyId, input.reservationId, input.guestId, input.vaultId],
      );
      return toMigratory(rows[0]!);
    });
  }

  async listMigratoryRegistrations(propertyId: string, filters: { status?: MigratoryStatus; limit: number }): Promise<IdentityListResult<MigratoryRegistrationRecord>> {
    return this.read<IdentityListResult<MigratoryRegistrationRecord>>(
      "migratory-list",
      async () => {
        const { rows } = await this.db.query<MigratoryRow>(
          `select ${MIGRATORY_COLUMNS} from hoteles.migratory_registration
           where property_id = $1 and ($2::text is null or status = $2)
           order by arrival_date desc, id limit $3;`,
          [propertyId, filters.status ?? null, filters.limit],
        );
        return { available: true, items: rows.map(toMigratory) };
      },
      { available: false, items: [] },
    );
  }

  async reportMigratoryRegistration(propertyId: string, registrationId: string, constanciaRef: string, actorUserId: string): Promise<MigratoryRegistrationRecord | null> {
    void actorUserId; // el trigger sella reported_by = auth.uid().
    return this.write("migratory-report", undefined, async () => {
      const { rows } = await this.db.query<MigratoryRow>(
        `update hoteles.migratory_registration set status = 'reportado', constancia_ref = $3
         where property_id = $1 and id = $2 returning ${MIGRATORY_COLUMNS};`,
        [propertyId, registrationId, constanciaRef],
      );
      return rows[0] ? toMigratory(rows[0]) : null;
    });
  }
}
