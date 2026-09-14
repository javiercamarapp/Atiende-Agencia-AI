// PostgresRentasOnboardingRepository -- adaptador de producción de
// `RentasOnboardingRepository`, sobre el `TenantDbSession` genérico de
// `@atiende/core-tenancy` (mismo contrato que `PostgresRentasRepository`/
// `PostgresRentasOwnerPortalRepository`).
//
// ADVERTENCIA DE PRIVILEGIO (léase antes de wirear esto a producción real) -- ver
// ./repository.ts para el detalle completo del gap y su solución real conocida
// (función `security definer`, mismo patrón que `core.accept_staff_invite`):
// `core.organization`/`core.property`/`core.staff_user`/`core.membership` NUNCA
// otorgan insert/update/delete a `authenticated`, solo a `service_role`
// (packages/db/migrations/0001_core_schema.sql). `rentas.organization_perfil`/
// `rentas.property_config`/`rentas.owner`/`rentas.owner_organization` tienen la misma
// restricción (packages/domain-rentas/migrations/001_rentas_schema.sql, línea de
// grants). Este adaptador debe construirse sobre una sesión de privilegio
// administrativo (equivalente a `ManagedPostgresEngine.admin`, o mejor, sobre una
// función `security definer` que no dependa de aprovisionar `service_role` como
// conexión de aplicación) -- NUNCA sobre la sesión RLS por-request normal que abre
// `dbSession`/`withAppSession({userId: null}, ...)`.
//
// Las sentencias SQL de abajo son reales y correctas contra el esquema ya migrado
// (0001_core_schema.sql / domain-rentas/migrations/001_rentas_schema.sql) -- este
// archivo no es un stub ni un mock, es el código que correrá el día que la sesión de
// privilegio exista. Hoy NO está conectado a producción (`notProductionReady`, ver
// apps/api/src/production/rentas-onboarding-repository.ts) para no fingir una
// garantía de escritura que el rol real de la conexión no tiene -- intentar usarlo
// contra la sesión RLS normal de hoy falla con "permission denied for table
// organization" (o silenciosamente 0 filas si algún día alguien afloja el RLS sin
// tocar el GRANT, razón de más para nunca conectarlo así).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { RentasDomainError } from "../errors.ts";
import type { NuevoTenantRentasInput, ResultadoRegistroTenantRentas } from "./tipos.ts";
import type { RentasOnboardingRepository } from "./repository.ts";

const MAX_INTENTOS_SLUG = 20; // mismo orden de magnitud que cualquier retry de colisión de slug en el resto de plataformas reales -- más que suficiente para un candidato ya derivado de un nombre real.

/** SQLSTATE `unique_violation` -- mismo criterio de detección que
 * `../ejecutor.ts::esViolacionExclusion` (23P01), aplicado aquí a `23505`. */
function esViolacionUnicidad(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

function esViolacionUnicidadDeColumna(error: unknown, columna: string): boolean {
  if (!esViolacionUnicidad(error)) return false;
  const detalle = (error as { constraint?: unknown; detail?: unknown }).constraint ?? (error as { detail?: unknown }).detail;
  return typeof detalle === "string" && detalle.includes(columna);
}

export class PostgresRentasOnboardingRepository implements RentasOnboardingRepository {
  constructor(private readonly db: TenantDbSession) {}

  async registrarTenant(input: NuevoTenantRentasInput): Promise<ResultadoRegistroTenantRentas> {
    const slug = await this.crearOrganizacionConSlugLibre(input);
    return this.completarRegistro(input, slug.organizationId, slug.slug);
  }

  /** Reintenta con un sufijo numérico incremental si `slugPropuesto` ya existe --
   * mismo criterio documentado en ./repository.ts ("nunca falla el registro completo
   * por un choque de slug"). Cada intento es un INSERT propio (no un
   * `SELECT ... FOR UPDATE` previo): más simple y sin ventana de carrera, apoyado en
   * la propia restricción `unique` de `core.organization.slug` como árbitro final. */
  private async crearOrganizacionConSlugLibre(input: NuevoTenantRentasInput): Promise<{ organizationId: string; slug: string }> {
    for (let intento = 1; intento <= MAX_INTENTOS_SLUG; intento += 1) {
      const candidato = intento === 1 ? input.organizacion.slugPropuesto : `${input.organizacion.slugPropuesto}-${intento}`;
      try {
        const { rows } = await this.db.query<{ id: string }>(
          `insert into core.organization (vertical, name, slug, status)
           values ('rentas', $1, $2, 'trial')
           returning id;`,
          [input.organizacion.nombre, candidato],
        );
        return { organizationId: rows[0]!.id, slug: candidato };
      } catch (error) {
        if (esViolacionUnicidadDeColumna(error, "slug")) continue;
        throw error;
      }
    }
    throw new RentasDomainError("onboarding_organizacion_duplicada", `No se pudo derivar un slug libre a partir de "${input.organizacion.slugPropuesto}" tras ${MAX_INTENTOS_SLUG} intentos.`);
  }

  private async completarRegistro(input: NuevoTenantRentasInput, organizationId: string, slug: string): Promise<ResultadoRegistroTenantRentas> {
    const { rows: filaProperty } = await this.db.query<{ id: string }>(
      `insert into core.property (organization_id, name, status)
       values ($1, $2, 'active')
       returning id;`,
      [organizationId, input.primeraPropiedad.nombre],
    );
    const propertyId = filaProperty[0]!.id;

    let staffId: string;
    try {
      const { rows: filaStaff } = await this.db.query<{ id: string }>(
        `insert into core.staff_user (email, password_hash, full_name, created_via, email_verified_at)
         values ($1, $2, $3, 'registro_autoservicio', null)
         returning id;`,
        [input.admin.correo, input.admin.passwordHash, input.admin.nombreCompleto],
      );
      staffId = filaStaff[0]!.id;
    } catch (error) {
      if (esViolacionUnicidadDeColumna(error, "email")) {
        throw new RentasDomainError("onboarding_organizacion_duplicada", `Ya existe una cuenta registrada con el correo "${input.admin.correo}".`);
      }
      throw error;
    }

    await this.db.query(
      `insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
       values ($1, $2, null, 'owner', 'admin_gestora');`,
      [staffId, organizationId],
    );

    await this.db.query(
      `insert into rentas.organization_perfil (organization_id, tipo)
       values ($1, $2);`,
      [organizationId, input.organizacion.tipoOrganizacion],
    );
    await this.db.query(
      `insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda)
       values ($1, $2, $3, $4);`,
      [propertyId, organizationId, input.primeraPropiedad.zonaHoraria, input.primeraPropiedad.moneda],
    );

    if (input.primerOwner) {
      const { rows: filaOwner } = await this.db.query<{ id: string }>(
        `insert into rentas.owner (name, email)
         values ($1, $2)
         returning id;`,
        [input.primerOwner.nombre, input.primerOwner.email ?? null],
      );
      await this.db.query(
        `insert into rentas.owner_organization (owner_id, organization_id)
         values ($1, $2);`,
        [filaOwner[0]!.id, organizationId],
      );
    }

    return { organizationId, propertyId, staffId, slug, requiereVerificacionCorreo: true };
  }
}
