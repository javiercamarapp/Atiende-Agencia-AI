// Doble del repositorio del checklist para los tests de ruta: datos sembrables por organizacion; `noDisponible` simula una base
// sin migrar (cada campo `null`). La SQL real vive en postgres-repository.ts y se prueba con AbortAwareFakeSession.
import type { DatosOnboardingRentasSinStaff, RentasOnboardingChecklistRepository } from "./repository.ts";

export const DATOS_ONBOARDING_VACIOS: DatosOnboardingRentasSinStaff = {
  unidades: 0,
  feeds: { activos: 0, enCuarentena: 0, sincronizados: 0 },
  unidadesConTarifaBase: 0,
  reglasComision: 0,
  propiedadesConAccesoActivo: 0,
  propietarios: 0,
  plantillasAprobadas: 0,
};

export class InMemoryRentasOnboardingChecklistRepository implements RentasOnboardingChecklistRepository {
  readonly porOrganizacion = new Map<string, DatosOnboardingRentasSinStaff>();
  /** Organizaciones que simulan una base sin migrar: todos los campos `null`. */
  readonly noDisponible = new Set<string>();

  async cargar(organizationId: string): Promise<DatosOnboardingRentasSinStaff> {
    if (this.noDisponible.has(organizationId)) {
      return { unidades: null, feeds: null, unidadesConTarifaBase: null, reglasComision: null, propiedadesConAccesoActivo: null, propietarios: null, plantillasAprobadas: null };
    }
    return this.porOrganizacion.get(organizationId) ?? DATOS_ONBOARDING_VACIOS;
  }
}
