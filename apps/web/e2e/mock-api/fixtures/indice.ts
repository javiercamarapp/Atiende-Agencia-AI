// Indice de fixtures por vertical. Una ruta que no aparezca aqui responde 404 honesto (`mock_sin_fixture`) y queda
// marcada `sinFixture` en el registro de peticiones: es el listado de pendientes de cobertura, no un error de la SPA.
import type { Ruta } from "../tipos.ts";
import { rutasRestaurantes } from "./restaurantes.ts";

export const todasLasRutas: readonly Ruta[] = [...rutasRestaurantes];
