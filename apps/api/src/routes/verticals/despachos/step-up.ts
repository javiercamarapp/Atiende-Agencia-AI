// D-30 -- segunda capa (TOTP, L-01) para las acciones sensibles de despachos. Misma guardia que usa
// licitaciones (`requireStepUp`, ../../../second-factor.ts) con el alcance compartido `despachos_sensitive`:
// el token de 5 minutos sale de `POST /auth/step-up` y viaja en el header `x-step-up-token`.
//
// Orden en cada ruta: primero el rol (`assertVerticalRole`), luego esta guardia, despues la validacion y el trabajo.
// Asi un rol sin permiso sigue recibiendo 403 `forbidden` y nunca aprende si tiene TOTP.
//
// Compatibilidad con la base sin migrar: `requireStepUp` no exige nada si el puerto de 2FA no existe o la migracion de
// 2FA esta pendiente (queda el control por rol que la ruta ya aplico). Con 2FA disponible NO hay bypass: sin TOTP dado de
// alta responde 403 `step_up_enrollment_required`; sin token vigente, 403 `step_up_required`.
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";
import { requireStepUp } from "../../../second-factor.ts";

export async function exigirStepUpDespachos(deps: AppDeps, c: Context<CoreAuthHonoEnv>): Promise<void> {
  await requireStepUp(deps, {
    userId: c.get("userId"),
    organizationId: c.get("organizationId"),
    scope: "despachos_sensitive",
    token: c.req.header("x-step-up-token"),
    db: c.get("db"),
  });
}
