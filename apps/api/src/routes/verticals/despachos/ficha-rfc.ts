// RFC del contribuyente (D-P3-01): sale SIEMPRE de la ficha de cartera del cliente (`obtenerFicha`), nunca de un CFDI.
// `obtenerFicha` ya devuelve `null` (no lanza) cuando la property no tiene ficha o la base aun no tiene la migracion 018,
// asi que este helper conserva ese vacio honesto: sin ficha -> `null` y el llamador responde "sin datos".
import { PostgresCarteraRepository } from "@atiende/domain-despachos";
import type { CarteraRepository } from "@atiende/domain-despachos";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { AppDeps } from "../../../deps.ts";

export async function rfcContribuyenteDeFicha(deps: AppDeps, db: TenantDbSession, propertyId: string): Promise<string | null> {
  const cartera: CarteraRepository = deps.carteraRepo ? deps.carteraRepo(db) : new PostgresCarteraRepository(db);
  const ficha = await cartera.obtenerFicha(propertyId);
  return ficha?.rfc ?? null;
}
