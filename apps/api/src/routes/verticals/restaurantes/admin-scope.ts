// Resolución de alcance por membership (no solo por organización) — extraído de
// admin-kpis.ts (Fase 3) para reusarlo tal cual en las rutas nuevas de Fase 5
// (sucursales/pedidos, ver diseño Fase 5 §1): la regla de negocio es la MISMA
// ("nunca ensanchar el alcance de un staff con membership restringida más allá de
// sus propias sucursales") y duplicarla en cada archivo nuevo sería el tipo de
// copy-paste que diverge en silencio la próxima vez que alguien la toque. Ver el
// comentario original (ahora aquí) para el detalle completo del razonamiento.
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

export async function resolveEffectivePropertyIds(deps: AppDeps, c: Context<CoreAuthHonoEnv>, organizationId: string, branchId: string | null): Promise<readonly string[] | null> {
  const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
  const membership = memberships.find((m) => m.organizationId === organizationId);
  // Fallback de defensa en profundidad: si por alguna razón la membership completa no
  // aparece aquí (nunca debería, coreRepo/engine leen la MISMA tabla real en
  // producción), nunca se ensancha el alcance más allá de la única property que
  // `requirePropertyMembership` ya verificó para esta request.
  const verifiedPropertyId = c.req.param("propertyId") ?? "";
  const membershipScope: readonly string[] | null = membership ? membership.propertyIds : [verifiedPropertyId];

  if (branchId === null) return membershipScope;

  const branches = await deps.restaurantesRepo(c.get("db")).listBranchesForOrganization(organizationId);
  if (!branches.some((b) => b.propertyId === branchId)) {
    throw Errors.validation("branchId no pertenece a esta organización (o no está activo).");
  }
  if (membershipScope !== null && !membershipScope.includes(branchId)) {
    throw Errors.forbidden("No tienes acceso a esta sucursal.");
  }
  return [branchId];
}

export function parseBranchId(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  if (raw.length > 200) throw Errors.validation("branchId inválido.");
  return raw;
}

/**
 * Catalogo, precios, promociones globales y configuracion del agente/canales son de TODA la organizacion (no existe "precio de una sola
 * sucursal" en esas filas). Un admin con membresia acotada (`property_ids`) solo gobierna sus sucursales, asi que estas escrituras exigen
 * owner/admin con alcance de toda la organizacion (`property_ids` nulo). 403 claro, nunca un cambio silencioso a las demas sucursales.
 * Lo que SI es por sucursal (precio/disponibilidad en una sucursal de su alcance, datos de la sucursal, promociones acotadas) sigue como antes.
 */
export async function assertAdminGeneral(deps: AppDeps, c: Context<CoreAuthHonoEnv>): Promise<void> {
  const alcance = await resolveEffectivePropertyIds(deps, c, c.get("organizationId"), null);
  if (alcance === null) return;
  throw Errors.forbidden("Tu acceso está limitado a algunas sucursales: solo el dueño o un administrador con acceso a todas puede cambiar esto, porque afecta a toda la organización.");
}
