/** Restaurantes, grupo «cfo»: CFO. Un PR por grupo edita SOLO este archivo (y su par en en/), sin chocar con los demas. */
import type { restaurantesCfo } from "../cfo.ts";
import type { restaurantesCfoResumen } from "../cfoResumen.ts";
import type { restaurantesCfoVentas } from "../cfoVentas.ts";
import type { restaurantesCfoPlatillos } from "../cfoPlatillos.ts";
import type { restaurantesCfoResultados } from "../cfoResultados.ts";
import type { restaurantesCfoClientes } from "../cfoClientes.ts";
import type { restaurantesCfoCostos } from "../cfoCostos.ts";

export interface ModulosRestaurantesCfo {
  readonly restaurantesCfo: typeof restaurantesCfo;
  readonly restaurantesCfoResumen: typeof restaurantesCfoResumen;
  readonly restaurantesCfoVentas: typeof restaurantesCfoVentas;
  readonly restaurantesCfoPlatillos: typeof restaurantesCfoPlatillos;
  readonly restaurantesCfoResultados: typeof restaurantesCfoResultados;
  readonly restaurantesCfoClientes: typeof restaurantesCfoClientes;
  readonly restaurantesCfoCostos: typeof restaurantesCfoCostos;
}
