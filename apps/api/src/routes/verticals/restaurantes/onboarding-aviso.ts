// Aviso `restaurantes.onboarding.listo`: se emite en la ESCRITURA que completa el ultimo punto obligatorio del checklist, nunca al
// leerlo (un GET no escribe, y "listo" es un estado, no un evento: emitirlo por estado lo reemitiria cada vez que la base depura la
// dedupe vencida y se lo llevaria cualquier owner/admin nuevo que abra la pantalla).
//
// Mecanica: se mide el checklist ANTES de la escritura; solo si estaba incompleto se mide DESPUES y, si ahora esta completo, se
// emite (clave de dedupe = organizacion). Una escritura que lanza no emite. Si la medicion falla (base sin migrar, RLS, timeout) no se
// avisa: la medicion corre dentro de un SAVEPOINT (runWithSavepointFallback), asi que un error de Postgres en sus lecturas se revierte
// al savepoint y la sesion compartida del request sigue viva (sin 25P02 en la escritura ni ROLLBACK en el COMMIT). Todo en secuencia
// sobre la misma sesion (nunca Promise.all).
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import { cargarOnboarding } from "@atiende/domain-restaurantes";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";

async function checklistCompleto(deps: AppDeps, c: Context<CoreAuthHonoEnv>, organizationId: string): Promise<boolean | null> {
  return runWithSavepointFallback<boolean | null>({
    session: c.get("db"),
    primary: async () => {
      // El checklist es de TODA la organizacion: un staff acotado a algunas sucursales vería un subconjunto y daria un falso "listo".
      if ((await resolveEffectivePropertyIds(deps, c, organizationId, null)) !== null) return null;
      return (await cargarOnboarding(deps.restaurantesRepo(c.get("db")), organizationId)).listoParaOperar;
    },
    isRecoverable: () => true,
    fallback: async () => null,
  });
}

export async function conAvisoOnboardingListo<T>(deps: AppDeps, c: Context<CoreAuthHonoEnv>, organizationId: string, escribir: () => Promise<T>): Promise<T> {
  const antes = await checklistCompleto(deps, c, organizationId);
  const resultado = await escribir();
  if (antes === false && (await checklistCompleto(deps, c, organizationId)) === true) {
    await emitirNotificacion(c.get("db"), { evento: "restaurantes.onboarding.listo", organizationId, clave: organizationId });
  }
  return resultado;
}
