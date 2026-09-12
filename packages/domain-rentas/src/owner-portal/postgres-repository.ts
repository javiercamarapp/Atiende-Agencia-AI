// PostgresRentasOwnerPortalRepository -- adaptador de producción de
// `RentasOwnerPortalRepository`, sobre el `TenantDbSession` genérico de
// `@atiende/core-tenancy` (mismo contrato que `PostgresRentasRepository`).
//
// ADVERTENCIA DE PRIVILEGIO (léase antes de wirear esto a producción real):
// `findOwnerCredentialByEmail`/`createPortalInvite`/`consumePortalInvite` leen/escriben
// `rentas.owner_credential`, que la migración 006 NUNCA otorga en SELECT/INSERT/UPDATE
// a `authenticated` -- solo `service_role`. Estos tres métodos deben construirse sobre
// una sesión de privilegio administrativo (equivalente a
// `ManagedPostgresEngine.admin`), NUNCA sobre la sesión RLS por-request que abre
// `requireRentasOwnerSession` (`c.get("db")`, usada por los otros cinco métodos) --
// exactamente el mismo criterio ya documentado para `core.staff_user` en
// `@atiende/db::PostgresCoreRepository`/`apps/api/src/production/core-repository.ts`
// ("login ocurre ANTES de que exista una sesión autenticada -- no hay auth.uid() que
// las policies puedan evaluar todavía").
//
// Esta clase, como el resto de `rentasRepo` (Fase 1/2), NO está conectada a Postgres
// real en este repo todavía (`notProductionReady`, ver
// apps/api/src/production/deps.ts) -- se documenta el requisito de privilegio para
// cuando esa conexión se construya, no se finge una garantía que no existe hoy.
import type { TenantDbSession } from "@atiende/core-tenancy";
import type {
  ConsumePortalInviteInput,
  FiltroOwnerPortalStatements,
  NewPortalInviteInput,
  OwnerCredentialForLogin,
  OwnerPortalOrganizacion,
  OwnerPortalProfileBase,
  OwnerPortalStatementDetalle,
  OwnerPortalStatementSummary,
  UnidadPropietarioRecord,
} from "./types.ts";
import type { RentasOwnerPortalRepository } from "./repository.ts";
import type { LineaOwnerStatement, TipoLineaOwnerStatement, TotalesOwnerStatement } from "../finanzas/statement.ts";

interface OwnerCredentialRow {
  owner_id: string;
  email: string;
  password_hash: string | null;
}

interface OwnerProfileRow {
  id: string;
  name: string;
  email: string | null;
}

interface OwnerOrganizacionRow {
  organization_id: string;
  name: string;
  slug: string;
}

interface UnidadPropietarioRow {
  id: string;
  name: string;
  property_id: string;
  organization_id: string;
  organization_name: string;
}

interface StatementSummaryRow {
  id: string;
  property_id: string;
  organization_id: string;
  organization_name: string;
  periodo_inicio: string;
  periodo_fin: string;
  version: number;
  moneda: string;
  neto_centavos: string;
}

interface StatementDetalleRow extends StatementSummaryRow {
  ingresos_brutos_centavos: string;
  comision_canal_centavos: string;
  comision_gestor_centavos: string;
  gastos_centavos: string;
  impuestos_centavos: string;
  motivo_version: string | null;
}

function mapSummary(row: StatementSummaryRow, generadoEn: string): OwnerPortalStatementSummary {
  return {
    id: row.id,
    propertyId: row.property_id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    periodo: { inicio: row.periodo_inicio, fin: row.periodo_fin },
    version: row.version,
    moneda: row.moneda,
    netoCentavos: Number(row.neto_centavos),
    generadoEn,
  };
}

export class PostgresRentasOwnerPortalRepository implements RentasOwnerPortalRepository {
  constructor(private readonly db: TenantDbSession) {}

  async findOwnerCredentialByEmail(email: string): Promise<OwnerCredentialForLogin | null> {
    // NOTA: rentas.owner.email no tiene índice único -- si dos owners comparten
    // correo (dato mal capturado por staff), la primera fila con password_hash no
    // nulo gana; esto es un caso de higiene de datos, no de este diseño (ver §8).
    const { rows } = await this.db.query<OwnerCredentialRow>(
      `select oc.owner_id, o.email, oc.password_hash
       from rentas.owner_credential oc
       join rentas.owner o on o.id = oc.owner_id
       where lower(o.email) = lower($1) and oc.password_hash is not null
       limit 1;`,
      [email],
    );
    const row = rows[0];
    if (!row || !row.password_hash) return null;
    return { ownerId: row.owner_id, email: row.email, passwordHash: row.password_hash };
  }

  async findOwnerProfile(ownerId: string): Promise<OwnerPortalProfileBase | null> {
    const { rows } = await this.db.query<OwnerProfileRow>(`select id, name, email from rentas.owner where id = $1;`, [ownerId]);
    return rows[0] ?? null;
  }

  async listOwnerOrganizaciones(ownerId: string): Promise<readonly OwnerPortalOrganizacion[]> {
    const { rows } = await this.db.query<OwnerOrganizacionRow>(
      `select oo.organization_id, org.name, org.slug
       from rentas.owner_organization oo
       join core.organization org on org.id = oo.organization_id
       where oo.owner_id = $1
       order by org.name;`,
      [ownerId],
    );
    return rows.map((r) => ({ organizationId: r.organization_id, name: r.name, slug: r.slug }));
  }

  // Deliberadamente SIN WHERE owner_id = $1 -- el filtro real de fila es la RLS
  // (`owner_id = auth.uid()`, migración 006). `ownerId` se recibe igual que el resto
  // del monorepo (defensa en profundidad documentada, ver repository.ts), pero la
  // query en sí confía en que `this.db` ya es una sesión abierta para ESE ownerId
  // (`requireRentasOwnerSession` -> `engine.withAppSession({userId: ownerId})`) -- si
  // algún día se le pasara aquí una sesión de otro propietario por error, la RLS
  // seguiría devolviendo solo lo de la sesión real, nunca lo que `ownerId` diga.
  async listUnidadesPropietario(_ownerId: string): Promise<readonly UnidadPropietarioRecord[]> {
    const { rows } = await this.db.query<UnidadPropietarioRow>(
      `select u.id, u.name, u.property_id, u.organization_id, org.name as organization_name
       from rentas.unidad u
       join core.organization org on org.id = u.organization_id
       order by org.name, u.name;`,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, propertyId: r.property_id, organizationId: r.organization_id, organizationName: r.organization_name }));
  }

  async listOwnerStatementsPropietario(_ownerId: string, filtro: FiltroOwnerPortalStatements): Promise<readonly OwnerPortalStatementSummary[]> {
    const { rows } = await this.db.query<StatementSummaryRow & { generado_en: string }>(
      `select distinct on (os.property_id, os.periodo_inicio, os.periodo_fin)
              os.id, os.property_id, os.organization_id, org.name as organization_name,
              os.periodo_inicio::text as periodo_inicio, os.periodo_fin::text as periodo_fin,
              os.version, os.moneda, os.neto_centavos, os.generado_en::text as generado_en
       from rentas.owner_statement os
       join core.organization org on org.id = os.organization_id
       where ($1::uuid is null or os.property_id = $1)
         and ($2::date is null or os.periodo_inicio >= $2::date)
         and ($3::date is null or os.periodo_fin <= $3::date)
       order by os.property_id, os.periodo_inicio, os.periodo_fin, os.version desc;`,
      [filtro.propertyId ?? null, filtro.desde ?? null, filtro.hasta ?? null],
    );
    return rows.map((r) => mapSummary(r, r.generado_en)).sort((a, b) => (a.periodo.inicio < b.periodo.inicio ? 1 : a.periodo.inicio > b.periodo.inicio ? -1 : 0));
  }

  async findOwnerStatementDetallePropietario(_ownerId: string, statementId: string): Promise<OwnerPortalStatementDetalle | null> {
    const { rows } = await this.db.query<StatementDetalleRow & { generado_en: string }>(
      `select os.id, os.property_id, os.organization_id, org.name as organization_name,
              os.periodo_inicio::text as periodo_inicio, os.periodo_fin::text as periodo_fin,
              os.version, os.moneda, os.neto_centavos, os.ingresos_brutos_centavos, os.comision_canal_centavos,
              os.comision_gestor_centavos, os.gastos_centavos, os.impuestos_centavos, os.motivo_version,
              os.generado_en::text as generado_en
       from rentas.owner_statement os
       join core.organization org on org.id = os.organization_id
       where os.id = $1;`,
      [statementId],
    );
    const s = rows[0];
    if (!s) return null;

    const lineasResult = await this.db.query<{ ocupacion_id: string | null; tipo: TipoLineaOwnerStatement; descripcion: string; monto_centavos: string }>(
      `select ocupacion_id, tipo, descripcion, monto_centavos from rentas.owner_statement_linea where statement_id = $1 order by tipo, ocupacion_id;`,
      [statementId],
    );
    const lineas: LineaOwnerStatement[] = lineasResult.rows.map((l) => ({ ocupacionId: l.ocupacion_id ?? "", tipo: l.tipo, descripcion: l.descripcion, montoCentavos: Number(l.monto_centavos) }));
    const totales: TotalesOwnerStatement = {
      ingresosBrutosCentavos: Number(s.ingresos_brutos_centavos),
      comisionCanalCentavos: Number(s.comision_canal_centavos),
      comisionGestorCentavos: Number(s.comision_gestor_centavos),
      gastosCentavos: Number(s.gastos_centavos),
      impuestosCentavos: Number(s.impuestos_centavos),
      netoCentavos: Number(s.neto_centavos),
    };

    return { ...mapSummary(s, s.generado_en), totales, lineas, motivoVersion: s.motivo_version };
  }

  async createPortalInvite(input: NewPortalInviteInput): Promise<void> {
    // Requiere sesión de privilegio administrativo -- ver advertencia de cabecera.
    await this.db.query(
      `insert into rentas.owner_credential (owner_id, created_via, created_by, password_reset_token_hash, password_reset_expires_at)
       values ($1, 'invite', $2, $3, $4)
       on conflict (owner_id) do update set
         created_by = excluded.created_by,
         password_reset_token_hash = excluded.password_reset_token_hash,
         password_reset_expires_at = excluded.password_reset_expires_at;`,
      [input.ownerId, input.createdBy, input.tokenHash, input.expiresAt],
    );
  }

  async consumePortalInvite(input: ConsumePortalInviteInput): Promise<{ ownerId: string } | null> {
    // Requiere sesión de privilegio administrativo -- ver advertencia de cabecera.
    const { rows } = await this.db.query<{ owner_id: string }>(
      `update rentas.owner_credential
       set password_hash = $2, password_reset_token_hash = null, password_reset_expires_at = null
       where password_reset_token_hash = $1
         and password_reset_expires_at is not null
         and password_reset_expires_at > $3::timestamptz
       returning owner_id;`,
      [input.tokenHash, input.passwordHash, input.now],
    );
    const row = rows[0];
    return row ? { ownerId: row.owner_id } : null;
  }
}
