// Entrypoint real de Vercel Serverless Function para apps/api — usa el adaptador
// oficial `hono/vercel` (parte del paquete `hono`, ya dependencia de este workspace;
// ningún paquete nuevo que instalar) contra la MISMA `buildApp()` que ya ejercitan
// `apps/api/tests/*.spec.ts` de punta a punta. `handle(app)` de hono/vercel devuelve
// `(req: Request) => Response | Promise<Response>` — la firma Fetch estándar que
// Vercel invoca directo para funciones Node.js con `export default`, sin adaptar
// req/res al estilo Express (ver https://hono.dev/docs/getting-started/vercel).
//
// A diferencia de `./index.ts` (entrypoint de Node.js "puro", que deliberadamente NO
// arranca nada porque documenta el hueco de motor de conexión real), este archivo SÍ
// construye deps reales de producción (`./production/deps.ts`) — con la salvedad,
// también documentada ahí (`./production/not-ready.ts`), de que `hotelesPaymentsPort`/
// `despachosAuditSink` fallan explícito si algo los invoca en producción (sin
// adaptador/credenciales todavía), en vez de fingir con datos en memoria; y de que
// `turnHandler`/`hotelesTurnHandler`/`citasTurnHandler` solo quedan reales (LLM real
// vía `./production/llm-gateway.ts`) en cuanto al menos una API key de proveedor
// esté configurada — sin ninguna, fallan explícito igual que los dos anteriores.
import { handle } from "hono/vercel";
import { buildApp } from "./app.ts";
import { buildProductionDeps } from "./production/deps.ts";

export const config = {
  runtime: "nodejs",
};

// Cachear la app (no solo `deps`) entre invocaciones de un mismo contenedor "warm" —
// `buildApp()` es barato (solo registra rutas), pero evita reconstruirla en cada
// request igual que `buildProductionDeps()` cachea el pool de conexiones.
let app: ReturnType<typeof buildApp> | undefined;

function getApp() {
  if (!app) app = buildApp(buildProductionDeps());
  return app;
}

// Export un OBJETO con método `fetch`, no una función suelta -- una función suelta
// como default export la interpreta el runtime de Node.js de Vercel con la firma
// vieja `(req, res) => void` (estilo Express/http clásico) en vez de la Web-fetch
// estándar, así que el `Response` real que devolvemos se ignora en silencio y la
// función nunca responde (hasta agotar el timeout) -- bug real encontrado en el
// primer intento de deploy de producción: `WARN: default export returned a
// 'Response'... You likely meant the Web fetch-style API`, seguido de
// `Vercel Runtime Timeout Error` en cada request. Ver
// https://vercel.com/docs/functions/runtimes/node-js -- "TypeScript Web Signature
// Handler" es exactamente este patrón (`export default { fetch(request) {...} }`).
export default {
  fetch(request: Request): Response | Promise<Response> {
    return handle(getApp())(request);
  },
};
