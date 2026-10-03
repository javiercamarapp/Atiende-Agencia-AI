// Adaptadores Postgres de la privacidad publica del huesped (H-30) sobre `TenantDbSession`.
// REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: la sesion es UNA transaccion por request; un 42883/42P01/42703
// la dejaria ABORTADA (25P02). Toda llamada a las funciones de la migracion 042 corre en `runWithSavepointFallback`:
// la lectura publica degrada a `available: false` y las escrituras a `PrivacyUnavailableError` (503 honesto).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { PrivacyNotFoundError, PrivacyUnavailableError } from "./errors.ts";
import { mapPrivacyPgError } from "./postgres-repository.ts";
import type {
  AccessGrant,
  ExportFormat,
  GuestDataDocument,
  GuestDataRepository,
  PublicNoticeProperty,
  PublicNoticesResult,
  PublicPrivacyRepository,
  PublicVerifyOutcome,
  PublicVerifyResult,
  SubmitPublicArcoInput,
} from "./public.ts";

const MIGRATION_HINT = "migracion 042 pendiente";

async function guardedWrite<T>(db: TenantDbSession, operation: string, functionName: string, primary: () => Promise<T>): Promise<T> {
  try {
    return await runWithSavepointFallback({
      session: db,
      primary,
      isRecoverable: (e) => isMigrationPendingError(e, functionName),
      fallback: () => {
        throw new PrivacyUnavailableError(`${operation} (${MIGRATION_HINT})`);
      },
    });
  } catch (err) {
    throw mapPrivacyPgError(err, operation);
  }
}

export class PostgresPublicPrivacyRepository implements PublicPrivacyRepository {
  constructor(private readonly db: TenantDbSession) {}

  async listNotices(orgSlug: string): Promise<PublicNoticesResult> {
    interface Row {
      out_org_name: string;
      out_property_id: string;
      out_property_name: string;
      out_notice_id: string | null;
      out_version: string | null;
      out_simplified_text: string | null;
      out_integral_url: string | null;
      out_mandatory: string[] | null;
      out_optional: string[] | null;
      out_published_at: string | null;
    }
    return runWithSavepointFallback<PublicNoticesResult>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<Row>(
          `select out_org_name, out_property_id, out_property_name, out_notice_id, out_version, out_simplified_text, out_integral_url,
                  out_mandatory, out_optional, out_published_at::text as out_published_at
             from hoteles.public_privacy_notices($1);`,
          [orgSlug],
        );
        const properties: PublicNoticeProperty[] = rows.map((r) => ({
          propertyId: r.out_property_id,
          propertyName: r.out_property_name,
          notice:
            r.out_notice_id && r.out_version && r.out_simplified_text && r.out_published_at
              ? {
                  id: r.out_notice_id,
                  version: r.out_version,
                  simplifiedText: r.out_simplified_text,
                  integralUrl: r.out_integral_url,
                  mandatoryPurposes: r.out_mandatory ?? [],
                  optionalPurposes: r.out_optional ?? [],
                  publishedAt: r.out_published_at,
                }
              : null,
        }));
        return { available: true, organizationName: rows[0]?.out_org_name ?? null, properties };
      },
      isRecoverable: (e) => isMigrationPendingError(e),
      fallback: () => Promise.resolve({ available: false, organizationName: null, properties: [] }),
    });
  }

  submitArco(input: SubmitPublicArcoInput): Promise<string | null> {
    return guardedWrite(this.db, "solicitud ARCO publica", "public_arco_submit", async () => {
      const { rows } = await this.db.query<{ id: string | null }>(
        `select hoteles.public_arco_submit($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::integer, $9::jsonb, $10::date) as id;`,
        [
          input.requestId,
          input.propertyId,
          input.rightType,
          input.name,
          input.contact,
          input.description,
          input.codeHash,
          input.ttlSeconds,
          JSON.stringify({ to: input.email.to, subject: input.email.subject, html: input.email.html, text: input.email.text }),
          input.today,
        ],
      );
      return rows[0]?.id ?? null;
    });
  }

  verifyArco(requestId: string, codeHash: string, today: string | null): Promise<PublicVerifyOutcome> {
    return guardedWrite(this.db, "verificacion de solicitud ARCO", "public_arco_verify", async () => {
      const { rows } = await this.db.query<{ out_result: PublicVerifyResult; out_organization_id: string | null; out_property_id: string | null; out_folio: string | null }>(
        `select out_result, out_organization_id, out_property_id, out_folio from hoteles.public_arco_verify($1::uuid, $2, $3::date);`,
        [requestId, codeHash, today],
      );
      const r = rows[0];
      return { result: r?.out_result ?? "invalido", organizationId: r?.out_organization_id ?? null, propertyId: r?.out_property_id ?? null, folio: r?.out_folio ?? null };
    });
  }

  accessSnapshot(requestId: string, orgSlug: string): Promise<GuestDataDocument | null> {
    return guardedWrite(this.db, "consulta de mis datos", "arco_access_snapshot", async () => {
      const { rows } = await this.db.query<{ doc: GuestDataDocument | null }>(`select hoteles.arco_access_snapshot($1::uuid, $2) as doc;`, [requestId, orgSlug]);
      return rows[0]?.doc ?? null;
    });
  }
}

export class PostgresGuestDataRepository implements GuestDataRepository {
  constructor(private readonly db: TenantDbSession) {}

  async exportGuestData(propertyId: string, guestId: string, format: ExportFormat): Promise<GuestDataDocument> {
    try {
      return await guardedWrite(this.db, "exportacion de datos del huesped", "export_guest_data", async () => {
        const { rows } = await this.db.query<{ doc: GuestDataDocument }>(`select hoteles.export_guest_data($1::uuid, $2::uuid, $3) as doc;`, [propertyId, guestId, format]);
        const doc = rows[0]?.doc;
        if (!doc) throw new PrivacyNotFoundError("Huesped");
        return doc;
      });
    } catch (err) {
      // 23503 de la funcion = el huesped no pertenece a la property: 404 (mapPrivacyPgError ya lo volvio entrada invalida).
      if (err instanceof Error && err.name === "PrivacyInvalidInputError" && /huesped no disponible/i.test(err.message)) throw new PrivacyNotFoundError("Huesped");
      throw err;
    }
  }

  grantAccess(requestId: string, guestId: string): Promise<AccessGrant> {
    return guardedWrite(this.db, "enlace de mis datos", "arco_access_grant", async () => {
      const { rows } = await this.db.query<{ out_organization_id: string; out_property_id: string; out_folio: string; out_contact: string | null; out_org_slug: string; out_org_name: string }>(
        `select out_organization_id, out_property_id, out_folio, out_contact, out_org_slug, out_org_name from hoteles.arco_access_grant($1::uuid, $2::uuid);`,
        [requestId, guestId],
      );
      const r = rows[0];
      if (!r) throw new PrivacyNotFoundError("Solicitud");
      return { organizationId: r.out_organization_id, propertyId: r.out_property_id, folio: r.out_folio, contact: r.out_contact, orgSlug: r.out_org_slug, orgName: r.out_org_name };
    });
  }
}
