// Alcance de propiedades (clientes) del usuario para "Chatea con tus datos": la membership verificada
// decide, nunca el cuerpo de la peticion. `null` = todas las de la organizacion; arreglo = solo esas.
// Mismo criterio que `restaurantes/admin-scope.ts::resolveEffectivePropertyIds` (sin ensanchar nunca el
// alcance de una membership restringida) pero sin depender del repositorio de una vertical.
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../deps.ts";

export async function resolveMembershipPropertyScope(deps: AppDeps, c: Context<CoreAuthHonoEnv>, organizationId: string): Promise<readonly string[] | null> {
  const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
  const membership = memberships.find((m) => m.organizationId === organizationId);
  // Si por alguna razon la membership completa no aparece (nunca deberia: coreRepo y engine leen la misma
  // tabla), jamas se ensancha el alcance mas alla de la property que `requirePropertyMembership` ya verifico.
  return membership ? membership.propertyIds : [c.req.param("propertyId") ?? ""];
}
