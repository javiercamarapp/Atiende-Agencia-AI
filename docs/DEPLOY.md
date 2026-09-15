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

### 0.2 — Todavía pendiente (gap real de arquitectura, no de configuración)

**Las rutas de negocio de restaurantes (`/v1/restaurantes/*`) y hoteles
(`/hoteles/:propertyId/*`) siguen SIN adaptador de producción**, a propósito.
`PostgresRestaurantesRepository`/`PostgresHotelesRepository` (@atiende/db) sí
existen y typechecan, pero — a diferencia de `CoreRepository` — dependen de RLS real
por-usuario (`auth.uid()` vía `core.has_property_access`/`hoteles.can_access_money`)
resuelta en la transacción que `dbSession(engine)` abre POR REQUEST
(`@atiende/core-auth/src/middleware.ts`), mientras que `deps.restaurantesRepo`/
`deps.hotelesRepo` son objetos FIJOS construidos una sola vez al armar `AppDeps` (ver
`apps/api/src/deps.ts` y cómo los consumen `routes/verticals/*/*.ts`: `const repo =
deps.hotelesRepo`, nunca `c.get("db")`). Conectar un `Postgres*Repository` real ahí
significaría fijarlo a UNA sola sesión — de sistema o de un usuario arbitrario — para
TODAS las requests, lo que rompería el aislamiento RLS por-tenant (fuga de datos
entre organizaciones) en vez de arreglar el gap.

Por eso `apps/api/src/production/deps.ts` conecta esos dos puertos (más
`turnHandler`/`hotelesPaymentsPort`) a `notProductionReady(...)`
(`apps/api/src/production/not-ready.ts`): cualquier request real a esas rutas falla
explícito con un 500 accionable, en vez de servir datos en memoria que parecen reales
pero se pierden en cada cold start y no aíslan tenants. **Resolver esto requiere una
decisión de arquitectura** (¿el puerto deja de ser un singleton y pasa a ser una
fábrica por-request que recibe `c.get("db")`? ¿otro mecanismo?) que packages/db/README.md
y apps/api/src/index.ts ya marcaban como "trabajo pendiente de infraestructura" —
este cambio de deploy config no la inventó ni la resolvió en silencio.

**Consecuencia práctica:** pegar las API keys reales deja *login* funcionando de
punta a punta. Los flujos de negocio de restaurantes/hoteles necesitan ese trabajo de
arquitectura adicional antes de servir tráfico real (ver `not-ready.ts` para el
detalle técnico completo).

### 0.3 — Migraciones: todavía dispersas, no consolidadas en `supabase/migrations/`

Verificado con grep sobre esta rama — estas son TODAS las migraciones SQL reales que
existen hoy, ninguna copiada aún a `supabase/migrations/`:

| Archivo | Schema que crea | Orden relativo |
|---|---|---|
| `packages/db/migrations/0001_core_schema.sql` | `core` (organization, property, staff_user, membership) | Primero — todo lo demás depende de `core.*` |
| `packages/domain-restaurantes/migrations/001_restaurantes_schema.sql` | `restaurantes` | Después de `core` |
| `packages/domain-restaurantes/migrations/002_calc_customer_tier.sql` | (funciones sobre `restaurantes.*`) | Después de 001 |
| `packages/domain-restaurantes/migrations/003_create_order_idempotent.sql` | (funciones sobre `restaurantes.*`) | Después de 002 |
| `packages/domain-restaurantes/migrations/004_whatsapp_atomic_append_and_rate_limit.sql` | (funciones sobre `restaurantes.*`) | Después de 003 |
| `packages/domain-hoteles/migrations/001_hoteles_schema.sql` | `hoteles` | Después de `core` |
| `packages/domain-hoteles/migrations/002_folio_engine_functions.sql` | (funciones sobre `hoteles.*`) | Después de 001 |
| `packages/domain-hoteles/migrations/003_availability.sql` | (funciones sobre `hoteles.*`) | Después de 002 |
| `packages/core-conversation/migrations/001_conversation_state_cas.sql` | funciones `get_conversation_state`/`set_conversation_state_cas` | **Requiere una tabla `conversations` con columna `metadata JSONB` que NINGUNA migración de este repo crea todavía** (dice explícito el comentario de ese mismo archivo, línea 11) — no la apliques contra el proyecto real hasta resolver esto o la función queda inservible. |

Numeración destino según `packages/db/README.md`: `0000–0099` núcleo, `0100–0199`
restaurantes, `0200+` el resto — sigue esa convención al copiar a
`supabase/migrations/<timestamp>_<nombre>.sql` (nombres de archivo, no de contenido:
`supabase db push` los aplica en orden alfabético de nombre de archivo).

No se copiaron automáticamente en esta rama para no inventar timestamps/orden sin que
alguien revise colisiones de nombre de tabla/función entre paquetes primero — son 9
archivos de 4 paquetes distintos, más riesgo de error que los 2 de la rama anterior.

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

### (c) Consolidar y aplicar las migraciones — gratis, PERO revisa el Paso 0.3 primero
Copia los 9 archivos de la tabla de arriba a `supabase/migrations/` con timestamps
que respeten el orden de la columna "Orden relativo", **y decide qué hacer con la
tabla `conversations` faltante** (crearla en una migración nueva antes de la 001 de
core-conversation, o dejar esa función sin aplicar hasta que exista) antes de correr:
```bash
npx supabase db push
```

### (d) Copiar `.env.example` a `.env` y pegar las keys reales — gratis
```bash
cp .env.example .env
```
Ver los comentarios de cada bloque en `.env.example` para saber exactamente qué lee
el código hoy y qué es solo referencia a futuro. Como mínimo para que **login**
funcione de punta a punta: `JWT_SECRET`, `VOICE_TOOL_SECRET`,
`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` (generas tú mismo, ej. `openssl rand
-hex 32`), y `DATABASE_URL` (Project Settings → Database → Connection string, pooler
de **transacción**, puerto 6543 — ver comentario en `.env.example`).

`.env` nunca se commitea (ya está en `.gitignore`).

### (e) `vercel link` — gratis, no dispara build todavía
```bash
npx vercel link
```

### (f) Configurar las mismas env vars en el dashboard de Vercel — gratis
Project → Settings → Environment Variables. Vercel nunca lee tu `.env` local — hay
que pegarlas a mano o con `vercel env add`.

**Además, agrega `CRON_SECRET` con el MISMO valor que `INTERNAL_SECRET`.**
`vercel.json::crons` (16 crons diarios a la fecha, uno por cada dispatcher/reminder
interno de cada vertical — citas, hoteles, restaurantes, despachos, rentas,
licitaciones, más el dispatcher de WhatsApp de plataforma; ver
`apps/worker/src/jobs/citas/README.md`) dispara un GET real a cada `/internal/*`
que Vercel autentica mandando `Authorization: Bearer $CRON_SECRET` — sin esa
variable configurada, el cron sigue disparándose pero la ruta responde 401
(fail-closed, nunca despacha nada sin autenticarse).

**ADVERTENCIA sin verificar desde este repo — revisar en el dashboard antes de
confiar en que estos 16 crons realmente corran:** la documentación pública de
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
