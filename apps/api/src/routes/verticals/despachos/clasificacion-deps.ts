// Resolución del repositorio de la clasificación contable (D-P3-13, migración 026): el doble inyectado en pruebas, o el de Postgres sobre la sesión del
// request. Un solo punto para que ingesta (cfdi.ts, cfdi-lote.ts, portal-cliente.ts), las rutas de clasificación y el cron no repitan la decisión.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresClasificacionRepository } from "@atiende/domain-despachos";
import type { ClasificacionRepository } from "@atiende/domain-despachos";
import type { AppDeps } from "../../../deps.ts";

export function clasificacionDe(deps: AppDeps, db: TenantDbSession): ClasificacionRepository {
  return deps.clasificacionRepo ? deps.clasificacionRepo(db) : new PostgresClasificacionRepository(db);
}
