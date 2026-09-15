# apps/api

Backend Hono real, único para las 6 verticales (restaurantes, hoteles, citas,
licitaciones, despachos, rentas) — ya NO es una carpeta reservada. Actualizado en el
barrido de documentación de las rondas 13/14/16: este README describía "Aún no
construido: no hay `package.json` ni `server.ts` en esta carpeta todavía", que dejó
de ser cierto hace varias fases (Fase 1 de restaurantes/hoteles en adelante).

## Estructura real

- `src/app.ts` — `buildApp(deps)` ensambla la app Hono real: middleware de
  correlación (`requestId()`, montado global — ver `src/logger.ts`), manejo de
  errores tipados (`@atiende/core-auth::ApiError` → JSON con `code`/`message`), y el
  registro de rutas de las 6 verticales más las internas de plataforma.
- `src/env.ts` — `loadApiEnv()`: valida y arma toda la configuración desde
  `process.env` (ver `.env.example` en la raíz del repo para el catálogo completo,
  con comentarios de qué desbloquea cada variable).
- `src/deps.ts` — el contrato `AppDeps` (puertos que cada ruta consume, nunca
  Postgres directo).
- `src/production/deps.ts` — `buildProductionDeps()`: la implementación REAL de
  `AppDeps` contra Postgres gestionado (Supabase) — ver `docs/DEPLOY.md` §0.2 para
  el estado exacto y actualizado de qué puerto ya es real y cuál sigue esperando
  una credencial de terceros.
- `src/vercel.ts` — entrypoint real de Vercel Serverless Function (`hono/vercel`).
  `src/index.ts` es un entrypoint de Node.js "puro" deliberadamente inerte (ver su
  comentario de cabecera) — el deploy real usa `vercel.ts`.
- `src/logger.ts` — logger estructurado mínimo (`logEvent`) que incluye el
  `requestId` de cada request en cada línea JSON, para correlacionar logs de un
  mismo request HTTP.
- `src/routes/auth.ts` — login/refresh/logout/aceptar-invitación (núcleo
  compartido, genérico a las 6 verticales).
- `src/routes/verticals/{restaurantes,hoteles,citas,licitaciones,despachos,rentas}/`
  — las rutas HTTP propias de cada vertical (12 a 24 archivos por vertical: back-
  office admin, webhooks de WhatsApp, herramientas de voz, dispatchers de correo,
  etc.).
- `src/routes/internal/` — rutas de scheduler (`/internal/*`) invocadas por
  `vercel.json::crons`, autenticadas con `INTERNAL_SECRET`/`CRON_SECRET`.
- `tests/` — 95 specs de integración que ejercitan `buildApp()` de punta a punta
  contra un `AppDeps` en memoria (mismo patrón que usan los tests de producción
  para verificar el wiring real).

El middleware de auth/tenancy que este backend consume vive en
`@atiende/core-auth`/`@atiende/core-tenancy` (paquetes compartidos, no duplicados
aquí).
