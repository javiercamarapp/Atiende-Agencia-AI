// PL-23 -- unico punto por donde las rutas admin de catalogo/promociones/sucursales exigen rol: piden una ACCION de la matriz de
// `@atiende/domain-restaurantes` (roles.ts) en vez de una lista suelta de roles. Fail-closed: una accion fuera de la matriz niega a
// todos. El 403 lleva un mensaje claro por accion para que el panel pueda mostrarlo tal cual.
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { puedeEjecutar } from "@atiende/domain-restaurantes";
import type { AccionRestaurantes } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";

const MENSAJE_POR_ACCION: Partial<Record<AccionRestaurantes, string>> = {
  "catalogo.precio": "Solo el dueño o un administrador puede cambiar precios y editar el catálogo.",
  "promociones.ver": "Solo el dueño o un administrador puede ver las promociones.",
  "promociones.editar": "Solo el dueño o un administrador puede crear o cambiar promociones.",
  "sucursal.editar": "Solo el dueño o un administrador puede editar los datos de la sucursal.",
};

export function assertAccion(c: Context<CoreAuthHonoEnv>, accion: AccionRestaurantes): void {
  if (puedeEjecutar(c.get("verticalRole"), accion)) return;
  throw Errors.forbidden(MENSAJE_POR_ACCION[accion] ?? `Tu rol (${c.get("verticalRole") ?? "sin resolver"}) no puede realizar esta acción.`);
}
