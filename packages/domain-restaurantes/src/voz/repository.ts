import type { RepositorioLlamadasVoz } from "@atiende/voice-core";
import type { VozCerrarConversacionInput, VozConversacionResumen, VozResultado } from "./types.ts";

/** Puerto de persistencia del backend de voz (migracion 025). Separado de
 * `RestaurantesRepository` a proposito: todo lo de voz degrada de forma uniforme cuando la base
 * no esta migrada (lecturas -> `disponible: false`; escrituras -> `VozNoDisponibleError`, que las
 * rutas traducen a 503), y nunca toca el resto del dominio. Es el contrato generico de `@atiende/voice-core`
 * (`RepositorioLlamadasVoz`) con los resultados y el pedido propios de restaurantes. */
export type VozRepository = RepositorioLlamadasVoz<VozResultado, VozConversacionResumen, VozCerrarConversacionInput> & VozTelefonoRepositorio;

/** Voz TELEFONICA de la sucursal (ElevenLabs, migracion 103 `branch_voice_config.tts_voice_id`). Opcional: un adaptador sin estos metodos = "no disponible aun". */
export interface VozTelefonoRepositorio {
  /** Voz guardada; `disponible: false` con la base sin la 103 (el worker usa la de la plataforma). */
  getVozTelefono?(propertyId: string): Promise<{ readonly disponible: boolean; readonly valor: string | null }>;
  /** Guarda (o borra con null) la voz de una sucursal que YA tiene fila de configuracion. `false` = no habia fila (guarde antes la configuracion de voz).
   * Base sin la 103 -> `VozNoDisponibleError` (503 honesto). */
  setVozTelefono?(organizationId: string, propertyId: string, voz: string | null): Promise<boolean>;
}
