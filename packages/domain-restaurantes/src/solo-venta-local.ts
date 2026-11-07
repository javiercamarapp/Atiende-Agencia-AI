// Sucursales que atienden CLIENTES (agentes de WhatsApp y voz, pedido en linea) frente a sucursales "solo venta local" (migracion 105).
//
// Una sucursal solo venta local (PM: Galerias, decision del dueno 6-nov-2026) esta ACTIVA para que cuente en tableros, CFO e importacion de
// SoftRestaurant, pero nunca se ofrece al cliente: no sale en la lista de sucursales del agente ni en su conocimiento, no se cotiza ni se crea un
// pedido en ella (domicilio ni recoger), no despacha y no es "la mas cercana". Este modulo es la UNICA puerta de esa regla: todo camino de cliente
// busca o lista sucursales por aqui en vez de `repo.findBranch` / `listBranchesForOrganization` directos. Los caminos de staff (panel, KPIs, CFO,
// alcance de membresia) siguen viendo la sucursal como cualquier otra.
import type { RestaurantesRepository } from "./repository.ts";
import type { Branch, BranchSummary } from "./types.ts";

/** Sucursal por slug o nombre para un camino de CLIENTE: `null` si no existe o es solo venta local (indistinguible a proposito: el agente no la nombra). */
export async function buscarSucursalParaClientes(repo: RestaurantesRepository, organizationId: string, selector: { slug?: string; name?: string }): Promise<Branch | null> {
  const branch = await repo.findBranch(organizationId, selector);
  if (!branch) return null;
  return (await repo.listarSucursalesSoloVentaLocal(organizationId)).includes(branch.propertyId) ? null : branch;
}

/** ¿Esta sucursal atiende clientes? Activa y no solo venta local. */
export async function atiendeClientes(repo: RestaurantesRepository, branch: Pick<Branch, "propertyId" | "organizationId" | "status">): Promise<boolean> {
  if (branch.status !== "active") return false;
  return !(await repo.listarSucursalesSoloVentaLocal(branch.organizationId)).includes(branch.propertyId);
}

/** Sucursales activas que atienden clientes (completas, con coordenadas), en el orden del panel. */
export async function sucursalesParaClientes(repo: RestaurantesRepository, organizationId: string): Promise<readonly Branch[]> {
  const soloLocal = new Set(await repo.listarSucursalesSoloVentaLocal(organizationId));
  return (await repo.listBranchesForOrganizationAdmin(organizationId)).filter((b) => b.status === "active" && !soloLocal.has(b.propertyId));
}

/** Bloque "SUCURSALES REALES" de los prompts (WhatsApp y voz): `listBranchesForOrganization` sin las solo venta local. */
export async function resumenSucursalesParaClientes(repo: RestaurantesRepository, organizationId: string): Promise<readonly BranchSummary[]> {
  const soloLocal = new Set(await repo.listarSucursalesSoloVentaLocal(organizationId));
  return (await repo.listBranchesForOrganization(organizationId)).filter((b) => !soloLocal.has(b.propertyId));
}
