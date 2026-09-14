// InMemoryRentasOnboardingRepository -- implementación real (no un mock) de
// `RentasOnboardingRepository`, autocontenida (mismo criterio que
// ../owner-portal/in-memory-repository.ts): modela su propio recorte de
// `core.organization`/`core.property`/`core.staff_user`/`core.membership`/
// `rentas.organization_perfil`/`rentas.property_config`/`rentas.owner`/
// `rentas.owner_organization`, sin depender de `InMemoryCoreRepository` ni de
// `InMemoryRentasTenancyEngine`. Es lo que permite probar de verdad la lógica de
// negocio (resolución de colisión de slug, rechazo de correo duplicado) sin Postgres
// -- ver ./postgres-repository.ts para el equivalente real de producción (bloqueado
// hoy por el gap de plataforma documentado en ./repository.ts).
import { randomUUID } from "node:crypto";
import { RentasDomainError } from "../errors.ts";
import type { NuevoTenantRentasInput, ResultadoRegistroTenantRentas } from "./tipos.ts";
import type { RentasOnboardingRepository } from "./repository.ts";

interface StoredOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly tipoOrganizacion: "anfitrion" | "empresa_gestora";
}

interface StoredProperty {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly zonaHoraria: string;
  readonly moneda: string;
}

interface StoredStaff {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly passwordHash: string;
  readonly organizationId: string;
}

interface StoredOwner {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly organizationIds: string[];
}

export class InMemoryRentasOnboardingRepository implements RentasOnboardingRepository {
  private readonly organizaciones = new Map<string, StoredOrganization>();
  private readonly propiedades = new Map<string, StoredProperty>();
  private readonly staffPorId = new Map<string, StoredStaff>();
  private readonly staffPorCorreo = new Map<string, StoredStaff>();
  private readonly owners = new Map<string, StoredOwner>();

  /** Mismo criterio de resolución de colisión que documenta ./repository.ts: nunca
   * falla el registro completo por un choque de slug, apenda un sufijo numérico
   * incremental hasta encontrar uno libre. */
  private resolverSlugLibre(candidato: string): string {
    if (!this.estaOcupado(candidato)) return candidato;
    let intento = 2;
    while (this.estaOcupado(`${candidato}-${intento}`)) intento += 1;
    return `${candidato}-${intento}`;
  }

  private estaOcupado(slug: string): boolean {
    for (const org of this.organizaciones.values()) {
      if (org.slug === slug) return true;
    }
    return false;
  }

  async registrarTenant(input: NuevoTenantRentasInput): Promise<ResultadoRegistroTenantRentas> {
    if (this.staffPorCorreo.has(input.admin.correo)) {
      throw new RentasDomainError("onboarding_organizacion_duplicada", `Ya existe una cuenta registrada con el correo "${input.admin.correo}".`);
    }

    const slug = this.resolverSlugLibre(input.organizacion.slugPropuesto);
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const staffId = randomUUID();

    this.organizaciones.set(organizationId, {
      id: organizationId,
      slug,
      name: input.organizacion.nombre,
      tipoOrganizacion: input.organizacion.tipoOrganizacion,
    });
    this.propiedades.set(propertyId, {
      id: propertyId,
      organizationId,
      name: input.primeraPropiedad.nombre,
      zonaHoraria: input.primeraPropiedad.zonaHoraria,
      moneda: input.primeraPropiedad.moneda,
    });
    const staff: StoredStaff = {
      id: staffId,
      email: input.admin.correo,
      fullName: input.admin.nombreCompleto,
      passwordHash: input.admin.passwordHash,
      organizationId,
    };
    this.staffPorId.set(staffId, staff);
    this.staffPorCorreo.set(staff.email, staff);

    if (input.primerOwner) {
      const ownerId = randomUUID();
      this.owners.set(ownerId, {
        id: ownerId,
        name: input.primerOwner.nombre,
        email: input.primerOwner.email ?? null,
        organizationIds: [organizationId],
      });
    }

    return { organizationId, propertyId, staffId, slug, requiereVerificacionCorreo: true };
  }

  // ---- Accesores de solo-lectura para pruebas (mismo criterio que
  // `InMemoryRentasOwnerPortalRepository`: exponer lo mínimo para que un test pueda
  // verificar EFECTOS reales, no solo el valor de retorno). ----

  findOrganizacionById(id: string): StoredOrganization | undefined {
    return this.organizaciones.get(id);
  }

  findPropiedadById(id: string): StoredProperty | undefined {
    return this.propiedades.get(id);
  }

  findStaffByEmail(email: string): StoredStaff | undefined {
    return this.staffPorCorreo.get(email);
  }

  listOwnersDeOrganizacion(organizationId: string): readonly StoredOwner[] {
    return [...this.owners.values()].filter((owner) => owner.organizationIds.includes(organizationId));
  }
}
