// Entrypoint de producción — DELIBERADAMENTE no arranca un servidor HTTP todavía.
//
// `packages/db` no tiene motor de conexión real (PGlite/embedded-postgres/Postgres
// gestionado) — ver packages/db/README.md, mismo estado ya documentado en
// docs/REQUISITOS.md §0 antes de esta fase. Sin una conexión real no hay con qué
// construir un `PostgresCoreRepository`/`PostgresRestaurantesRepository` de verdad en
// producción, así que este archivo se detiene aquí en vez de fingir un servidor que
// no podría atender tráfico real.
//
// Lo que SÍ es real y queda listo para cuando esa pieza exista: `buildApp(deps)`
// (apps/api/src/app.ts) ensambla la app Hono completa con las 3 rutas críticas de
// restaurantes + login núcleo, usando únicamente el puerto `RestaurantesRepository`/
// `CoreRepository` — conectar un motor real es tan simple como construir
// `new PostgresRestaurantesRepository(session)`/`new PostgresCoreRepository(session)`
// (ambos ya existen y typechecan, ver @atiende/domain-restaurantes y @atiende/db) y
// pasarlos aquí. Los tests de este paquete (`apps/api/tests/`) ya ejercitan
// `buildApp` de punta a punta contra los adaptadores en memoria.
import { loadApiEnv } from "./env.ts";

export { buildApp } from "./app.ts";
export type { AppDeps } from "./deps.ts";

function main(): never {
  loadApiEnv(); // valida que las variables de entorno requeridas estén presentes.
  throw new Error(
    "apps/api todavía no tiene un motor de conexión real a Postgres (packages/db pendiente) — " +
      "no hay servidor que arrancar en producción todavía. Ver el comentario de este archivo.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
