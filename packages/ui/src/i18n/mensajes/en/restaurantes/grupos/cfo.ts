/** Ingles del grupo «cfo» de restaurantes (ver mensajes/restaurantes/grupos/cfo.ts). */
import { restaurantesCfoEn } from "../cfo.ts";
import { restaurantesCfoResumenEn } from "../cfoResumen.ts";
import { restaurantesCfoVentasEn } from "../cfoVentas.ts";
import { restaurantesCfoPlatillosEn } from "../cfoPlatillos.ts";
import { restaurantesCfoResultadosEn } from "../cfoResultados.ts";
import { restaurantesCfoClientesEn } from "../cfoClientes.ts";
import { restaurantesCfoCostosEn } from "../cfoCostos.ts";

export const EN_RESTAURANTES_CFO = {
  restaurantesCfo: restaurantesCfoEn,
  restaurantesCfoResumen: restaurantesCfoResumenEn,
  restaurantesCfoVentas: restaurantesCfoVentasEn,
  restaurantesCfoPlatillos: restaurantesCfoPlatillosEn,
  restaurantesCfoResultados: restaurantesCfoResultadosEn,
  restaurantesCfoClientes: restaurantesCfoClientesEn,
  restaurantesCfoCostos: restaurantesCfoCostosEn,
} as const;
