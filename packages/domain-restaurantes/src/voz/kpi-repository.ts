import type { RepositorioKpiVoz } from "@atiende/voice-core";

/** Puerto de persistencia de KPI/alertas de voz (migracion 035). Separado de `VozRepository` a proposito: degrada
 * de forma uniforme cuando la base no esta migrada (lecturas -> `disponible: false`; escrituras ->
 * `VozNoDisponibleError`, que las rutas traducen a 503) y no toca el resto del backend de voz. Es el contrato generico
 * de `@atiende/voice-core` (`RepositorioKpiVoz`). */
export type VozKpiRepository = RepositorioKpiVoz;
