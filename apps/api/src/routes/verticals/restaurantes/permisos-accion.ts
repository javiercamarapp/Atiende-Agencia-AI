// PL-23 -- unico punto por donde las rutas admin de catalogo/promociones/sucursales exigen rol: piden una ACCION de la matriz de
// `@atiende/domain-restaurantes` (roles.ts) en vez de una lista suelta de roles. Fail-closed: una accion fuera de la matriz niega a
// todos. El 403 lleva un mensaje claro por accion para que el panel pueda mostrarlo tal cual.
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { puedeEjecutar } from "@atiende/domain-restaurantes";
import type { AccionOperador, AccionRestaurantes } from "@atiende/domain-restaurantes";
import type { AppDeps } from "../../../deps.ts";
import { Errors } from "../../../errors.ts";

const MENSAJE_POR_ACCION: Partial<Record<AccionRestaurantes, string>> = {
  "catalogo.precio": "Solo el dueño o un administrador puede cambiar precios y editar el catálogo.",
  "promociones.ver": "Solo el dueño o un administrador puede ver las promociones.",
  "promociones.editar": "Solo el dueño o un administrador puede crear o cambiar promociones.",
  "sucursal.editar": "Solo el dueño o un administrador puede editar los datos de la sucursal.",
  "cfo.ver": "Tu rol no tiene acceso al CFO.",
  "cfo.capturar": "Solo el dueño o un administrador puede capturar costos y configurar el CFO.",
  "cfo.importar_sr": "Solo el dueño o un administrador puede importar reportes de SoftRestaurant.",
  "cfo.exportar": "Solo el dueño o un administrador puede exportar el CFO.",
};

export function assertAccion(c: Context<CoreAuthHonoEnv>, accion: AccionRestaurantes): void {
  if (puedeEjecutar(c.get("verticalRole"), accion)) return;
  throw Errors.forbidden(MENSAJE_POR_ACCION[accion] ?? `Tu rol (${c.get("verticalRole") ?? "sin resolver"}) no puede realizar esta acción.`);
}

/**
 * Perfil operativo del `staff` (migracion 090): el CAJERO captura, acepta y prepara pero NO despacha ni cancela; el ENCARGADO (o perfil nulo,
 * el valor por omision, asi nada cambia hasta que alguien marque a un cajero) hace todo. Owner/admin siempre pueden. Se pregunta a
 * `restaurantes.operador_puede` (fuente unica en SQL) por medio del repositorio; base sin migrar = comportamiento anterior.
 */
export async function assertOperadorPuede(deps: AppDeps, c: Context<CoreAuthHonoEnv>, propertyId: string, accion: AccionOperador): Promise<void> {
  const ok = await deps.restaurantesRepo(c.get("db")).operadorPuede({
    organizationId: c.get("organizationId"),
    propertyId,
    userId: c.get("userId"),
    verticalRole: c.get("verticalRole") ?? "",
    accion,
  });
  if (ok) return;
  throw Errors.forbidden(
    accion === "cancelar"
      ? "Con tu perfil de cajero no puedes cancelar pedidos: avisa al encargado."
      : "Con tu perfil de cajero no puedes despachar pedidos ni asignar repartidor: avisa al encargado.",
  );
}
