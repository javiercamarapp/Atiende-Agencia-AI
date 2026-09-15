// Entrypoint de Node.js "puro" — DELIBERADAMENTE no arranca un servidor HTTP aquí.
//
// ACTUALIZADO (barrido de documentación, rondas 13/14/16): el motor de conexión
// real a Postgres gestionado existe (`packages/db/src/managed-postgres-engine.ts`,
// `openManagedPostgres`) y el deploy real de producción usa Vercel Serverless
// Functions, no este archivo — ver `./vercel.ts` (adaptador `hono/vercel`) y
// `./production/deps.ts` (`buildProductionDeps()`, que ya construye adaptadores
// reales de punta a punta para la enorme mayoría de los puertos — coreRepo,
// restaurantesRepo/hotelesRepo/citasRepo/licitacionesRepo/despachosRepo/rentasRepo
// incluidos, ver el comentario de cabecera de `./production/deps.ts` para el
// inventario completo). Este archivo sigue sin arrancar nada porque no es el
// entrypoint que Vercel invoca (ver `./vercel.ts`/`api/index.ts` en la raíz del
// repo) — no existe hoy ningún wiring de servidor Node standalone (`http.createServer`/
// `@hono/node-server`) en este monorepo; mantenerlo como placeholder documentado
// evita confundir a quien busque "dónde arranca el servidor" fuera de Vercel (ej.
// un futuro deploy standalone/Docker). Los puertos que SÍ siguen sin credenciales/
// adaptador (LLM, WhatsApp saliente, Google Calendar, PAC de CFDI, cobro de
// hoteles, canal de mensajería de rentas) están documentados en
// `./production/not-ready.ts`/`./env.ts` y en `docs/DEPLOY.md` §0.2 — nada de eso
// es un gap de "sesión por-request vs. puerto singleton" (ese gap YA se resolvió).
import { loadApiEnv } from "./env.ts";

export { buildApp } from "./app.ts";
export type { AppDeps } from "./deps.ts";

function main(): never {
  loadApiEnv(); // valida que las variables de entorno requeridas estén presentes.
  throw new Error(
    "Este entrypoint (apps/api/src/index.ts) no arranca un servidor standalone — " +
      "el deploy real es Vercel Serverless (ver ./vercel.ts). Ver el comentario de " +
      "este archivo y docs/DEPLOY.md para el estado real de qué puerto tiene " +
      "adaptador de producción y cuál sigue esperando credenciales.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
