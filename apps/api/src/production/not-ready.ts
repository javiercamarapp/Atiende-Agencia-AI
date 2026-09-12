// notProductionReady — placeholder EXPLÍCITO (nunca silencioso) para los puertos que
// todavía no tienen un adaptador de producción seguro.
//
// HISTORIA (por qué existía para restaurantesRepo/hotelesRepo/citasRepo/
// licitacionesRepo/despachosRepo/rentasRepo/rentasOwnerPortalRepo, y por qué ya NO
// los cubre): estos 7 puertos SÍ tienen un `Postgres*Repository` real (ver
// postgres-repository.ts de cada paquete de dominio) desde antes, pero — a
// diferencia de `CoreRepository` (login, sesión de sistema `userId: null`, patrón ya
// documentado y sin ambigüedad, ver core-repository.ts de esta misma carpeta) — sus
// rutas dependen de RLS real por-tenant (`auth.uid()`/rol vía
// `core.has_property_access` y equivalentes por vertical) resuelto en la transacción
// que se abre POR REQUEST (`dbSession(engine)` -> `c.get("db")` en rutas de staff
// autenticado; `engine.withAppSession({userId: null}, ...)` inline en rutas
// públicas/de sistema, ver `@atiende/core-auth/src/middleware.ts` y
// `@atiende/core-tenancy::TenancyEngine`). Conectar un `Postgres*Repository` real
// como objeto FIJO en `AppDeps` habría fijado UNA sola sesión para TODAS las
// requests, rompiendo el aislamiento RLS por-tenant en vez de arreglar el gap.
//
// La resolución (rama `feat/fusion-produccion-repos-por-request`): estos 7 campos de
// `AppDeps` (ver `../deps.ts`) dejaron de ser el repositorio ya construido y pasaron
// a ser una FÁBRICA `(db: TenantDbSession) => XRepository` — cada ruta HTTP hace
// `deps.xRepo(c.get("db"))` (o `deps.xRepo(db)` dentro de su propio
// `withAppSession`) para ligar el repositorio a la sesión correcta de ESE request,
// nunca a un singleton. `buildProductionDeps()` (`../production/deps.ts`) ya los
// construye como `(db) => new PostgresXRepository(db)` reales — este archivo
// (`notProductionReady`) ya NO los cubre.
//
// Lo que SÍ sigue cubriendo, por razones DISTINTAS a la de arriba (no confundir
// ambos gaps):
//   - `turnHandler`/`hotelesTurnHandler`/`citasTurnHandler`: el gateway LLM real
//     (proveedor/roles configurados) es un problema de infraestructura aparte, sin
//     relación con sesión-por-request.
//   - `hotelesPaymentsPort`: integración de cobro (Stripe/Conekta) sin adaptador ni
//     credenciales todavía — no es un repositorio de datos por-tenant, no depende de
//     RLS, no aplica el patrón de fábrica.
//   - `despachosAuditSink`: falta un adaptador de auditoría real (tabla/servicio
//     dedicado) — mismo tipo de gap que `hotelesPaymentsPort`, no el de sesión.
//
// Mientras esas 3 decisiones sigan pendientes: cualquier intento real de usarlas en
// producción falla con un error explícito y accionable (nunca con datos en memoria
// que parecen reales pero se pierden en cada cold start).
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
