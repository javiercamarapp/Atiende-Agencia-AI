// Cableado de SoftRestaurant en apps/api: elige store/puerto/mapeo a partir de `deps`
// (los tests inyectan memoria; produccion usa Postgres y el puerto "no configurado"
// hasta que el distribuidor entregue la API real).
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { RestaurantesRepository } from "@atiende/domain-restaurantes";
import {
  PostgresComandaOutboxStore,
  RESOLVER_SIN_CODIGOS,
  SoftRestaurantNoConfiguradoPort,
  crearAlertaCapturaManual,
  crearResolverSucursalPos,
  type ComandaOutboxStore,
  type DepsComandaPos,
  type SoftRestaurantPort,
} from "@atiende/domain-restaurantes/softrestaurant";
import type { AppDeps } from "../../../deps.ts";

/** Solo lo que necesita el cableado: permite usarlo tambien desde el turn handler de WhatsApp de
 * produccion (que no recibe el `AppDeps` completo) con los valores por omision. */
export type SoftRestaurantDeps = Pick<AppDeps, "softRestaurantStore" | "softRestaurantPort" | "softRestaurantMapeo">;

export function softRestaurantStoreFor(deps: SoftRestaurantDeps, db: TenantDbSession): ComandaOutboxStore {
  return deps.softRestaurantStore ? deps.softRestaurantStore(db) : new PostgresComandaOutboxStore(db);
}

export function softRestaurantPortFor(deps: SoftRestaurantDeps): SoftRestaurantPort {
  return deps.softRestaurantPort ?? new SoftRestaurantNoConfiguradoPort();
}

export function softRestaurantComandaDeps(deps: SoftRestaurantDeps, db: TenantDbSession, repo: RestaurantesRepository): DepsComandaPos {
  return {
    store: softRestaurantStoreFor(deps, db),
    port: softRestaurantPortFor(deps),
    resolverCodigos: deps.softRestaurantMapeo?.resolverCodigos ?? RESOLVER_SIN_CODIGOS,
    resolverSucursal: deps.softRestaurantMapeo?.resolverSucursal ?? crearResolverSucursalPos(),
    alertar: crearAlertaCapturaManual(repo),
  };
}
