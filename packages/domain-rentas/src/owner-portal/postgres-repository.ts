// PostgresRentasOwnerPortalRepository -- adaptador de producción de
// `RentasOwnerPortalRepository`, sobre el `TenantDbSession` genérico de
// `@atiende/core-tenancy` (mismo contrato que `PostgresRentasRepository`).
//
// PRIVILEGIO DE `findOwnerCredentialByEmail`/`createPortalInvite`/`consumePortalInvite`
// (resuelto en la migración 013, `013_owner_portal_security_definer.sql` -- léela antes
// de tocar estos tres métodos): leen/escriben `rentas.owner_credential`, que la
// migración 006 NUNCA otorga en SELECT/INSERT/UPDATE a `authenticated` -- solo
// `service_role`, que este monorepo no aprovisiona todavía (`ManagedPostgresEngine.admin`
// es el MISMO rol de mínimo privilegio que `withAppSession`, ver comentario de cabecera
// de `packages/db/src/managed-postgres-engine.ts`). En vez de requerir esa pieza de
// infraestructura pendiente, estos tres métodos llaman 3 funciones SQL `security
// definer` (mismo criterio EXACTO que `core.accept_staff_invite`,
// `packages/db/migrations/0002_staff_invite_schema.sql`): corren con el privilegio del
// dueño de la función sobre la MISMA sesión por-request (`this.db`, `authenticated`,
// con o sin `auth.uid()` según el momento -- login/activación son pre-sesión, invitar
// corre con `auth.uid()` = staffId real), cada una haciendo su propia verificación de
// autorización (ver el SQL) en vez de confiar solo en la capa TS. Con esto, los 8
// métodos del puerto quedan completos contra Postgres real sin `service_role`.
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
    // Vía `rentas.find_owner_credential_by_email` (security definer, migración 013) --
    // `rentas.owner_credential` no otorga SELECT a `authenticated` (migración 006). La
    // función ya filtra `password_hash is not null` y devuelve a lo más 1 fila (ver
    // NOTA de higiene de datos en su propio SQL: rentas.owner.email sin índice único).
    const { rows } = await this.db.query<OwnerCredentialRow>(`select * from rentas.find_owner_credential_by_email($1);`, [email]);
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
    // Vía `rentas.create_owner_portal_invite` (security definer, migración 013) --
    // `created_by` NO se pasa como parámetro: la función lo toma de `auth.uid()`
    // (`input.createdBy` ya debe coincidir, viene del mismo staff autenticado, ver
    // owner-portal-invite.ts) y verifica ahí mismo que ese staff tenga acceso real a
    // una property donde `input.ownerId` tiene una unidad -- nunca confía solo en que
    // la ruta HTTP ya lo validó.
    await this.db.query(`select rentas.create_owner_portal_invite($1, $2, $3);`, [input.ownerId, input.tokenHash, input.expiresAt]);
  }

  async consumePortalInvite(input: ConsumePortalInviteInput): Promise<{ ownerId: string } | null> {
    // Vía `rentas.consume_owner_portal_invite` (security definer, migración 013) --
    // misma validación pending+no-expirado que el SQL que reemplaza, solo que ahora
    // corre con el privilegio necesario para tocar `rentas.owner_credential`.
    const { rows } = await this.db.query<{ owner_id: string }>(`select * from rentas.consume_owner_portal_invite($1, $2, $3::timestamptz);`, [
      input.tokenHash,
      input.passwordHash,
      input.now,
    ]);
    const row = rows[0];
    return row ? { ownerId: row.owner_id } : null;
  }
}
