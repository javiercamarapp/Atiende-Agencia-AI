// Entrypoint real de Vercel Serverless Function para apps/api — usa el adaptador
// oficial `hono/vercel` (parte del paquete `hono`, ya dependencia de este workspace;
// ningún paquete nuevo que instalar) contra la MISMA `buildApp()` que ya ejercitan
// `apps/api/tests/*.spec.ts` de punta a punta. `handle(app)` de hono/vercel devuelve
// `(req: Request) => Response | Promise<Response>` — la firma Fetch estándar que
// Vercel invoca directo para funciones Node.js con `export default`, sin adaptar
// req/res al estilo Express (ver https://hono.dev/docs/getting-started/vercel).
//
// A diferencia de `./index.ts` (entrypoint de Node.js "puro", que deliberadamente NO
// arranca nada), este archivo SÍ construye deps reales de producción
// (`./production/deps.ts`) — la mayoría de los puertos (coreRepo, restaurantesRepo/
// hotelesRepo/citasRepo/licitacionesRepo/despachosRepo/rentasRepo, despachosAuditSink,
// hotelesFraudeAuditSink, hotelesCfdiPort, rentasCalendarSyncRepo/rentasIcalFeedPort,
// rentasMensajeriaRepo, rentasOwnerPortalRepo, citasGoogleCalendarPortResolver) ya son
// adaptadores reales de punta a punta. Actualizado (barrido de documentación,
// rondas 13/14/16): este comentario ANTES decía que `despachosAuditSink` seguía
// fallando explícito "sin adaptador/credenciales todavía" — ya no es cierto, ver
// `./production/despachos-audit-sink.ts`. Lo que SÍ sigue fallando explícito, cada
// uno por su propia razón documentada en `./production/not-ready.ts`/`./env.ts`:
// `hotelesPaymentsPort` (sin adaptador de cobro todavía), `turnHandler`/
// `hotelesTurnHandler`/`citasTurnHandler` (sin NINGUNA API key de proveedor LLM
// configurada, ver `./production/llm-gateway.ts`), el dispatcher de WhatsApp
// saliente (sin `WHATSAPP_ACCESS_TOKEN`), `citasGoogleCalendarPortResolver` (sin
// `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_OAUTH_REDIRECT_BASE_URL`),
// `hotelesCfdiPort` (sin CSD/credenciales reales de un PAC), y
// `rentasCanalMensajeria`/`rentasOnboardingRepo` (sin credenciales de partner de
// canal / sin sesión `service_role` respectivamente) — ver `docs/DEPLOY.md` §0.2
// para el detalle completo, actualizado en el mismo barrido.
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
