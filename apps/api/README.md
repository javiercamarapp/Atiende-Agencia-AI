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
- `src/routes/auth.ts` (+ `auth-google.ts`/`auth-magic-link.ts`) —
  login/refresh/logout/aceptar-invitación, "Sign in with Google" y "continuar
  con correo" sin contraseña (núcleo compartido, genérico a las 6 verticales).
- `src/routes/verticals/{restaurantes,hoteles,citas,licitaciones,despachos,rentas}/`
  — las rutas HTTP propias de cada vertical (back-office admin, webhooks de
  WhatsApp, herramientas de voz, dispatchers de correo, el webhook del PAC de
  CFDI de hoteles — `verticals/hoteles/cfdi-webhook.ts` —, etc.). Cada vertical
  también trae ahí sus propias rutas `/internal/*` de cron (p. ej.
  `citas/email-dispatch.ts`, `citas/google-calendar-sync.ts`); solo el
  dispatcher de WhatsApp compartido vive en `src/routes/internal/` (ver abajo).
- `src/routes/superadmin*.ts` — back office de plataforma, fuera del árbol de
  las 6 verticales: `superadmin.ts` (dashboard/prospectos/paneles),
  `superadmin-llm-usage.ts` ("Gasto de API"), `superadmin-integraciones.ts`
  (`GET /superadmin/integraciones`, ver `docs/CREDENCIALES.md`),
  `superadmin-break-glass.ts`, `superadmin-facturacion.ts` y
  `superadmin-salud.ts` ("Salud operativa": `GET /superadmin/salud`(`/crons`|
  `/colas`|`/licitaciones-fuentes`) — latidos de los 17 crons de
  `vercel.json` vía `src/salud/with-heartbeat.ts::withHeartbeat`, salud
  agregada de las 6 colas `messaging_outbox` y última corrida por fuente de
  licitaciones; ver `scripts/verify-superadmin-salud/README.md`).
- `src/routes/billing.ts` — checkout/webhook de Stripe de la suscripción SaaS
  propia de Atiende a sus organizaciones clientes.
- `src/routes/notifications.ts` — notificaciones internas genéricas (las 6
  verticales + superadmin).
- `src/routes/internal/` — el dispatcher de WhatsApp compartido
  (`/internal/whatsapp/dispatch`, invocado por `vercel.json::crons` y por el
  disparo inline de cada webhook), autenticado con
  `INTERNAL_SECRET`/`CRON_SECRET`.
- `tests/` — 110 specs de integración que ejercitan `buildApp()` de punta a
  punta contra un `AppDeps` en memoria (mismo patrón que usan los tests de
  producción para verificar el wiring real).

El middleware de auth/tenancy que este backend consume vive en
`@atiende/core-auth`/`@atiende/core-tenancy` (paquetes compartidos, no duplicados
aquí).
