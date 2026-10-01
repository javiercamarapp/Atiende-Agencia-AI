import type { VozAlerta, VozKpiDia, VozUmbrales, VozUmbralesEntrada } from "./kpi.ts";
import type { VozLectura } from "./types.ts";

/** Puerto de persistencia de KPI/alertas de voz (migracion 035). Separado de `VozRepository` a proposito: degrada
 * de forma uniforme cuando la base no esta migrada (lecturas -> `disponible: false`; escrituras ->
 * `VozNoDisponibleError`, que las rutas traducen a 503) y no toca el resto del backend de voz. */
export interface VozKpiRepository {
  /** KPI por dia LOCAL de la sucursal, de `desde` a `hasta` (YYYY-MM-DD, inclusive, maximo 63 dias). Un dia sin
   * llamadas aparece con ceros. Solo owner/admin con alcance a la sucursal (la base lo exige). */
  getKpisDiarios(organizationId: string, propertyId: string, desde: string, hasta: string): Promise<VozLectura<readonly VozKpiDia[]>>;
  getUmbrales(propertyId: string): Promise<VozLectura<VozUmbrales>>;
  /** Reemplaza los umbrales de la sucursal. `VozNoDisponibleError` si la base no esta migrada; `VozRechazadaError` si RLS lo niega. */
  upsertUmbrales(organizationId: string, propertyId: string, actorUserId: string, entrada: VozUmbralesEntrada): Promise<VozUmbrales>;
  /** Compara HOY (dia local) con los umbrales, registra las alertas nuevas (y su linea en la bitacora) y devuelve las de hoy. */
  evaluarAlertas(organizationId: string, propertyId: string): Promise<VozLectura<readonly VozAlerta[]>>;
  /** Alertas ya disparadas, mas recientes primero. */
  listAlertas(organizationId: string, propertyId: string, limite: number): Promise<VozLectura<readonly VozAlerta[]>>;
}
