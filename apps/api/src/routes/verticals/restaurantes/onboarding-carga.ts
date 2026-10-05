// R-33 -- carga UNICA del checklist de onboarding para la API: el GET, el gate y el aviso `onboarding.listo` deben medir EXACTAMENTE lo mismo
// (si el aviso usara menos puntos que el GET, "listo" se emitiria con la pantalla todavia en pendiente). Inyecta voz y privacidad solo si el
// despliegue los trae; cada lectura degrada con SAVEPOINT contra la base sin migrar (voz 025, privacidad 030), asi que nunca hay 500.
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { cargarOnboarding } from "@atiende/domain-restaurantes";
import type { OnboardingChecklist } from "@atiende/domain-restaurantes";
import type { AppDeps } from "../../../deps.ts";

export function cargarOnboardingDeOrganizacion(deps: AppDeps, c: Context<CoreAuthHonoEnv>, organizationId: string): Promise<OnboardingChecklist> {
  const db = c.get("db");
  const provider = deps.voiceProvider;
  return cargarOnboarding(deps.restaurantesRepo(db), organizationId, {
    ...(deps.vozRepo ? { voz: deps.vozRepo(db) } : {}),
    ...(provider ? { vozProveedorListo: async () => (await provider.salud()).ok } : {}),
    ...(deps.privacidadRepo ? { privacidad: deps.privacidadRepo(db) } : {}),
  });
}
