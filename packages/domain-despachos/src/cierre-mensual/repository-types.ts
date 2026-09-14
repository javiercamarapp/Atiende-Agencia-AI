// Tipos de entrada/registro del repositorio de cierre mensual — separados de
// `engine.ts` (motor puro) porque estos SÍ llevan campos de persistencia
// (organizationId/propertyId/ids reales), igual que `types.ts` de
// migracion-catalogo separa `MapeoMigracionCuenta` (registro) de
// `ClasificacionCuentaOrigen` (resultado puro del motor).
import type { NuevaTareaCierre } from "./engine.ts";
import type { CloseTemplate } from "./types.ts";

export interface NewPeriodoCierreInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly anio: number;
  readonly mes: number;
  readonly template: CloseTemplate;
}

export { type NuevaTareaCierre };
