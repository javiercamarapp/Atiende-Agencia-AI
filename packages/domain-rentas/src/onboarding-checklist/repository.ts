// Rn-36 -- lectura de los conteos reales del checklist de onboarding de rentas. Solo SELECT de agregados, sin PII.
import type { DatosOnboardingRentas } from "./calculo.ts";

/** Lo que mide el repositorio; el conteo de staff lo aporta la ruta (vive en `core`, ver `coreStaffRepo`). */
export type DatosOnboardingRentasSinStaff = Omit<DatosOnboardingRentas, "staff">;

export interface RentasOnboardingChecklistRepository {
  /** Cada campo es `null` si la base no tiene la tabla/columna (migracion pendiente) o el rol no puede leerla. Nunca lanza por eso. */
  cargar(organizationId: string): Promise<DatosOnboardingRentasSinStaff>;
}
