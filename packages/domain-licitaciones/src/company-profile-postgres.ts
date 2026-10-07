// Adaptador Postgres del perfil de empresa completo (migracion 040) y de la procedencia por campo (REQ-142). Modulo aparte de
// `postgres-repository.ts` (3 000+ lineas) y delegado desde `PostgresLicitacionesRepository`.
//
// TRANSACCION: la sesion es UNA transaccion por request. Cada alta/edicion escribe el dato y despues su procedencia
// (`licitaciones.record_field_provenance`) en la MISMA sesion y sin tragar el error: si la procedencia falla, la excepcion sube,
// el request termina en error y la transaccion se revierte con el dato incluido (verificado contra Postgres real en
// `scripts/verify-licitaciones-perfil-empresa`, escenario 17).
//
// BASE SIN MIGRAR (42P01/42703/42883): las lecturas devuelven vacio honesto ([] o null); las escrituras de las tablas nuevas lanzan
// `CompanyProfileNotAvailableError` (la API responde 409 "no disponible aun"); la procedencia de las tablas anteriores simplemente no
// se registra (no hay donde). Todo dentro de `runWithSavepointFallback`: un try/catch simple dejaria la transaccion abortada (25P02).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { CompanyDataNotFoundError, CompanyProfileNotAvailableError } from "./errors.ts";
import type {
  CompanyLocationRecord,
  CompanyProductServiceRecord,
  CompanyProfileRecord,
  CompanyRestrictionRecord,
  CompanyStakeholderRecord,
  FieldProvenanceRecord,
  ProfileApprovalStatus,
  ProvenanceEntity,
  ProvenanceSource,
} from "./company-profile.ts";
import type { MipymeSector } from "./mipyme.ts";
import type {
  CompanyLocationCreateInput,
  CompanyLocationUpdateInput,
  CompanyProductServiceCreateInput,
  CompanyProductServiceUpdateInput,
  CompanyProfileCollectionKind,
  CompanyProfileUpsertInput,
  CompanyRestrictionCreateInput,
  CompanyRestrictionUpdateInput,
  CompanyStakeholderCreateInput,
  CompanyStakeholderUpdateInput,
} from "./repository.ts";

interface Authorship {
  approval_status: ProfileApprovalStatus;
  proposed_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
}
const AUTH_COLS = "approval_status, proposed_by, approved_by, approved_at::text as approved_at";
const authorship = (r: Authorship) => ({ approvalStatus: r.approval_status, proposedBy: r.proposed_by, approvedBy: r.approved_by, approvedAt: r.approved_at });

interface ProfileRow extends Authorship { id: string; legal_name: string; tax_id: string; trade_name: string | null; sector: MipymeSector | null; founded_year: number | null; employee_count: number | null; annual_sales_cents: string | number | null; website: string | null }
interface ProductRow extends Authorship { id: string; kind: CompanyProductServiceRecord["kind"]; name: string; description: string | null; classifier_code: string | null }
interface LocationRow extends Authorship { id: string; kind: CompanyLocationRecord["kind"]; name: string; state: string; municipality: string | null; address: string | null }
interface RestrictionRow extends Authorship { id: string; kind: CompanyRestrictionRecord["kind"]; description: string; valid_from: string; valid_until: string | null }
interface StakeholderRow extends Authorship { id: string; kind: CompanyStakeholderRecord["kind"]; full_name: string; rfc: string | null; participation_pct: string | null }

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

const mapProfile = (r: ProfileRow): CompanyProfileRecord => ({ id: r.id, legalName: r.legal_name, taxId: r.tax_id, tradeName: r.trade_name, sector: r.sector, foundedYear: r.founded_year, employeeCount: r.employee_count, annualSalesCents: num(r.annual_sales_cents), website: r.website, ...authorship(r) });
const mapProduct = (r: ProductRow): CompanyProductServiceRecord => ({ id: r.id, kind: r.kind, name: r.name, description: r.description, classifierCode: r.classifier_code, ...authorship(r) });
const mapLocation = (r: LocationRow): CompanyLocationRecord => ({ id: r.id, kind: r.kind, name: r.name, state: r.state, municipality: r.municipality, address: r.address, ...authorship(r) });
const mapRestriction = (r: RestrictionRow): CompanyRestrictionRecord => ({ id: r.id, kind: r.kind, description: r.description, validFrom: r.valid_from, validUntil: r.valid_until, ...authorship(r) });
const mapStakeholder = (r: StakeholderRow): CompanyStakeholderRecord => ({ id: r.id, kind: r.kind, fullName: r.full_name, rfc: r.rfc, participationPct: r.participation_pct, ...authorship(r) });

/** Configuracion por coleccion: tabla, entidad de procedencia, columnas y como mapear la fila. `columns` = clave de entrada -> columna SQL. */
interface CollectionConfig<R> {
  readonly table: string;
  readonly entity: ProvenanceEntity;
  readonly label: string;
  readonly columns: Readonly<Record<string, string>>;
  /** Columnas con casteo explicito en el INSERT/UPDATE. */
  readonly casts?: Readonly<Record<string, string>>;
  readonly select: string;
  readonly map: (row: never) => R;
  readonly orderBy: string;
}

const PRODUCT_CFG: CollectionConfig<CompanyProductServiceRecord> = {
  table: "company_product_service", entity: "product", label: "Producto o servicio", orderBy: "name asc",
  columns: { kind: "kind", name: "name", description: "description", classifierCode: "classifier_code" },
  select: `id, kind, name, description, classifier_code, ${AUTH_COLS}`, map: mapProduct as (row: never) => CompanyProductServiceRecord,
};
const LOCATION_CFG: CollectionConfig<CompanyLocationRecord> = {
  table: "company_location", entity: "location", label: "Ubicación", orderBy: "name asc",
  columns: { kind: "kind", name: "name", state: "state", municipality: "municipality", address: "address" },
  select: `id, kind, name, state, municipality, address, ${AUTH_COLS}`, map: mapLocation as (row: never) => CompanyLocationRecord,
};
const RESTRICTION_CFG: CollectionConfig<CompanyRestrictionRecord> = {
  table: "company_restriction", entity: "restriction", label: "Restricción", orderBy: "valid_from desc, created_at desc",
  columns: { kind: "kind", description: "description", validFrom: "valid_from", validUntil: "valid_until" },
  casts: { valid_from: "date", valid_until: "date" },
  select: `id, kind, description, valid_from::text as valid_from, valid_until::text as valid_until, ${AUTH_COLS}`, map: mapRestriction as (row: never) => CompanyRestrictionRecord,
};
const STAKEHOLDER_CFG: CollectionConfig<CompanyStakeholderRecord> = {
  table: "company_stakeholder", entity: "stakeholder", label: "Socio o representante", orderBy: "full_name asc",
  columns: { kind: "kind", fullName: "full_name", rfc: "rfc", participationPct: "participation_pct" },
  casts: { participation_pct: "numeric" },
  select: `id, kind, full_name, rfc, participation_pct::text as participation_pct, ${AUTH_COLS}`, map: mapStakeholder as (row: never) => CompanyStakeholderRecord,
};
const COLLECTIONS: Readonly<Record<CompanyProfileCollectionKind, CollectionConfig<unknown>>> = {
  product: PRODUCT_CFG as CollectionConfig<unknown>,
  location: LOCATION_CFG as CollectionConfig<unknown>,
  restriction: RESTRICTION_CFG as CollectionConfig<unknown>,
  stakeholder: STAKEHOLDER_CFG as CollectionConfig<unknown>,
};

const PROFILE_COLUMNS = { legalName: "legal_name", taxId: "tax_id", tradeName: "trade_name", sector: "sector", foundedYear: "founded_year", employeeCount: "employee_count", annualSalesCents: "annual_sales_cents", website: "website" } as const;
const PROFILE_SELECT = `id, legal_name, tax_id, trade_name, sector, founded_year, employee_count, annual_sales_cents, website, ${AUTH_COLS}`;

export class PostgresCompanyProfileStore {
  constructor(private readonly db: TenantDbSession) {}

  /**
   * REQ-142: registra quien capturo cada campo. `fields` = campos escritos en ESTA operacion (el registro completo `*` siempre se
   * escribe). Corre en la sesion del request; un error de Postgres sube (revierte el dato). Solo la ausencia de la funcion (base
   * sin migrar) se ignora: no hay donde guardar la procedencia.
   */
  async recordProvenance(organizationId: string, entity: ProvenanceEntity, entityId: string, fields: readonly string[], source: ProvenanceSource = "manual"): Promise<void> {
    await runWithSavepointFallback<void>({
      session: this.db,
      savepointName: "sp_licitaciones_record_provenance",
      primary: async () => {
        await this.db.query(`select licitaciones.record_field_provenance(auth.uid(), $1::uuid, $2, $3::uuid, $4::text[], $5);`, [organizationId, entity, entityId, [...fields], source]);
      },
      isRecoverable: (err) => isMigrationPendingError(err, "record_field_provenance"),
      fallback: async () => undefined,
    });
  }

  /** Procedencia de toda la organizacion. Base sin migrar: []. */
  async listFieldProvenance(organizationId: string): Promise<readonly FieldProvenanceRecord[]> {
    const rows = await runWithSavepointFallback<readonly { id: string; entity: ProvenanceEntity; entity_id: string; field: string; owner_user_id: string | null; source: ProvenanceSource; captured_at: string }[]>({
      session: this.db,
      savepointName: "sp_licitaciones_list_provenance",
      primary: async () =>
        (await this.db.query<{ id: string; entity: ProvenanceEntity; entity_id: string; field: string; owner_user_id: string | null; source: ProvenanceSource; captured_at: string }>(
          `select id, entity, entity_id, field, owner_user_id, source, captured_at::text as captured_at from licitaciones.field_provenance where organization_id = $1;`,
          [organizationId],
        )).rows,
      isRecoverable: isMigrationPendingError,
      fallback: async () => [],
    });
    return rows.map((r) => ({ id: r.id, entity: r.entity, entityId: r.entity_id, field: r.field, ownerUserId: r.owner_user_id ?? "", source: r.source, capturedAt: r.captured_at }));
  }

  /** `false` si falta la migracion 040 (la tabla del perfil no existe). Sin tocar datos. */
  async isAvailable(): Promise<boolean> {
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: "sp_licitaciones_profile_available",
      primary: async () => {
        await this.db.query(`select 1 from licitaciones.company_profile limit 0;`);
        return true;
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => false,
    });
  }

  // ---- Perfil general (uno por organizacion) ----

  async getProfile(organizationId: string): Promise<CompanyProfileRecord | null> {
    return runWithSavepointFallback<CompanyProfileRecord | null>({
      session: this.db,
      savepointName: "sp_licitaciones_get_profile",
      primary: async () => {
        const { rows } = await this.db.query<ProfileRow>(`select ${PROFILE_SELECT} from licitaciones.company_profile where organization_id = $1;`, [organizationId]);
        return rows[0] ? mapProfile(rows[0]) : null;
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => null,
    });
  }

  async upsertProfile(organizationId: string, input: CompanyProfileUpsertInput): Promise<CompanyProfileRecord> {
    const before = await this.getProfile(organizationId);
    const values: Record<string, unknown> = {
      legal_name: input.legalName,
      tax_id: input.taxId,
      trade_name: input.tradeName ?? null,
      sector: input.sector ?? null,
      founded_year: input.foundedYear ?? null,
      employee_count: input.employeeCount ?? null,
      annual_sales_cents: input.annualSalesCents ?? null,
      website: input.website ?? null,
    };
    const cols = Object.keys(values);
    const row = await runWithSavepointFallback<ProfileRow>({
      session: this.db,
      savepointName: "sp_licitaciones_upsert_profile",
      primary: async () => {
        const { rows } = await this.db.query<ProfileRow>(
          `insert into licitaciones.company_profile (organization_id, ${cols.join(", ")})
           values ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})
           on conflict (organization_id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}
           returning ${PROFILE_SELECT};`,
          [organizationId, ...cols.map((c) => values[c])],
        );
        return rows[0]!;
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => {
        throw new CompanyProfileNotAvailableError();
      },
    });
    const record = mapProfile(row);
    const changed = (Object.keys(PROFILE_COLUMNS) as (keyof typeof PROFILE_COLUMNS)[]).filter((k) => {
      const col = PROFILE_COLUMNS[k];
      return before === null || String((before as unknown as Record<string, unknown>)[k] ?? "") !== String(values[col] ?? "");
    });
    await this.recordProvenance(organizationId, "profile", record.id, changed);
    return record;
  }

  // ---- Colecciones (productos y servicios, ubicaciones, restricciones, socios) ----

  async list<R>(cfg: CollectionConfig<R>, organizationId: string): Promise<readonly R[]> {
    return runWithSavepointFallback<readonly R[]>({
      session: this.db,
      savepointName: `sp_licitaciones_list_${cfg.table}`,
      primary: async () => {
        const { rows } = await this.db.query<Authorship>(`select ${cfg.select} from licitaciones.${cfg.table} where organization_id = $1 order by ${cfg.orderBy};`, [organizationId]);
        return rows.map((r) => cfg.map(r as never));
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => [],
    });
  }

  async create<R extends { id: string }>(cfg: CollectionConfig<R>, organizationId: string, input: Record<string, unknown>): Promise<R> {
    const keys = Object.keys(cfg.columns).filter((k) => input[k] !== undefined);
    const cols = keys.map((k) => cfg.columns[k]!);
    const row = await runWithSavepointFallback<Authorship>({
      session: this.db,
      savepointName: `sp_licitaciones_create_${cfg.table}`,
      primary: async () => {
        const { rows } = await this.db.query<Authorship>(
          `insert into licitaciones.${cfg.table} (organization_id, ${cols.join(", ")})
           values ($1, ${cols.map((c, i) => `$${i + 2}${cfg.casts?.[c] ? `::${cfg.casts[c]}` : ""}`).join(", ")})
           returning ${cfg.select};`,
          [organizationId, ...keys.map((k) => input[k])],
        );
        return rows[0]!;
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => {
        throw new CompanyProfileNotAvailableError();
      },
    });
    const record = cfg.map(row as never);
    await this.recordProvenance(organizationId, cfg.entity, record.id, keys);
    return record;
  }

  async update<R extends { id: string }>(cfg: CollectionConfig<R>, organizationId: string, id: string, input: Record<string, unknown>): Promise<R> {
    const keys = Object.keys(cfg.columns).filter((k) => input[k] !== undefined);
    const cols = keys.map((k) => cfg.columns[k]!);
    const row = await runWithSavepointFallback<Authorship | undefined>({
      session: this.db,
      savepointName: `sp_licitaciones_update_${cfg.table}`,
      primary: async () => {
        if (keys.length === 0) {
          return (await this.db.query<Authorship>(`select ${cfg.select} from licitaciones.${cfg.table} where id = $1::uuid and organization_id = $2;`, [id, organizationId])).rows[0];
        }
        const { rows } = await this.db.query<Authorship>(
          `update licitaciones.${cfg.table} set ${cols.map((c, i) => `${c} = $${i + 3}${cfg.casts?.[c] ? `::${cfg.casts[c]}` : ""}`).join(", ")}
           where id = $1::uuid and organization_id = $2
           returning ${cfg.select};`,
          [id, organizationId, ...keys.map((k) => input[k])],
        );
        return rows[0];
      },
      isRecoverable: isMigrationPendingError,
      fallback: async () => {
        throw new CompanyProfileNotAvailableError();
      },
    });
    if (!row) throw new CompanyDataNotFoundError(cfg.label, id);
    const record = cfg.map(row as never);
    if (keys.length > 0) await this.recordProvenance(organizationId, cfg.entity, record.id, keys);
    return record;
  }

  async remove(kind: CompanyProfileCollectionKind, organizationId: string, id: string): Promise<boolean> {
    const cfg = COLLECTIONS[kind];
    return runWithSavepointFallback<boolean>({
      session: this.db,
      savepointName: `sp_licitaciones_delete_${cfg.table}`,
      primary: async () => (await this.db.query<{ id: string }>(`delete from licitaciones.${cfg.table} where id = $1::uuid and organization_id = $2 returning id;`, [id, organizationId])).rows.length > 0,
      isRecoverable: isMigrationPendingError,
      fallback: async () => {
        throw new CompanyProfileNotAvailableError();
      },
    });
  }

  listProducts(o: string) { return this.list(PRODUCT_CFG, o); }
  createProduct(o: string, i: CompanyProductServiceCreateInput) { return this.create(PRODUCT_CFG, o, { ...i }); }
  updateProduct(o: string, id: string, i: CompanyProductServiceUpdateInput) { return this.update(PRODUCT_CFG, o, id, { ...i }); }
  listLocations(o: string) { return this.list(LOCATION_CFG, o); }
  createLocation(o: string, i: CompanyLocationCreateInput) { return this.create(LOCATION_CFG, o, { ...i }); }
  updateLocation(o: string, id: string, i: CompanyLocationUpdateInput) { return this.update(LOCATION_CFG, o, id, { ...i }); }
  listRestrictions(o: string) { return this.list(RESTRICTION_CFG, o); }
  createRestriction(o: string, i: CompanyRestrictionCreateInput) { return this.create(RESTRICTION_CFG, o, { ...i }); }
  updateRestriction(o: string, id: string, i: CompanyRestrictionUpdateInput) { return this.update(RESTRICTION_CFG, o, id, { ...i }); }
  listStakeholders(o: string) { return this.list(STAKEHOLDER_CFG, o); }
  createStakeholder(o: string, i: CompanyStakeholderCreateInput) { return this.create(STAKEHOLDER_CFG, o, { ...i }); }
  updateStakeholder(o: string, id: string, i: CompanyStakeholderUpdateInput) { return this.update(STAKEHOLDER_CFG, o, id, { ...i }); }
}
