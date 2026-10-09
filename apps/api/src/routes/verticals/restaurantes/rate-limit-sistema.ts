// Topes por staff / organizacion en rutas de PANEL (sesion de usuario autenticado).
//
// `restaurantes.consume_api_rate_limit` es una funcion de SOLO SISTEMA: lanza 42501 si `auth.uid()` no es nulo (migracion 107/013, mismo
// criterio que el resto de las funciones del limitador). Una ruta con `authMiddleware` + `dbSession` corre en la sesion del staff, asi que
// llamarla con `deps.restaurantesRepo(c.get("db"))` revienta con un 500 en el PRIMER intento (defecto real de «Probar agente» y del
// preview de voz, 8-oct). El contador se consume en su propia sesion de sistema (`userId: null`, commit propio -- el mismo patron de
// `hoteles/voice-tools.ts` y `citas/voice-tools.ts`), no en la transaccion del request.
//
// Esto NO abre un hueco: el actor que se hashea sigue siendo el staff autenticado del JWT (y la organizacion de su membership verificada),
// nunca un valor del cuerpo; lo unico que cambia es QUE sesion de base ejecuta el contador. El contador cuenta aunque el request termine
// luego en 4xx/5xx (igual que las rutas publicas): es un tope de uso, no de exito.
import { consumeRateLimit } from "@atiende/domain-restaurantes";
import type { AppDeps } from "../../../deps.ts";

export interface TopeDeSistema {
  readonly scope: string;
  readonly actor: string;
  readonly maxRequests: number;
  readonly windowSeconds: number;
}

/**
 * Consume uno o varios topes EN ORDEN dentro de UNA sesion de sistema. Se detiene en el primero que se agota (los siguientes no
 * consumen) y devuelve su indice, o `null` si todos permitieron.
 */
export async function consumirTopesEnSesionDeSistema(deps: Pick<AppDeps, "engine" | "restaurantesRepo">, topes: readonly TopeDeSistema[]): Promise<number | null> {
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const repo = deps.restaurantesRepo(db);
    for (const [i, t] of topes.entries()) {
      const r = await consumeRateLimit(repo, t.scope, t.actor, t.maxRequests, t.windowSeconds);
      if (!r.allowed) return i;
    }
    return null;
  });
}
