# Deploy — Supabase + Vercel

Decisión ya tomada: **un solo proyecto de Supabase consolidado** + **deploy en
Vercel**, priorizando costo mínimo (tier free de ambos mientras se pueda). Nada de
esta rama (`feat/fusion-vercel-deploy-config`) creó infraestructura real ni corrió
`supabase projects create` / `vercel --prod` — eso requiere tu cuenta y tu tarjeta.

Este documento reemplaza al de `feat/fusion-deploy-config` (rama previa, sin
mergear): en ese momento `apps/web`/`apps/api` eran carpetas reservadas sin código —
por eso esa rama explícitamente NO incluyó `vercel.json`. Eso ya cambió (Fase 1 de
restaurantes y de hoteles mergeadas a `main`, además de los 6 patrones de alto
impacto) y esta rama sí agrega `vercel.json` + el adaptador `hono/vercel` reales.

## Paso 0 (bloqueante) — el estado real del código, antes de tocar nada de esto

### 0.1 — Resuelto en esta rama

- **`apps/web` y `apps/api` ya existen en `main`** con código real y tests en verde
  (Hono en `apps/api/src/app.ts`/`index.ts`, SPA Vite en `apps/web/`).
- **`vercel.json`** (raíz del repo) — build estático de `apps/web` (Vite) + función
  serverless Node.js de `apps/api` (`api/index.ts` → `apps/api/src/vercel.ts`, usando
  el adaptador real `hono/vercel`), con rewrites de `/health`, `/auth/*`,
  `/v1/restaurantes/*`, `/hoteles/*` hacia la función y fallback de SPA para el resto.
- **`packages/db/src/managed-postgres-engine.ts`** (`openManagedPostgres`) — motor de
  producción contra Postgres gestionado, port real (mismo comportamiento, mismo
  patrón `set local role authenticated` + `set_config('request.jwt.claim.sub', ...)`
  por transacción) de `hoteles/packages/db/src/engines.ts::openManagedPostgres`, ya
  operado en producción para el vertical hoteles standalone. Implementa
  `TenancyEngine`/`TenantDbSession` de `@atiende/core-tenancy`.
- **Login end-to-end contra Postgres real** (`/auth/login`, `/auth/refresh`,
  `/auth/me`, `/auth/select-org`) — `apps/api/src/production/core-repository.ts`
  (`ProductionCoreRepository`) conecta `PostgresCoreRepository` (@atiende/db, ya
  existía) con `ManagedPostgresEngine` de arriba, siguiendo el patrón que el propio
  código ya documentaba ("se abre siempre vía `TenancyEngine.withAppSession({userId:
  null}, ...)`" — sesión de sistema, sin ambigüedad de diseño).

### 0.2 — Actualizado (barrido de documentación, rondas 13/14/16): el gap de
arquitectura de esta sección YA SE RESOLVIÓ

Esta sección describía, en la rama original de deploy config, un gap real:
`deps.restaurantesRepo`/`deps.hotelesRepo` eran objetos FIJOS construidos una sola
vez, incompatibles con RLS por-request. **Eso ya no es cierto.** Ver
`apps/api/src/production/deps.ts` y `apps/api/src/production/not-ready.ts` (su
propio comentario de cabecera documenta la resolución con detalle): `coreRepo`,
`restaurantesRepo`, `hotelesRepo`, `citasRepo`, `licitacionesRepo`, `despachosRepo`,
`rentasRepo` y `rentasOwnerPortalRepo` son hoy FÁBRICAS por-request
(`(db) => new Postgres*Repository(db)`), cada ruta las liga a la sesión
`dbSession(engine)`/`c.get("db")` de ESE request — el aislamiento RLS por-tenant
está intacto, nada de esto es un singleton compartido entre requests.

**Lo que de verdad sigue pendiente hoy no es arquitectura, son credenciales reales
de terceros** — cada pieza falla explícito (503 o error accionable, nunca datos
falsos) hasta que se configure:

| Puerto | Bloqueado por | Dónde |
|---|---|---|
| `turnHandler`/`hotelesTurnHandler`/`citasTurnHandler` (agente LLM de WhatsApp) | Ninguna API key de proveedor LLM configurada | `ANTHROPIC_API_KEY`+`ANTHROPIC_MODEL` / `OPENAI_API_KEY`+`OPENAI_MODEL` / `OPENROUTER_API_KEY`+`OPENROUTER_MODEL`, ver `.env.example` y `apps/api/src/production/llm-gateway.ts` |
| `whatsAppDispatcher` (envío saliente real de WhatsApp) | Sin `WHATSAPP_ACCESS_TOKEN` | `.env.example`, `apps/api/src/production/deps.ts` |
| `citasGoogleCalendarPortResolver` | Sin `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_OAUTH_REDIRECT_BASE_URL` | ídem — devuelve "sin conectar" honesto, nunca error, mientras falten |
| `hotelesCfdiPort` (timbrar/cancelar CFDI de hospedaje) | Sin credenciales/CSD reales de Finkok NI de SW Sapien | `.env.example` (`FINKOK_*`/`SW_*`), `packages/mcp-servers/cfdi/README.md` |
| `hotelesPaymentsPort` (cobro con tarjeta al huésped de un folio) | Sin `STRIPE_SECRET_KEY` — el adaptador real (PaymentIntents) ya existe | `.env.example`, `apps/api/src/production/hoteles-payments-port.ts` |
| `rentasCanalMensajeria` | Sin credencial de partner (Airbnb/Vrbo/Booking.com) — es un acuerdo de partner con cada plataforma, no solo una API key; responde 503 honesto ("canal no configurado") mientras tanto | `packages/domain-rentas/src/mensajeria/` |

**Consecuencia práctica:** con `DATABASE_URL` + los secretos de plataforma
(`JWT_SECRET`, `VOICE_TOOL_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`,
`INTERNAL_SECRET`, `RENTAS_OWNER_JWT_SECRET`) configurados, **login Y las rutas de
negocio de las 6 verticales (CRUD real contra Postgres, RLS por-tenant real)
funcionan de punta a punta** — lo que queda 503 explícito hasta pegar la credencial
correspondiente es SOLO la tabla de arriba (agente de WhatsApp con IA, envío
saliente de WhatsApp, Google Calendar, timbrado de CFDI, cobro de hoteles, canal de
mensajería de rentas, y 3 métodos del portal de onboarding de rentas).

### 0.3 — Migraciones: ya consolidadas en `supabase/migrations/`

Actualizado (barrido de documentación, rondas 13/14/16): esta sección describía 9
migraciones "todavía dispersas, ninguna copiada a `supabase/migrations/`" — eso
también quedó resuelto. `supabase/migrations/` ya contiene 109 archivos
(`20240101000001_...` a `20240101000109_...`, orden alfabético de nombre =
orden de aplicación, mismo criterio que documentaba esta sección), copia de TODAS
las migraciones reales de `packages/db/migrations/`,
`packages/core-conversation/migrations/` y de los 6 `packages/domain-*/migrations/`
a la fecha. Cada archivo fuente sigue viviendo en su paquete de origen (fuente
canónica, ver `packages/db/README.md` para la convención de numeración por bloques)
— `supabase/migrations/` es la copia consolidada con timestamp que `supabase db
push` aplica contra el proyecto real.

Único hallazgo real encontrado en este mismo barrido: `packages/domain-despachos/
migrations/002_migracion_catalogo_schema.sql` (la migración detrás de
`supabase/migrations/20240101000037_002_despachos_migracion_catalogo_schema.sql`)
NO tenía fuente canónica en su paquete — vivía SOLO como copia consolidada. Ya se
agregó (contenido idéntico, verificado con diff) — no reaplica ni cambia nada en un
proyecto Supabase ya migrado, solo restaura la convención de "el paquete de dominio
es la fuente".

`packages/core-conversation/migrations/001_conversation_state_cas.sql` sigue
requiriendo una tabla `conversations` con columna `metadata JSONB` que NINGUNA
migración de este repo crea todavía (dice explícito el comentario de ese mismo
archivo) — revisa ese gap antes de asumir que esa función en particular es
utilizable contra el proyecto real.

---

## Pasos exactos para Javier (en orden)

### (a) Crear el proyecto en supabase.com — requiere tu cuenta, gratis en el tier free
1. Entra a https://supabase.com/dashboard → "New project".
2. Elige la organización, nombre (ej. `atiende-fusion`), contraseña de DB (guárdala
   — la necesitas para `DATABASE_URL`) y región.
3. **Costo:** el tier free de Supabase (proyecto activo, 500MB DB, pausa tras 7 días
   de inactividad) no pide tarjeta para el primer proyecto en muchas cuentas, pero
   puede pedir método de pago según tu cuenta/región — no se cobra nada mientras te
   quedes en los límites free. Verifica en el checkout antes de confirmar.

### (b) Enlazar el CLI local al proyecto — gratis, no toca facturación
```bash
npx supabase login
npx supabase link --project-ref <tu-project-ref>
```
Reemplaza también `project_id` en `supabase/config.toml` por ese mismo ref.

### (c) Aplicar las migraciones — gratis, PERO revisa el Paso 0.3 primero
`supabase/migrations/` ya trae las 109 migraciones consolidadas (nada que copiar a
mano) — **decide qué hacer con la tabla `conversations` faltante** que bloquea
`packages/core-conversation/migrations/001_conversation_state_cas.sql` (crearla en
una migración nueva antes de esa, o dejarla sin aplicar hasta que exista) y corre:
```bash
npx supabase db push
```

### (d) Copiar `.env.example` a `.env` y pegar las keys reales — gratis
```bash
cp .env.example .env
```
Ver los comentarios de cada bloque en `.env.example` para saber exactamente qué lee
el código hoy y qué es solo referencia a futuro. Como mínimo para que **login Y las
rutas de negocio de las 6 verticales** (no solo login, ver Paso 0.2) funcionen de
punta a punta: `JWT_SECRET`, `VOICE_TOOL_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
`WHATSAPP_APP_SECRET`, `INTERNAL_SECRET`, `RENTAS_OWNER_JWT_SECRET` (generas tú
mismo, ej. `openssl rand -hex 32` para cada uno — nunca reutilices el mismo valor
entre `JWT_SECRET` y `RENTAS_OWNER_JWT_SECRET`), y `DATABASE_URL` (Project Settings
→ Database → Connection string, pooler de **transacción**, puerto 6543 — ver
comentario en `.env.example`). Sin `RENTAS_OWNER_JWT_SECRET` en particular,
`loadApiEnv()` lanza al arrancar — bloquea TODA la app, no solo rentas.

`.env` nunca se commitea (ya está en `.gitignore`).

### (e) `vercel link` — gratis, no dispara build todavía
```bash
npx vercel link
```

### (f) Configurar las mismas env vars en el dashboard de Vercel — gratis
Project → Settings → Environment Variables. Vercel nunca lee tu `.env` local — hay
que pegarlas a mano o con `vercel env add`.

**Además, agrega `CRON_SECRET` con el MISMO valor que `INTERNAL_SECRET`.**
`vercel.json::crons` (17 crons diarios a la fecha, uno por cada dispatcher/reminder
interno de cada vertical — citas, hoteles, restaurantes, despachos, rentas,
licitaciones, más el dispatcher de WhatsApp de plataforma; corre
`python3 -c "import json;print(len(json.load(open('vercel.json'))['crons']))"` para
confirmar el conteo vigente en cualquier momento) dispara un GET real a cada
`/internal/*` que Vercel autentica mandando `Authorization: Bearer $CRON_SECRET` —
sin esa variable configurada, el cron sigue disparándose pero la ruta responde 401
(fail-closed, nunca despacha nada sin autenticarse).

**ADVERTENCIA sin verificar desde este repo — revisar en el dashboard antes de
confiar en que estos 17 crons realmente corran:** la documentación pública de
Vercel para el plan Hobby (gratis) históricamente limita no solo la frecuencia
(máximo una vez al día por cron, que aquí sí se cumple — cada entrada usa un
horario fijo diario) sino también el **número total de cron jobs por proyecto**
(en distintos momentos ese tope ha sido tan bajo como 2). Este código no puede
consultar el plan ni la cuota real de la cuenta de Vercel del operador — solo se
puede documentar la sospecha. Antes de depender de que TODOS estos crons se
disparen en producción, entra a Vercel → Project → Settings → Cron Jobs (o a la
página de precios/límites vigente) y confirma cuántos permite el plan actual; si
excede el tope, la consola de Vercel normalmente rechaza el deploy o desactiva los
crons sobrantes en silencio, y ninguno de los dispatchers de este repo lo notaría
por sí solo.

### (g) `vercel --prod` — revisa esto antes de correrlo
1. Ya hay `vercel.json` en esta rama — un build ahora mismo SÍ compila (`apps/web` +
   la función `api/index.ts`), a diferencia de la rama anterior.
2. **Cuidado:** en el plan Hobby de Vercel, un deploy a producción SÍ puede activar
   dominios públicos y, si hay integraciones (GitHub, cron jobs, Vercel Postgres/KV,
   etc.), puede haber costo o efectos fuera del free tier — revisa Settings → Usage
   antes de confirmar, y no lo corras sin haber leído qué workflows de CI/CD dispara.
3. Con las keys del paso (d) puestas, **login funciona de punta a punta**
   (`/auth/login` contra Postgres real). Las rutas de `/v1/restaurantes/*` y
   `/hoteles/:propertyId/*` van a responder 500 explícito hasta resolver el Paso 0.2
   — no es un bug de este deploy, es el estado real documentado arriba.

---

## Resumen de costo por plataforma (tier free)

| Plataforma | Gratis mientras... | Empieza a costar cuando... |
|---|---|---|
| Supabase | 1 proyecto activo, <500MB DB, <2GB egress/mes, pausa tras 7 días sin uso | Excedes esos límites, necesitas más de 1 proyecto activo simultáneo, o pasas a plan Pro por soporte/uptime |
| Vercel (Hobby) | Uso personal/no-comercial, builds y bandwidth dentro de cuota | Uso comercial (Vercel lo exige explícito en sus términos), excedes cuota de builds/bandwidth, o agregas add-ons (Postgres, KV, Cron más allá del free) |
| Upstash Redis | Tier free (10K comandos/día aprox., 256MB) | Excedes esa cuota de comandos/almacenamiento |
| ElevenLabs | Cuota gratis muy limitada (minutos/mes) | Casi cualquier uso real de voz en producción |
