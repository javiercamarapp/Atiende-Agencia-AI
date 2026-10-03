import type { RepositorioLlamadasVoz } from "@atiende/voice-core";
import type { VozCerrarConversacionInput, VozConversacionResumen, VozResultado } from "./types.ts";

/** Puerto de persistencia del backend de voz (migracion 025). Separado de
 * `RestaurantesRepository` a proposito: todo lo de voz degrada de forma uniforme cuando la base
 * no esta migrada (lecturas -> `disponible: false`; escrituras -> `VozNoDisponibleError`, que las
 * rutas traducen a 503), y nunca toca el resto del dominio. Es el contrato generico de `@atiende/voice-core`
 * (`RepositorioLlamadasVoz`) con los resultados y el pedido propios de restaurantes. */
export type VozRepository = RepositorioLlamadasVoz<VozResultado, VozConversacionResumen, VozCerrarConversacionInput>;
