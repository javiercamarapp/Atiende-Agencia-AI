// Barrido de envio de la encuesta post-entrega (R-41) compartido por el endpoint interno y el boton del panel. SIEMPRE en una sesion de
// SISTEMA propia (las funciones SQL de candidatas/registro son solo-sistema): nunca en la transaccion del staff.
import { consumeRateLimit, enviarEncuestasPendientes } from "@atiende/domain-restaurantes";
import type { EnvioEncuestasResultado } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { encuestaTokenKey, issueEncuestaToken } from "../../../encuesta-token.ts";
import type { AppDeps } from "../../../deps.ts";

/** `null` = el tope por minuto del boton del panel ya se agoto (el contador es solo-sistema: se consulta en la sesion de sistema). */
export async function ejecutarBarridoEncuestas(
  deps: AppDeps,
  organizationId: string | null,
  opciones: { readonly limite?: number; readonly topePorMinuto?: { readonly scope: string; readonly actor: string; readonly max: number } } = {},
): Promise<EnvioEncuestasResultado | null> {
  const encuestaRepo = deps.encuestaRepo;
  if (!encuestaRepo) throw Errors.serviceUnavailable("La encuesta post-entrega no está disponible en este despliegue.");
  const key = encuestaTokenKey(deps.env.internalSecret);
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const restaurantes = deps.restaurantesRepo(db);
    if (opciones.topePorMinuto) {
      const tope = opciones.topePorMinuto;
      if (!(await consumeRateLimit(restaurantes, tope.scope, tope.actor, tope.max, 60)).allowed) return null;
    }
    return enviarEncuestasPendientes(
      {
        encuestas: encuestaRepo(db),
        restaurantes,
        construirLiga: (c) => `${deps.env.appBaseUrl}/encuesta/${encodeURIComponent(c.orgSlug)}/${issueEncuestaToken(key, c.organizationId, c.orderId)}`,
      },
      { organizationId, limite: opciones.limite },
    );
  });
}
