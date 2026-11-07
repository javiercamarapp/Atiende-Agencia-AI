/** Restaurantes, grupo «autopiloto»: aprobaciones, programados, reglas del autopiloto y lo que rodea a Pedidos (historial, comandas al POS, conversaciones, callbacks y avisos). Un PR por grupo edita SOLO este archivo (y su par en en/), sin chocar con los demas. */
import type { restaurantesAutopiloto } from "../autopiloto.ts";
import type { restaurantesHistorial } from "../historial.ts";
import type { restaurantesComandas } from "../comandas.ts";
import type { restaurantesConversaciones } from "../conversaciones.ts";
import type { restaurantesAvisos } from "../avisos.ts";

export interface ModulosRestaurantesAutopiloto {
  readonly restaurantesAutopiloto: typeof restaurantesAutopiloto;
  readonly restaurantesHistorial: typeof restaurantesHistorial;
  readonly restaurantesComandas: typeof restaurantesComandas;
  readonly restaurantesConversaciones: typeof restaurantesConversaciones;
  readonly restaurantesAvisos: typeof restaurantesAvisos;
}
