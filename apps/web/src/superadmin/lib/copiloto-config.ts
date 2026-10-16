// Configuracion del Copiloto de PLATAFORMA (superadmin) con la forma que consume `ChatDatosShell`. Los datos viven en `copiloto-datos.ts` (sin importar la UI, para que la
// prueba del API los valide contra el catalogo real); aqui solo se tipan.
import type { CopilotoConfigVertical } from "../../lib/copiloto/config/tipos.ts";
import { DATOS_COPILOTO_SUPERADMIN } from "./copiloto-datos.ts";

export { DIRECTAS_COPILOTO_SUPERADMIN, SUGERENCIAS_COPILOTO_SUPERADMIN } from "./copiloto-datos.ts";

export const COPILOTO_SUPERADMIN: CopilotoConfigVertical = DATOS_COPILOTO_SUPERADMIN;
