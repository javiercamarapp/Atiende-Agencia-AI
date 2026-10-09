// Doble de prueba que SI imita la restriccion de Postgres «solo sistema» del limitador de restaurantes.
//
// En la base real `restaurantes.consume_api_rate_limit` lanza 42501 («es solo para la sesión de sistema») cuando `auth.uid()` no es nulo, es
// decir, cuando se llama desde la sesion de un staff autenticado (`dbSession`). El repositorio en memoria NO lo aplica, y por eso los specs
// con repositorio en memoria dejaron pasar el defecto de «Probar agente» (8-oct). Este envoltorio registra con que usuario se abrio cada sesion y
// hace que `consumeRateLimit` falle igual que Postgres si se invoca con una sesion de usuario.
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { RestaurantesRepository } from "@atiende/domain-restaurantes";
import type { AppDeps } from "../src/deps.ts";

export interface LlamadaLimitador {
  readonly scope: string;
  /** `null` = sesion de sistema; cualquier otro valor = sesion de usuario (en Postgres real: 42501). */
  readonly usuario: string | null;
}

export function conGuardaDeSistema(base: AppDeps, repo: RestaurantesRepository): { deps: AppDeps; llamadas: LlamadaLimitador[] } {
  const usuarioDe = new WeakMap<TenantDbSession, string | null>();
  const llamadas: LlamadaLimitador[] = [];
  const engine = {
    withAppSession: <T,>(claims: { userId: string | null }, fn: (s: TenantDbSession) => Promise<T>) =>
      base.engine.withAppSession(claims, (session) => {
        usuarioDe.set(session, claims.userId);
        return fn(session);
      }),
  };
  const restaurantesRepo = (db: TenantDbSession): RestaurantesRepository =>
    new Proxy(repo, {
      get(target, prop, receiver) {
        const valor = Reflect.get(target, prop, receiver);
        if (prop !== "consumeRateLimit") return typeof valor === "function" ? valor.bind(target) : valor;
        return (scope: string, ...resto: unknown[]) => {
          const usuario = usuarioDe.get(db) ?? null;
          llamadas.push({ scope, usuario });
          if (usuario !== null) throw Object.assign(new Error("consume_api_rate_limit es solo para la sesión de sistema"), { code: "42501" });
          return (valor as (...a: unknown[]) => unknown).apply(target, [scope, ...resto]);
        };
      },
    });
  return { deps: { ...base, engine: engine as unknown as AppDeps["engine"], restaurantesRepo }, llamadas };
}
