// Lecturas comunes de `assignBranch` y de la cotizacion a domicilio: que sucursales DESPACHAN y que dijo el piloto original de una colonia.
//
// Una sucursal de DESPACHO es la que esta activa y acepta domicilio (`branch_detail.acepta_domicilio`, migracion 057). Galerias (T4) y Chicxulub (T5) no
// reparten: nunca se presentan como sucursal de despacho. La referencia del piloto (`known_zone.ref_*`, migracion 056) solo orienta cuando la colonia no tiene
// coordenadas propias: se filtra a las sucursales de despacho vigentes y se dice siempre como aproximada.
import type { SucursalCercana } from "./nearest-branch.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { Branch, ColoniaReferencia } from "./types.ts";

/** Sucursales de PM que NO reparten (Galerias y Playa/Chicxulub: decision de Javier, 7-oct-2026) aunque `acepta_domicilio` este en true en la base (hoy lo esta) y solo
 * las deje fuera estar inactivas. Se aplica al perfil `taqueria_pm`; reactivar Galerias no la convierte en sucursal de despacho. */
export const SUCURSALES_QUE_NO_REPARTEN_PM: readonly string[] = ["galerias", "playa"];

export async function sucursalesDeDespacho(repo: RestaurantesRepository, organizationId: string, excluirSlugs: readonly string[] = []): Promise<readonly Branch[]> {
  const activas = (await repo.listBranchesForOrganizationAdmin(organizationId)).filter((b) => b.status === "active" && !excluirSlugs.includes(b.slug));
  const despacho: Branch[] = [];
  for (const branch of activas) {
    const politica = await repo.findBranchPolicy(branch.propertyId);
    if (politica.aceptaDomicilio !== false) despacho.push(branch);
  }
  return despacho;
}

/** La referencia del piloto de una colonia (`null` = la base no tiene la migracion 056 o la colonia no esta). Lee solo cuando se necesita. */
export async function referenciaDeColonia(repo: RestaurantesRepository, organizationId: string, zoneId: string): Promise<ColoniaReferencia | null> {
  const lectura = await repo.listColoniasReferencia(organizationId);
  if (!lectura.disponible) return null;
  return lectura.zonas.find((z) => z.zoneId === zoneId) ?? null;
}

/** Sucursales de despacho que nombra la referencia del piloto (primera y segunda, en ese orden), con sus km. Las que no despachan o estan inactivas se descartan. */
export function opcionesDeReferencia(ref: ColoniaReferencia | null, despacho: readonly Branch[]): readonly SucursalCercana[] {
  if (!ref) return [];
  const porSlug = new Map(despacho.map((b) => [b.slug, b] as const));
  const opciones: SucursalCercana[] = [];
  for (const [slug, km] of [
    [ref.refSucursalSlug, ref.refKm],
    [ref.ref2SucursalSlug, ref.ref2Km],
  ] as const) {
    const branch = slug ? porSlug.get(slug) : undefined;
    if (branch && !opciones.some((o) => o.slug === branch.slug)) opciones.push({ slug: branch.slug, nombre: branch.name, kmAprox: km === null ? null : Math.round(km * 10) / 10 });
  }
  return opciones;
}
