// Indice de fixtures por vertical. Una ruta que no aparezca aqui responde 404 honesto (`mock_sin_fixture`) y queda
// marcada `sinFixture` en el registro de peticiones: es el listado de pendientes de cobertura, no un error de la SPA.
import type { Ruta } from "../tipos.ts";
import { rutasCitas } from "./citas.ts";
import { rutasCitasQa, rutasCitasQaAdmin, rutasCitasQaAgente } from "./citas-qa.ts";
import { rutasComunes } from "./comun.ts";
import { rutasCuenta } from "./cuenta.ts";
import { rutasDespachos } from "./despachos.ts";
import { rutasDespachosListados } from "./despachos-listados.ts";
import { rutasHoteles } from "./hoteles.ts";
import { rutasLicitaciones } from "./licitaciones.ts";
import { rutasLicitacionesBitacora } from "./licitaciones-bitacora.ts";
import { rutasLicitacionesDatosEmpresa } from "./licitaciones-datos-empresa.ts";
import { rutasRentas } from "./rentas.ts";
import { rutasRestaurantes } from "./restaurantes.ts";
import { rutasRestaurantesAutopiloto } from "./restaurantes-autopiloto.ts";
import { rutasRestaurantesPanel } from "./restaurantes-panel.ts";
import { rutasRestaurantesQaR2 } from "./restaurantes-qa-r2.ts";
import { rutasRestaurantesStorefront } from "./restaurantes-storefront.ts";
import { rutasSuperadmin } from "./superadmin.ts";

export const todasLasRutas: readonly Ruta[] = [...rutasComunes, ...rutasCuenta, ...rutasRestaurantes, ...rutasRestaurantesAutopiloto, ...rutasRestaurantesPanel, ...rutasRestaurantesQaR2, ...rutasRestaurantesStorefront, ...rutasHoteles, ...rutasRentas, ...rutasDespachos, ...rutasDespachosListados, ...rutasLicitacionesDatosEmpresa, ...rutasLicitacionesBitacora, ...rutasLicitaciones, ...rutasCitasQa, ...rutasCitasQaAdmin, ...rutasCitasQaAgente, ...rutasCitas, ...rutasSuperadmin];
