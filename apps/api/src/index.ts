// Entrypoint de Node.js "puro" — DELIBERADAMENTE no arranca un servidor HTTP aquí.
//
// ACTUALIZACIÓN (feat/fusion-vercel-deploy-config): el motor de conexión real a
// Postgres gestionado SÍ existe ahora (`packages/db/src/managed-postgres-engine.ts`,
// `openManagedPostgres`) y el deploy real de producción usa Vercel Serverless
// Functions, no este archivo — ver `./vercel.ts` (adaptador `hono/vercel`) y
// `./production/deps.ts` (`buildProductionDeps()`, que sí construye un
// `ProductionCoreRepository`/`ManagedPostgresEngine` reales para login). Este archivo
// sigue sin arrancar nada porque:
//   1. No es el entrypoint que Vercel invoca (ver `./vercel.ts`/`api/index.ts` en la
//      raíz del repo) — mantenerlo como placeholder documentado evita confundir a
//      quien busque "dónde arranca el servidor" fuera de Vercel (ej. un futuro
//      servidor Node standalone/Docker).
//   2. Incluso con `deps.engine`/`deps.coreRepo` reales, `deps.restaurantesRepo`/
//      `deps.hotelesRepo` siguen sin adaptador de producción seguro — ver
//      `./production/not-ready.ts` para el gap de arquitectura exacto (sesión
//      por-request vs. puerto singleton) y `docs/DEPLOY.md` §0.2 para el detalle
//      completo. No inventamos ese wiring aquí para no fingir un servidor que
//      filtraría datos entre tenants.
import { loadApiEnv } from "./env.ts";

export { buildApp } from "./app.ts";
export type { AppDeps } from "./deps.ts";

function main(): never {
  loadApiEnv(); // valida que las variables de entorno requeridas estén presentes.
  throw new Error(
    "Este entrypoint (apps/api/src/index.ts) no arranca un servidor standalone — " +
      "el deploy real es Vercel Serverless (ver ./vercel.ts). Y aun ahí, " +
      "restaurantesRepo/hotelesRepo siguen sin adaptador de producción (ver " +
      "./production/not-ready.ts y docs/DEPLOY.md §0.2). Ver el comentario de este archivo.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
