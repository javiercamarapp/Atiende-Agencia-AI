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

export function softRestaurantStoreFor(deps: AppDeps, db: TenantDbSession): ComandaOutboxStore {
  return deps.softRestaurantStore ? deps.softRestaurantStore(db) : new PostgresComandaOutboxStore(db);
}

export function softRestaurantPortFor(deps: AppDeps): SoftRestaurantPort {
  return deps.softRestaurantPort ?? new SoftRestaurantNoConfiguradoPort();
}

export function softRestaurantComandaDeps(deps: AppDeps, db: TenantDbSession, repo: RestaurantesRepository): DepsComandaPos {
  return {
    store: softRestaurantStoreFor(deps, db),
    port: softRestaurantPortFor(deps),
    resolverCodigos: deps.softRestaurantMapeo?.resolverCodigos ?? RESOLVER_SIN_CODIGOS,
    resolverSucursal: deps.softRestaurantMapeo?.resolverSucursal ?? crearResolverSucursalPos(),
    alertar: crearAlertaCapturaManual(repo),
  };
}
