// PostgresRentasOnboardingRepository -- adaptador de producción de
// `RentasOnboardingRepository`, sobre el `TenantDbSession` genérico de
// `@atiende/core-tenancy` (mismo contrato que `PostgresRentasRepository`/
// `PostgresRentasOwnerPortalRepository`).
//
// Hallazgo de auditoría (severidad CRÍTICA, "el onboarding self-serve de rentas está
// bloqueado en producción") -- CERRADO: una sola llamada a
// `rentas.register_tenant_onboarding` (función `security definer`, ver
// `packages/domain-rentas/migrations/016_onboarding_security_definer.sql` para el
// detalle completo de por qué esto no necesita `service_role`) hace TODO el trabajo
// que antes intentaban 6 `INSERT` sueltos contra la sesión RLS normal (que siempre
// habrían fallado con "permission denied" en Postgres real): crea
// `core.organization`/`core.property`/`core.staff_user`/`core.membership`, resuelve
// la colisión de slug con reintento, y da de alta la configuración inicial de rentas
// (`organization_perfil`/`property_config`/`owner`/`owner_organization`) + al menos
// una `rentas.unidad`, todo atómico dentro de la propia función SQL.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { RentasDomainError } from "../errors.ts";
import type { NuevoTenantRentasInput, ResultadoRegistroTenantRentas } from "./tipos.ts";
import type { RentasOnboardingRepository } from "./repository.ts";

/** SQLSTATE que `rentas.register_tenant_onboarding` usa para "ya existe una cuenta
 * con ese correo" (ver el `raise exception ... using errcode = 'P0002'` de la
 * migración 016) -- mismo criterio de detección por código que
 * `packages/db/src/postgres-core-repository.ts::acceptStaffInvite` (P0001 de
 * `core.accept_staff_invite`). */
const SQLSTATE_CORREO_DUPLICADO = "P0002";

interface RegistroTenantRow {
  organization_id: string;
  property_id: string;
  staff_id: string;
  slug: string;
  unidad_ids: readonly string[] | null;
}

export class PostgresRentasOnboardingRepository implements RentasOnboardingRepository {
  constructor(private readonly db: TenantDbSession) {}

  async registrarTenant(input: NuevoTenantRentasInput): Promise<ResultadoRegistroTenantRentas> {
    const unidadesJson = JSON.stringify(input.primerasUnidades.map((u) => ({ nombre: u.nombre, duracion_minima_noches: u.duracionMinimaNoches ?? null })));

    try {
      const { rows } = await this.db.query<RegistroTenantRow>(
        `select * from rentas.register_tenant_onboarding($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb);`,
        [
          input.organizacion.nombre,
          input.organizacion.slugPropuesto,
          input.organizacion.tipoOrganizacion,
          input.primeraPropiedad.nombre,
          input.primeraPropiedad.zonaHoraria,
          input.primeraPropiedad.moneda,
          input.admin.correo,
          input.admin.passwordHash,
          input.admin.nombreCompleto,
          input.primerOwner?.nombre ?? null,
          input.primerOwner?.email ?? null,
          unidadesJson,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("rentas.register_tenant_onboarding no devolvió ninguna fila -- inalcanzable si la función no lanzó.");
      return {
        organizationId: row.organization_id,
        propertyId: row.property_id,
        staffId: row.staff_id,
        slug: row.slug,
        unidadIds: row.unidad_ids ?? [],
        requiereVerificacionCorreo: true,
      };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === SQLSTATE_CORREO_DUPLICADO) {
        throw new RentasDomainError("onboarding_organizacion_duplicada", `Ya existe una cuenta registrada con el correo "${input.admin.correo}".`);
      }
      // SQLSTATE P0003 -- 20 intentos de slug agotados (ver la migración): mismo
      // código de dominio que un correo duplicado, "conflicto de identidad pública",
      // nunca un dato de entrada malformado.
      if (code === "P0003") {
        const message = error instanceof Error ? error.message : String(error);
        throw new RentasDomainError("onboarding_organizacion_duplicada", message);
      }
      // Cualquier otro `raise exception ... using errcode = 'P0001'` de la función
      // (validación defensiva que ya corrió en captura.ts, pero la función SQL nunca
      // confía solo en que la capa TS validó) también es un dato inválido, no un
      // fallo de infraestructura.
      if (code === "P0001") {
        const message = error instanceof Error ? error.message : String(error);
        throw new RentasDomainError("onboarding_datos_invalidos", message);
      }
      throw error;
    }
  }
}
