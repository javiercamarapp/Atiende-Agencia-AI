// notProductionReady — placeholder EXPLÍCITO (nunca silencioso) para los puertos que
// todavía no tienen un adaptador de producción seguro.
//
// Por qué esto existe en vez de simplemente usar los adaptadores en memoria de
// tests/fixtures.ts: `RestaurantesRepository`/`HotelesRepository` (@atiende/domain-*)
// SÍ tienen ya un `Postgres*Repository` real (ver postgres-repository.ts de cada
// paquete), pero — a diferencia de `CoreRepository` (login, sesión de sistema
// `userId: null`, patrón ya documentado y sin ambigüedad, ver core-repository.ts de
// esta misma carpeta) — las rutas de estos dos puertos (`/restaurantes/*`,
// `/hoteles/:propertyId/*`) dependen de RLS real por-usuario (`auth.uid()` vía
// `core.has_property_access`/`hoteles.can_access_money`) resuelto en la transacción
// que `dbSession(engine)` abre POR REQUEST (`c.get("db")`, ver
// `@atiende/core-auth/src/middleware.ts`) — pero `deps.restaurantesRepo`/
// `deps.hotelesRepo` son objetos FIJOS construidos una sola vez al armar `AppDeps`
// (ver `../deps.ts` y cómo los usan `routes/verticals/*/*.ts`: `const repo =
// deps.hotelesRepo`, nunca `c.get("db")`). Conectar un `Postgres*Repository` real aquí
// significaría fijarlo a UNA sola sesión — de sistema o de un usuario arbitrario — para
// TODAS las requests, lo que rompería el aislamiento RLS por-tenant (fuga de datos
// entre organizaciones) en vez de arreglar el gap. Esa es una decisión de arquitectura
// (¿sesión por-request inyectada en cada método del puerto? ¿el puerto deja de ser un
// singleton y pasa a ser una fábrica por-request?) que packages/db/README.md y
// apps/api/src/index.ts ya marcan como "trabajo pendiente de infraestructura" — no algo
// que este cambio de configuración de deploy deba decidir ni inventar en silencio.
//
// Mientras esa decisión no se tome: cualquier intento real de golpear
// `/restaurantes/*`/`/hoteles/*` en producción falla con un error explícito y
// accionable (nunca con datos en memoria que parecen reales pero se pierden en cada
// cold start, y nunca con una fuga de RLS por compartir sesión entre tenants).
export function notProductionReady<T extends object>(portName: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined; // evita que algo intente await-earlo como promesa
        return (..._args: unknown[]) => {
          throw new Error(
            `${portName}.${String(prop)}(): sin adaptador de producción todavía — ` +
              `pendiente de decisión de arquitectura de sesión por-request para este puerto ` +
              `(ver comentario de apps/api/src/production/not-ready.ts). No implementado como ` +
              `datos en memoria a propósito, para no fingir persistencia/aislamiento RLS que no ` +
              `existe en producción.`,
          );
        };
      },
    },
  ) as T;
}
