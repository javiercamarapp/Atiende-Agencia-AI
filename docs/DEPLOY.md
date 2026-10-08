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
  Incluye el bloque `headers` (cabeceras de seguridad; CSP en Report-Only) — ver
  `docs/SEGURIDAD-CABECERAS.md`, que también documenta `/health` y cómo promover la CSP.
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
| `turnHandler`/`hotelesTurnHandler`/`citasTurnHandler` (agente LLM de WhatsApp) | Ninguna API key de proveedor LLM configurada | `OPENROUTER_API_KEY` (proveedor primario; los modelos por rol salen de `apps/api/src/production/llm-models.ts` y de `LLM_MODELS_JSON`) o, solo como legado, `OPENAI_API_KEY`+`OPENAI_MODEL`; ver `docs/LLM-GATEWAY.md` y `apps/api/src/production/llm-gateway.ts` |
| `whatsAppDispatcher` (envío saliente real de WhatsApp) | Sin `WHATSAPP_ACCESS_TOKEN` | `.env.example`, `apps/api/src/production/deps.ts`; los avisos proactivos fuera de la ventana de 24 h solo se envian como plantilla HSM si ademas se declaran aprobadas en `WHATSAPP_APPROVED_TEMPLATES` |
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
también quedó resuelto. `supabase/migrations/` ya contiene todas las migraciones
reales consolidadas (orden alfabético de nombre = orden de aplicación, mismo
criterio que documentaba esta sección) — el conteo exacto se pudre rápido con
el ritmo de esta rama, así que no lo repitas de memoria NI como snapshot fechado
(los dos ya se desactualizaron más de una vez): corre
`ls supabase/migrations/*.sql | wc -l` o lee
`supabase/migrations/README.md`, que trae el detalle archivo por archivo y el
mismo comando. Es copia de TODAS las migraciones reales de `packages/db/migrations/`,
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
utilizable contra el proyecto real. Actualizado (fix/conversation-lock-upstash):
el único adaptador TypeScript que llamaba a esas 2 funciones RPC
(`PostgresStateStore`) se confirmó sin consumidor real en producción — nada en
`apps/api` lo instanciaba, `createDefaultConversationGuard()` usa
`InMemoryStateStore` — y se retiró del árbol para que el paquete no exporte un
adaptador "de producción" que en realidad no tiene tabla que leer/escribir. La
migración SQL se deja tal cual (no se borra, ver convención de
`supabase/migrations/README.md`) por si alguien construye la tabla y el
adaptador real más adelante.

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
`supabase/migrations/` ya trae todas las migraciones consolidadas (nada que copiar
a mano, ver arriba para cómo confirmar el conteo vigente) — **decide qué hacer con
la tabla `conversations` faltante** que bloquea
`packages/core-conversation/migrations/001_conversation_state_cas.sql` (crearla en
una migración nueva antes de esa, o dejarla sin aplicar hasta que exista) y corre:
```bash
npx supabase db push
```

**Orden de despliegue cuando una migración cambia a la vez SQL y la sesión con
que la API la invoca** — lección real de esta rama (migraciones
`20240101000127_0011_superadmin_caller_binding.sql`,
`20240101000128_0012_caller_binding_fase2.sql` y
`20240101000129_018_break_glass_wiring.sql`, ver `supabase/migrations/README.md`
para el detalle de cada una): esas tres migraciones atan funciones `security
definer` existentes a `auth.uid() = p_caller_id` (o `auth.uid() is null` para
las de sesión de sistema), y el código de `apps/api` (`production/
core-repository.ts`, `production/llm-usage-repository.ts`, rutas de
break-glass) se actualizó en la MISMA rama para abrir la sesión Postgres con el
`userId`/`callerId` real en vez de una sesión de sistema con el id pasado solo
como parámetro plano.

- **Mergear el PR a `main` NO aplica sus migraciones a la base real** — eso
  solo pasa cuando alguien corre `supabase db push` (o el gate de CI las aplica
  contra el Postgres efímero de la prueba, nunca contra el proyecto real) a
  mano. Los dos pasos (deploy de código en Vercel y `supabase db push`) son
  independientes y no ocurren automáticamente juntos.
- **Orden correcto: despliega primero el código nuevo de `apps/api`, aplica la
  migración después.** Con el código viejo (sesión de sistema, `userId: null`)
  contra las funciones YA endurecidas por la migración, cualquier llamada real
  de superadmin/break-glass se rompe (`auth.uid()` NULL nunca es igual a
  `p_caller_id`) — un apagón evitable. Con el código nuevo desplegado primero
  (ya abre la sesión con el id real) y la migración vieja todavía sin aplicar,
  todo sigue funcionando exactamente igual que antes (las funciones sin el
  guard nuevo no verifican `auth.uid()`, así que un `p_caller_id` correcto pasa
  igual) — no hay ventana rota. Aplicar la migración después solo cierra el
  hueco de seguridad, sin tocar ningún comportamiento legítimo ya validado por
  el código ya desplegado.
- Este mismo criterio aplica a cualquier migración futura que ate una función
  `security definer` a `auth.uid()`: si el caller (TypeScript) también cambia
  en la misma rama, despliega el caller primero.

**Hoteles H-02 (migración 032, consentimiento/ARCO/bloqueo/incidentes) — orden de despliegue.**
Mergear NO aplica `20240101000201_032_hoteles_consentimiento_arco_incidentes.sql` a la base real
(ver arriba) y esa migración **requiere la 031 (`20240101000200_031_hoteles_boveda_identidad.sql`)
ya aplicada**. El código nuevo funciona contra la base vieja (sin 031 o con 031 pero sin 032): las
lecturas de privacidad responden `disponible:false`, las escrituras 503, la captura de identidad sigue
sin ledger y el cron de retención cae a la purga directa de 031. Orden: (1) despliega el código; (2)
aplica 031 si falta y después 032 (`supabase db push`); (3) verifica `GET /internal/hoteles/identidad-purga`
(debe reportar `via_bloqueo:true`). Con 032 aplicada y el código viejo todavía en producción nada se
rompe: `purge_expired_identities` solo purga identidades ya bloqueadas con la ventana vencida. Desde que
se aplica 032 la purga deja de ser inmediata: una identidad vencida o con purga aprobada espera la ventana
de bloqueo (7 días por defecto, 3 a 30). No hay variables de entorno nuevas ni cambios en `vercel.json`.
Los plazos son decisiones de producto, no asesoría legal: ver `packages/domain-hoteles/README.md` §H-02.

**Restaurantes R-13 (migración 035, KPI de voz, costo por día y alertas) — orden de despliegue.** Mergear NO aplica
`20240101000246_035_restaurantes_voz_kpi_alertas_costo.sql` a la base real. El código nuevo funciona contra la base
vieja: la pestaña Indicadores del agente de voz muestra "no disponibles todavía", las lecturas responden
`disponible:false`, las escrituras (umbrales, eventos) 503 y no se rompe ningún flujo existente (cada consulta degrada con
SAVEPOINT). Orden: (1) despliega el código; (2) aplica la 035 (`supabase db push`; requiere 019, 022, 025 y 028 y las
tablas de costos `core.fx_rate`/`core.usage_cost_event`/`core.llm_usage_daily`); (3) captura un tipo de cambio en
`core.fx_rate` (sin él el costo en pesos sale "—"); (4) el servicio de voz debe empezar a reportar eventos a
`POST /internal/restaurantes/voz/eventos` (herramientas con latencia y errores de proveedor): hasta entonces el p95 y los
errores salen en cero / "—". Con la 035 aplicada y el código viejo en producción no se rompe nada: ningún código viejo usa
las tablas ni funciones nuevas. No hay variables de entorno nuevas ni cambios en `vercel.json`.

**Hoteles H-05 (migración 034, tickets de huésped con SLA) — orden de despliegue.** Mergear NO aplica
`20240101000218_034_guest_ticket_sla_escalacion.sql` a la base real. El código nuevo funciona contra la
base vieja: la pantalla Tickets avisa que aún no está activa, las lecturas responden `disponible:false`, las
escrituras 503 y el cron `/internal/hoteles/tickets-sla` omite las properties (`migracion_pendiente`).
Orden: (1) despliega el código; (2) aplica la 034 (`supabase db push`; requiere 013 y 033 ya aplicadas);
(3) verifica `GET /internal/hoteles/tickets-sla` con el secreto interno (debe reportar `omitida:null`);
(4) el cron ya está en `vercel.json` (cada 10 minutos, ver `docs/CRONS.md`).
Con la 034 aplicada y el código viejo en producción no se rompe nada: ningún código viejo usa las tablas
nuevas. No hay variables de entorno nuevas.

**Hoteles H-03 (migración 035, catálogo de agentes, aprobaciones humanas, plantillas y guardrails) — orden de
despliegue.** Mergear NO aplica `20240101000229_035_hoteles_agentes_aprobaciones.sql` a la base real. El código
nuevo funciona contra la base vieja: las pantallas Agentes y Aprobaciones avisan que aún no están activas, las
lecturas responden `disponible:false`, las escrituras 503, el cron `/internal/hoteles/aprobaciones-expiracion`
omite las properties (`migracion_pendiente`), el turno de WhatsApp corre como siempre (la compuerta devuelve
"activo" sin la 035) y el barrido de revenue no omite ninguna property. Orden: (1) despliega el código; (2) aplica
la 035 (`supabase db push`; requiere 001 y 030 ya aplicadas); (3) verifica `GET /internal/hoteles/aprobaciones-expiracion`
con el secreto interno (debe reportar `omitida:null`); (4) el cron ya está en `vercel.json` (cada hora, ver `docs/CRONS.md`). Con la 035 aplicada y el código viejo en producción no se rompe nada:
ningún código viejo usa las tablas nuevas. No hay variables de entorno nuevas. Hoy el agente de WhatsApp no
propone acciones sensibles por sí mismo (sus 3 herramientas no mueven dinero ni tarifas): la cola de aprobaciones
recibe propuestas de personas y está lista para las del agente (`PostgresAgentesRepository.proposeAction`).

**Hoteles H-06 (migración 036, grupos: cotización, bloqueo de cuartos con fecha de liberación, pickup, rooming y
anticipos registrados) — orden de despliegue.** Mergear NO aplica `20240101000241_036_hoteles_grupos.sql` a la base
real. El código nuevo funciona contra la base vieja: las lecturas de `/hoteles/:propertyId/grupos/*` responden
`disponible:false` con listas vacías, las escrituras 503 y la ruta interna `/internal/hoteles/grupos-liberacion` omite las
properties (`migracion_pendiente`). Orden: (1) despliega el código; (2) aplica la 036 (`supabase db push`; requiere 001,
003, 005, 030 y 035 ya aplicadas); (3) verifica `GET /internal/hoteles/grupos-liberacion` con el secreto interno (debe
reportar `omitida:null`). La liberación por cutoff es una función segura (`hoteles.group_release_due`, solo sesión de
sistema) y una ruta interna invocable a mano: ya está programada en `vercel.json` (diaria, 09:30 UTC; ver `docs/CRONS.md`). Con la 036
aplicada y el código viejo en producción no se rompe nada: ningún código viejo usa las tablas nuevas. No hay variables de
entorno nuevas. Los anticipos solo se REGISTRAN: no hay cobro ni pasarela.

**Hoteles H-25 (migración 037, agente de reservas por WhatsApp y voz) — orden de despliegue.** Mergear NO aplica
`20240101000250_037_hoteles_agente_reservas.sql` a la base real. El código nuevo funciona contra la base vieja: el agente de WhatsApp consulta
`hoteles.agent_booking_policy` al inicio de cada turno dentro de un SAVEPOINT; sin la 037 (42883/42P01) NO expone ninguna herramienta de reservas
y se comporta exactamente como antes; las rutas de voz `/v1/hoteles/:propertyId/voz/reservas/*` responden 200 con `requiere_humano:true` y las rutas
de staff `/hoteles/:propertyId/reservas-agente/*` degradan (`disponible:false`) o responden 503 en escrituras, nunca 500. Orden: (1) despliega el
código; (2) aplica la 037 (`supabase db push`; requiere 001, 003, 005, 029, 030, 035 y 036 ya aplicadas); (3) con la 037 aplicada el agente SIGUE sin
reservar: cada hotel debe habilitar la política (`PUT /hoteles/:propertyId/reservas-agente/politica`, owner/gm) — sin fila los holds están
deshabilitados; (4) las 6 herramientas de voz las ejecuta el worker de telefonía de `voice-core` contra `/v1/hoteles/:propertyId/voz/reservas/<herramienta>` con el
secreto de la property (el worker aún no existe en el repo; ya no hay nada que dar de alta en ElevenLabs). Con la 037 aplicada y el código viejo en producción no se rompe nada: ningún código viejo usa
las tablas nuevas. No hay variables de entorno nuevas ni cron nuevo: los holds vencen al consultar (y `hoteles.booking_hold_expire_due`, solo sesión
de sistema, queda disponible para un barrido manual). Los links de pago solo se REGISTRAN: no hay cobro ni pasarela.

**Hoteles H-27/H-28 (migración 038, recepción, ficha del huésped, cambio de habitación atómico) — orden de despliegue.**
Mergear NO aplica `20240101000263_038_hoteles_recepcion_ficha_huesped.sql` a la base real. El código funciona contra la base
vieja: el tablero de recepción, el check-in con la habitación ya asignada y el check-out usan solo tablas anteriores; asignar o cambiar
de habitación cae al camino anterior (asignación simple con revisión de traslape en la aplicación) en el check-in y responde 503
"no disponible aún" en `cambiar-habitacion`; la ficha del huésped y la bandera ARCO degradan a "no disponible". Orden: (1) despliega el código;
(2) aplica la 038 (`supabase db push`; requiere 001, 005, 018, 032, 033 y 035 ya aplicadas); (3) verifica en Recepción un cambio de habitación.
Con la 038 aplicada y el código viejo en producción no se rompe nada: ningún código viejo usa los objetos nuevos. No hay variables de entorno
ni cron nuevos. La función `hoteles.change_reservation_room` queda con la membresía revisada antes de bloquear la reserva solo tras la 041 (ver abajo).

**Hoteles H-28 cambio de fechas y H-12 lista de espera (migración 041) — orden de despliegue.** Mergear NO aplica
`20240101000273_041_hoteles_cambio_fechas_lista_espera.sql` a la base real. El código funciona contra la base vieja: la
previsualización del cambio de fechas es solo lectura y funciona (el cálculo usa tarifas y tablas anteriores); confirmar un cambio de fechas
responde 503 "no disponible aún", las lecturas de `/hoteles/:propertyId/lista-espera` responden `disponible:false` con lista vacía, las
escrituras 503, y cancelar una reserva o acortar fechas SI intenta ofrecer lugares, pero la oferta falla dentro de un SAVEPOINT (se omite sin tumbar la transaccion) y la cancelacion sigue funcionando como
hoy; `cambiar-habitacion` sigue funcionando (con la función de la 038). Orden: (1) despliega el código; (2) aplica la 041 (`supabase db push`;
requiere 001, 003, 005, 025/026, 035 y 038 ya aplicadas); (3) prueba en Reservas un cambio de fechas y una entrada de lista de espera. Con la 041
aplicada y el código viejo en producción no se rompe nada: ningún código viejo usa las tablas ni la función nuevas (la redefinición de
`change_reservation_room` conserva firma, reglas y errores; solo revisa la membresía antes de bloquear la fila). No hay variables de
entorno nuevas ni cron nuevo: las ofertas de la lista de espera vencen al consultar (la oferta vencida se marca `expirada` al listar o
al intentar aceptarla). Las ofertas solo AVISAN al staff con una notificación in-app; el envío al huésped por WhatsApp no está conectado
(depende de la integración con Meta, H-23).

**Migración `0026_staff_totp_stepup_reset.sql` (segundo factor TOTP, reset/cambio de
contraseña, verificación de correo)** — cualquier orden de despliegue es seguro: el
código de `apps/api` captura SQLSTATE 42883/42P01/42703 y degrada (sin migración, las
transiciones sensibles del contrato siguen exigiendo solo el rol y las rutas `/auth/2fa/*`
responden 503 "no disponible aún"). Dos efectos a tener en cuenta DESPUÉS de aplicarla:
(1) rescindir, penalizar, modificar, marcar en inconformidad y marcar pago de un contrato
pasan a exigir que el usuario tenga 2FA activo (Seguridad de la cuenta) y un código
reciente; avisa a los usuarios antes de aplicarla. (2) El secreto TOTP se guarda cifrado con
una clave derivada de `JWT_SECRET`: rotar `JWT_SECRET` deja ilegibles los secretos TOTP ya
dados de alta (cada usuario tendría que desactivar —con un código de respaldo— y volver a
activar el 2FA).

**Además de lo de abajo, desde el 19-sep-2026 `.github/workflows/ci-checks.yml`
corre en cada `pull_request`/`push` a `main` que toque `apps/**`, `packages/**`,
`docs/DEPLOY.md`, `supabase/migrations/README.md` o cualquier archivo fuera
de `docs/**`/`*.md` (workflow separado, en paralelo al de Postgres real, con
sus propias exclusiones de paths — ver su comentario de cabecera):
`npm run typecheck`, `npm run lint`, `npm run test:unit` y el build de
`apps/web`. Antes de eso ese tier corría solo a mano por quien hacía el
cambio — ver el comentario de cabecera de ese workflow.**

**Dos guards que corren en CI antes de tocar Postgres, no solo de memoria:**

- `npm run verify:migration-versions` (`scripts/verify-migration-versions/`) —
  falla si dos archivos de `supabase/migrations/` comparten prefijo de
  timestamp (colisión real, ya pasó varias veces en esta rama con PRs
  paralelos) o si un espejo diverge en contenido de su fuente real en
  `packages/*/migrations/`. Corre como paso propio de
  `.github/workflows/postgres-real-gate.yml`, antes de instalar `psql` y
  esperar a que el servicio Postgres levante — falla rápido y barato. Es el
  ÚNICO lugar donde este guard corre contra el árbol real de
  `supabase/migrations/`: `packages/db/tests/migration-versions-guard.spec.ts`
  (dentro de `npm run test:unit`, y por lo tanto de `ci-checks.yml`) solo
  prueba la lógica del checker contra árboles sintéticos en un directorio
  temporal, nunca contra el árbol real.
- El **gate de Postgres real** (`scripts/verify-real-postgres-ci/`,
  `run-gate.mjs`) descubre y corre automáticamente cualquier `scripts/verify-*/`
  con el contrato de 3 archivos (`bootstrap.sql`/`post-migrations.sql`/
  `assertions.sql`) — se agregan seguido, así que esta lista se desactualiza
  fácil; hoy son `verify-caller-binding-fase2`, `verify-hoteles-sql-critico`,
  `verify-llm-usage-budget-guard`, `verify-outbox-grants`,
  `verify-rentas-break-glass`, `verify-rentas-cron-rls`,
  `verify-restaurantes-sql`, `verify-superadmin-caller-binding`,
  `verify-superadmin-facturacion`, `verify-superadmin-salud` (ver el
  `README.md` de cada uno). Levanta un cluster Postgres efímero real
  (`initdb`/`pg_ctl`/`psql`), aplica todas las migraciones reales desde cero
  (`ls supabase/migrations/*.sql | wc -l` para el conteo vigente, no lo
  repitas aquí) y corre
  cada escenario como su propia aserción pass/fail — nunca contra el proyecto
  Supabase real de producción, y nunca lectura humana de la salida de `psql`.

**Todo fallback por SQLSTATE dentro de una transacción exige SAVEPOINT** —
lección real de la auditoría a1 (hallazgos CRÍTICO/ALTO corregidos vía
`runWithSavepointFallback`, `packages/db/src/savepoint-fallback.ts`; ver
`scripts/verify-fallback-savepoint/` para la demostración a nivel SQL). Ya
quedó establecido arriba que el código nuevo debe capturar el SQLSTATE de
una función/tabla/columna que solo existe tras una migración pendiente
(`42883`/`42P01`/`42703`) o de un CHECK que un valor nuevo todavía no cubre
(`23514`, u otro código de negocio equivalente) y degradar al camino
anterior — eso sigue siendo correcto. Lo que un `try/catch` simple **no**
resuelve es que ese fallback corre **dentro de la MISMA transacción** del
request (`ManagedPostgresEngine.withAppSession`, un solo `begin...commit`
por request — ver `packages/db/src/managed-postgres-engine.ts`) o de un
lote (ej. el cron de reconciliación de citas):

- En Postgres real, **cualquier error dentro de un bloque de transacción la
  deja "abortada"** — la SIGUIENTE consulta (el propio camino de respaldo)
  falla con `25P02` ("current transaction is aborted, commands ignored
  until end of transaction block"), sin importar que sea una consulta
  totalmente distinta a la que falló.
- Un **`COMMIT` sobre una transacción abortada NO lanza error**: Postgres
  lo trata como `ROLLBACK` implícito y devuelve ESE tag de comando. El
  handler HTTP responde 200/201 normalmente, con TODO lo escrito en el
  request revertido **en silencio** — el caso real que motivó este PR:
  una cita, su correo encolado y su rate-limit revertidos sin que el
  cliente ni los logs lo noten.
- **La solución**: envolver el camino primario en `SAVEPOINT`, y ante un
  error recuperable hacer `ROLLBACK TO SAVEPOINT` + `RELEASE SAVEPOINT`
  (que SÍ están exentos del bloqueo de "transacción abortada") ANTES de
  correr el camino de respaldo — usa `runWithSavepointFallback`
  (`@atiende/db`) en vez de repetir el patrón a mano; ya lo usan
  `domain-citas/src/postgres-repository.ts` (`markAppointmentGoogleSyncInvalid`,
  `resolveProviderCalendarRefreshToken`, `resolveProviderCalComApiKey`,
  `resolveProviderCalDavPassword`, `runWithRowSavepoint`),
  `domain-restaurantes/src/postgres-repository.ts`/`domain-hoteles/src/
  postgres-repository.ts` (`runWithRowSavepoint`, mismo helper que citas) y
  `packages/db/src/postgres-core-repository.ts` (`findStaffForOrgAdmin`,
  `isStaffOrgMember`, `recordBillingWebhookEvent`,
  `listBillingWebhookLogForSuperadmin`). `upsertCustomer` (mismo archivo,
  `sp_upsert_customer_race`) sigue con el `SAVEPOINT`/`ROLLBACK TO SAVEPOINT`
  manual anterior a este helper — no migrado por este PR, mismo mecanismo,
  distinta implementación.
- **Defensa de último recurso en el motor**: `withAppSession` detecta si el
  `COMMIT` final devolvió el tag `ROLLBACK` (en vez de `COMMIT`) y lanza un
  error explícito — convierte cualquier catch futuro que se olvide del
  SAVEPOINT en un 500 ruidoso en vez de un 200/201 silenciosamente
  incorrecto. Si un flujo legítimo dependía de tragarse un error sin
  SAVEPOINT (ej. una sincronización "best-effort" que nunca debe tumbar el
  request, o un tool call de un agente de WhatsApp con LLM real que corre
  DENTRO del `withAppSession` del turno completo — ver `executeToolCall` en
  cada `domain-*/src/whatsapp/llm-turn-handler.ts`), la corrección es agregar
  SAVEPOINT a ESE flujo (ver `tryTriggerCalendarSync`/
  `CitasRepository.runWithRowSavepoint`, y su equivalente por tool call en
  los 3 turn handlers de WhatsApp), nunca relajar esta defensa.

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
`vercel.json::crons` (29 crons; ver la tabla y las reglas en [`docs/CRONS.md`](./CRONS.md); antes eran 21 diarios, uno por cada dispatcher/reminder
interno de cada vertical — citas, hoteles, restaurantes, despachos, rentas,
licitaciones, más el dispatcher de WhatsApp de plataforma; corre
`python3 -c "import json;print(len(json.load(open('vercel.json'))['crons']))"` para
confirmar el conteo vigente en cualquier momento) dispara un GET real a cada
`/internal/*` que Vercel autentica mandando `Authorization: Bearer $CRON_SECRET` —
sin esa variable configurada, el cron sigue disparándose pero la ruta responde 401
(fail-closed, nunca despacha nada sin autenticarse).

**Checklist para que los crons corran de verdad (hoy `core.cron_heartbeat` tiene 0 filas: ningún cron ha dejado latido):**

- [ ] El proyecto de Vercel es **Pro** (los crons de cada 5, 10, 15 y 30 minutos no caben en Hobby; ver la advertencia de abajo).
- [ ] `CRON_SECRET` = `INTERNAL_SECRET` en el entorno Production. Sin él, cada cron responde 401 y no deja latido.
- [ ] Vercel → Project → Settings → Cron Jobs lista los 38 crons de `vercel.json`.
- [ ] Variable de **repositorio** (no secreto) `PROD_BASE_URL` = `https://<dominio de producción>` en GitHub → Settings → Secrets and variables → Actions → Variables. Sin ella `prod-health.yml` no sondea y deja un `::warning::` en cada corrida. Opcional: `PROD_HEALTH_OPEN_ISSUE=true` para que además abra un issue mientras dure la falla.
- [ ] Al desplegar, `GET /health` anónimo trae `"crons"`: pasa de `sin_latido` a `ok` en cuanto cada cron corre una vez (los de 5 minutos, en minutos). Detalle en [`docs/CRONS.md`](./CRONS.md#cómo-saber-que-corren).

**ADVERTENCIA: estos 30 crons requieren Vercel Pro (Hobby: 2 crons diarios; el deploy falla con crons más frecuentes). Sin verificar desde este repo — revisar en el dashboard antes de
confiar en que estos 29 crons realmente corran:** la documentación pública de
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

## Go-live de una organización: verificación "Listo para producción"

Antes de conectar el número real de una organización, corre la vista **Listo para producción** (ficha de la organización en `/superadmin`) o
`npm run verify:go-live` — el orden de la lista y qué verificación cubre cada paso están en [`docs/GO-LIVE.md`](GO-LIVE.md). **Antes de fusionar a
`main` el cambio que vuelve obligatoria `APP_BASE_URL` en producción, define `APP_BASE_URL` (https) en Vercel → Production**: sin ella la API no arranca.

## Rentas — sync iCal cada 15 minutos (Rn-01): propuesta de cron, DECISIÓN DE JAVIER

**Estado histórico (ya cambiado; hoy corre `*/15 * * * *`, ver `docs/CRONS.md`):** `/internal/rentas/ical-sync` corría **una vez al día**
(`vercel.json`: `45 14 * * *`). Entre dos corridas una reserva tomada en Airbnb/Booking/
Vrbo no se refleja aquí hasta 24 h, y viceversa: esa ventana es el riesgo real de
overbooking. **Este PR NO cambia `vercel.json` ni ninguna cadencia** (cambiarla es una
decisión de costo/plan que no se toma desde el código).

**Qué sí deja listo el código** (migración `024_rentas_ical_sync_lease_backoff_bitacora.sql`
+ `ejecutarLoteSync`): el endpoint ya es un lote idempotente seguro para correr con mucha
más frecuencia —

- *claim/lease por feed*: dos instancias del cron a la vez (reintento de Vercel, disparo
  manual) nunca procesan el mismo feed; si una muere, el lease (120 s) expira solo;
- *piso de espaciamiento* de 10 min por feed: un cron más frecuente de lo previsto no
  golpea de más a los canales;
- *backoff por feed fallido*: 30 min, 1 h, 2 h, 4 h y tope de 6 h tras 1, 2, 3, 4 y 5+
  fallos consecutivos; un éxito lo limpia y reconectar el feed lo reinicia;
- *presupuesto de tiempo*: deja de reclamar a los 10 s (la función tiene `maxDuration` de
  30 s y el fetch de un feed puede tardar hasta 15 s) y devuelve los feeds no alcanzados al pool para la siguiente corrida;
- *bitácora/alertas* (`rentas.ical_sync_bitacora`) y *monitor de conflictos* en el panel
  (Operación → Monitor de conflictos).

**Cron propuesto (NO aplicado):**

```json
{ "path": "/internal/rentas/ical-sync", "schedule": "*/15 * * * *" }
```

(reemplazaría la entrada `"45 14 * * *"` de ese mismo path; sigue siendo 1 cron job, no
agrega uno nuevo al conteo del proyecto).

**Impacto en el plan de Vercel (sin verificar desde este repo):** los crons de más de
una vez al día **no están disponibles en el plan Hobby** (máximo uno al día por cron;
en Hobby un schedule más frecuente hace fallar el deploy). Hace falta **Vercel Pro**
(o mover este endpoint a un scheduler externo —p. ej. un cron de GitHub Actions o un
worker— que le haga GET con `Authorization: Bearer $CRON_SECRET`). Además cada
invocación consume tiempo de función: 96 invocaciones/día de este endpoint (hoy 1) —
revisa en Vercel → Usage cuánto de la cuota de Functions/Cron del plan te quedaría.
Con el lote acotado a ~10 s de presupuesto y feeds que no cambian respondiendo 304 (ETag), el costo
por invocación es bajo, pero eso hay que medirlo en producción, no se asume.

**Orden de despliegue de este PR (seguro en cualquier orden, ninguno es bloqueante):**
1. Mergear el código: contra la base SIN la migración 024 el cron cae solo al barrido
   anterior (`modo: "sin_lease"` en la respuesta), el monitor muestra las alertas como
   "no disponibles aún" y resolver conflictos responde 409 legible; nada se rompe.
2. Aplicar `024` a la base real (`supabase db push`, lo hace Javier): desde la siguiente
   corrida del cron el modo pasa a `"lease"` y se activan bitácora, alertas y resolver.
3. Solo cuando Javier decida (y el plan de Vercel lo permita): cambiar el schedule a
   `*/15 * * * *` en `vercel.json`.

---

## Voz de restaurantes — secreto por sucursal y token por llamada (migración 026)

Mergear el código NO exige aplicar la migración `026_voz_secretos_sucursal_y_estado_pedido.sql`
(espejo `supabase/migrations/20240101000199_026_*`): sin ella el código cae al secreto global
`VOICE_TOOL_SECRET`, sin estado de pedido en servidor y sin bitácora de voz (registra un aviso en
logs). Orden recomendado:

1. Desplegar el código (funciona contra la base sin migrar).
2. Aplicar la migración 026 (la aplica Javier; es solo aditiva).
3. Rotar el secreto de cada sucursal:
   `POST /v1/restaurantes/:propertyId/admin/config/sucursales/:branchId/voz/secreto` (owner/admin; el
   secreto se muestra una sola vez). El secreto anterior sigue válido durante la ventana de gracia.
4. Configurar la herramienta de voz para pedir un token por llamada
   (`POST /v1/restaurantes/:org/voice/call-token` con el secreto) y enviarlo en `x-atiende-call-token`.
5. Solo entonces, poner `VOICE_REQUIRE_CALL_TOKEN=true` en Vercel. Antes de ese paso el camino legado
   (secreto global sin token) sigue funcionando, sin estado por llamada ni teléfono ligado al token.

## Chatea con tus datos (restaurantes piloto) — migración 0029

Detalle de diseño y seguridad: `docs/DATA-CHAT.md`. Mergear el código NO exige aplicar la migración
`0029_data_chat_query_log.sql` (espejo `supabase/migrations/20240101000217_*`): sin ella las consultas se
registran como una línea de log estructurada (sin resultados ni PII) en vez de en
`core.data_chat_query_log`, y todo lo demás funciona igual. Orden recomendado:

1. Desplegar el código (funciona contra la base sin migrar; `GET .../admin/chat-datos/estado` responde
   `available: false` si no hay ningún proveedor LLM y el botón sigue diciendo "Pronto").
2. Aplicar la migración 0029 (la aplica Javier; es solo aditiva: tabla nueva + una función).
3. Tener al menos un proveedor LLM configurado (`OPENROUTER_API_KEY`; opcional `LLM_MODELS_JSON`; el legado
   `OPENAI_API_KEY`+`OPENAI_MODEL` solo aplica sin llave de OpenRouter). El gasto del chat cuenta contra `core.llm_org_budget` (tope mensual por organización) y
   queda en `core.llm_usage_daily` con el rol `restaurantes:data_chat`.
4. Para apagarlo sin desplegar: interruptor de plataforma `agente` → `restaurantes:data_chat`.

### Chatea con tus datos — hoteles y rentas vacacionales (sin migración nueva)

Este PR NO agrega SQL: usa solo tablas que ya existen (`hoteles.*`, `rentas.*`) y la bitácora genérica
`core.record_data_chat_query` (0029). Mergear el código no cambia nada para quien no tenga el asistente activo.
Orden recomendado:

1. Desplegar el código. Funciona contra la base sin migrar: si falta una tabla/columna de una consulta
   (p. ej. `hoteles.guest_ticket` o `rentas.owner_statement`), esa herramienta responde "esa información todavía no
   está disponible" y la transacción de la request sigue sana (cada consulta va en SAVEPOINT).
2. (Opcional) Aplicar la migración 0029 si aún no está (bitácora en `core.data_chat_query_log`; sin ella queda
   una línea de log estructurada sin resultados ni PII).
3. Tener un proveedor LLM configurado (`OPENROUTER_API_KEY`, o el legado `OPENAI_API_KEY`+`OPENAI_MODEL`).
   Los roles nuevos `hoteles:data_chat` y `rentas:data_chat` cuentan contra `core.llm_org_budget` y quedan en
   `core.llm_usage_daily`.
4. Quién lo ve: hoteles solo `owner`/`gm`; rentas solo `admin_gestora`/`contador`. Para el resto de roles
   `GET /hoteles/:propertyId/chat-datos/estado` (o `/rentas/...`) responde 403 y el botón sigue diciendo "Pronto".
5. Para apagarlo sin desplegar: interruptor de plataforma `agente` → `hoteles:data_chat` / `rentas:data_chat`.
6. Verificación contra Postgres real (la corre el gate de CI): `node scripts/verify-real-postgres-ci/run-gate.mjs
   scripts/verify-data-chat-hoteles` y `.../verify-data-chat-rentas`.

### Chatea con tus datos — citas (C-10) — migración 027

Detalle en `docs/DATA-CHAT.md` ("Catálogo de citas"). Mergear el código NO exige aplicar la migración
`packages/domain-citas/migrations/027_citas_data_chat_recordatorios.sql` (espejo
`supabase/migrations/20240101000237_027_citas_data_chat_recordatorios.sql`): sin ella solo falta el detalle de
recordatorios enviados/fallidos (la herramienta `recordatorios` lo avisa) y las otras siete herramientas funcionan igual.
Orden recomendado:

1. Desplegar el código (funciona contra la base sin migrar; cada consulta va en SAVEPOINT y responde "todavía no está
   disponible" si falta una tabla, columna o función, sin abortar la transacción de la request).
2. (La aplica Javier; es solo aditiva: una función nueva) Aplicar la migración 027. Con ella, `recordatorios` suma el
   estado de envío por canal.
3. (Opcional) Aplicar la migración 0029 si aún no está (bitácora `core.data_chat_query_log`, ya acepta la vertical `citas`).
4. Tener un proveedor LLM configurado. El rol nuevo `citas:data_chat` cuenta contra `core.llm_org_budget` y queda en
   `core.llm_usage_daily`.
5. Quién lo ve: solo `owner` y `admin`; para `staff` `GET /citas/:propertyId/chat-datos/estado` responde 403 y el botón
   sigue diciendo "Pronto".
6. Para apagarlo sin desplegar: interruptor de plataforma `agente` → `citas:data_chat`.
7. Verificación contra Postgres real (la corre el gate de CI): `node scripts/verify-real-postgres-ci/run-gate.mjs
   scripts/verify-data-chat-citas`.

## Voz de citas sobre voice-core: orden de despliegue

No hay SQL ni variables de entorno nuevas: el código se despliega con el merge y funciona contra la base actual. Las 4 rutas antiguas del agente de
ElevenLabs de citas (`/v1/citas/:orgSlug/{availability,services,providers,customers/appointments}`) se retiraron; si algún agente externo de ElevenLabs
las seguía llamando con `VOICE_TOOL_SECRET`, dejará de funcionar (nada del repo las usa). Las nuevas rutas del worker (`/v1/citas/:orgSlug/voz/...`)
usan el mismo `VOICE_TOOL_SECRET`. La vista previa del panel exige `GEMINI_API_KEY` y `VOICE_PREVIEW_TOKEN_SECRET`; sin ellas el panel muestra "voz no
configurada" y la API responde 503. El costo por llamada (`core.record_usage_cost_event`, migración 0028 de core) queda "no disponible aún" si esa
migración no está aplicada. Atender llamadas reales requiere además el worker de telefonía (LiveKit SIP + Twilio), que aún no existe en el repo.

## Resumen de costo por plataforma (tier free)

| Plataforma | Gratis mientras... | Empieza a costar cuando... |
|---|---|---|
| Supabase | 1 proyecto activo, <500MB DB, <2GB egress/mes, pausa tras 7 días sin uso | Excedes esos límites, necesitas más de 1 proyecto activo simultáneo, o pasas a plan Pro por soporte/uptime |
| Vercel (Hobby) | Uso personal/no-comercial, builds y bandwidth dentro de cuota | Uso comercial (Vercel lo exige explícito en sus términos), excedes cuota de builds/bandwidth, o agregas add-ons (Postgres, KV, Cron más allá del free) |
| Upstash Redis | Tier free (10K comandos/día aprox., 256MB) | Excedes esa cuota de comandos/almacenamiento |

---

## Rentas — reportes (Rn-03) y liberación de acceso al huésped (Rn-04): orden de despliegue y cron, DECISIÓN DE JAVIER

**Rn-03 (reportes de ocupación e ingresos) no necesita migración**: solo lee tablas que
ya existen desde `001`/`003` (`rentas.ocupacion`, `rentas.unidad`, `rentas.canal`,
`rentas.reserva_financiero`, `rentas.property_config`). Se despliega con el código; si
`rentas.reserva_financiero` no existiera o no fuera legible en la base real, el reporte
responde `financiero_disponible: false` con noches y ocupación (montos en cero), nunca 500.

**Rn-04 (liberación de instrucciones de acceso) sí necesita la migración**
`packages/domain-rentas/migrations/025_rentas_acceso_huesped.sql` (espejo
`supabase/migrations/20240101000225_025_rentas_acceso_huesped.sql`). Orden:

1. Mergear el PR (el código sale a Vercel y ya es seguro contra la base sin migrar: las
   rutas de configuración responden `disponible: false`/409 "aún no disponible" y el
   cron, si alguien lo dispara, responde `ok` con `disponible: false` y no hace nada).
2. Aplicar la migración `025` a la base real (Supabase). Es aditiva: tablas y funciones
   nuevas, no toca ninguna existente.
3. Con la migración aplicada, el staff (`admin_gestora` / `operador:acceso_total`)
   configura por property la política (horas antes del check-in, hora local de check-in,
   si exige pago, si una reserva de canal OTA cuenta como pagada) y por unidad las
   instrucciones. La política nace **apagada**: nada se libera hasta activarla.
4. Agendar (o disparar a mano) el cron — ver abajo.

**El cron ya está en `vercel.json`** (cada hora, minuto 10; ver `docs/CRONS.md`). Endpoint listo: `GET|POST /internal/rentas/acceso-huesped`
(mismo guard que `checkin-recordatorio`: `Authorization: Bearer $CRON_SECRET` o
`x-atiende-internal-secret`). Una transacción por reserva, idempotente (`dedupe_key`
`acceso:<reserva>` en el outbox + marca de liberación), tope de 50 reservas por corrida.

**Cron propuesto (NO aplicado):**

```json
{ "path": "/internal/rentas/acceso-huesped", "schedule": "30 14 * * *" }
```

Con una corrida diaria la ventana de liberación se cumple con hasta 24 h de holgura:
si la política es "24 h antes" y el cron corre una vez al día, la instrucción puede salir
entre 0 y 24 h *antes* de lo configurado. Para que "N horas antes" sea preciso hace falta
una cadencia mayor (p. ej. cada hora, `0 * * * *`), con las mismas restricciones de plan
que el cron de iCal arriba (los crons de más de una vez al día requieren **Vercel Pro** o
un scheduler externo con `Authorization: Bearer $CRON_SECRET`). Cada corrida sin reservas
elegibles hace 1 consulta corta.

Si lo agendas: agrega también `"/internal/rentas/acceso-huesped"` a `SWITCHABLE_CRONS`
(`apps/api/src/platform-switches.ts`) para poder pausarlo desde superadmin (un test exige
que todo cron detenible esté en `vercel.json`, por eso no se agregó antes).

**Qué cuenta como "pagada"** (rentas no tiene un libro de pagos del huésped;
`reserva_financiero.monto_recibido_centavos` es el neto tras comisión de canal, no un
cobro): (a) el staff confirma el pago de la reserva
(`POST /rentas/:propertyId/reservas/:ocupacionId/pago-confirmado`) o (b) la reserva viene
de un canal OTA (Airbnb/Vrbo/Booking) y la política `ota_cuenta_como_pagada` está activa
(por defecto sí: la plataforma cobra al reservar). Con `exigir_pago` apagado no se pide pago.

**Entrega**: por correo, vía `rentas.messaging_outbox` (el mismo dispatcher de Resend que
ya usan confirmación y recordatorio de check-in). Solo reservas con un correo válido en
`guest_minimo.contacto`; las de canal sin correo quedan en la bitácora como
`omitida_sin_contacto`. Nota de retención: el correo con el código viaja en
`messaging_outbox.payload`, que hoy no se purga tras el envío (es una tabla sin acceso para
`authenticated`, solo la función de sistema y `service_role`); cambiar el código de la
cerradura entre estancias sigue siendo la mitigación real.

## Rentas — privacidad (Rn-29 cifrado del acceso, Rn-30 retención, Rn-07 ARCO): orden de despliegue

Migración única `packages/domain-rentas/migrations/028_rentas_privacidad_cifrado_arco_retencion.sql` (espejo
`supabase/migrations/20240101000278_028_rentas_privacidad_cifrado_arco_retencion.sql`). Es aditiva, **requiere** la migración
`packages/db/migrations/0036_plataforma_arco_retencion_aviso.sql` (espejo `...000238_...`) ya aplicada, y **redefine dos funciones de
core** (`core._arco_union()` y `core.system_run_retention_purge(...)`) agregando solo las ramas de rentas. Antes de mergear nada: el código
sale a Vercel y es seguro contra la base sin migrar (rutas con `disponible: false` / 503 explícito, nunca 500).

1. Mergear el PR.
2. Crear la llave en Vercel (Production y Preview de la API): `openssl rand -base64 32` → `RENTAS_ACCESS_KEY` (opcional
   `RENTAS_ACCESS_KEY_VERSION`, por defecto 1). Guárdala además en un gestor de secretos con respaldo: perderla vuelve ilegibles las
   instrucciones ya cifradas. Sin llave, leer o guardar instrucciones de acceso responde 503 "no disponible: falta RENTAS_ACCESS_KEY".
3. Aplicar la migración 028 a la base real. Hasta aquí, nada cambia para el staff.
4. Cifrar lo que ya existe en texto plano (idempotente; repetir hasta `ok: true` y `cifradas: 0`; `fallidas > 0` o `ok: false` indican filas que siguen en claro):
   `curl -X POST -H "x-atiende-internal-secret: $INTERNAL_SECRET" "https://<api>/internal/rentas/acceso-cifrar?limite=50"`.
   La columna en claro solo se anula después de cifrar y verificar el ida y vuelta. No está en `vercel.json`.
5. Retención (Rn-30): las clases `rentas_huesped_pii` y `rentas_acceso_instrucciones` (90 días por defecto, rango 30 a 730) se purgan con
   el endpoint interno de PL-13. Primero **simulación** (sin `ejecutar=1`) para una organización y revisar `core.purge_run_log`; el cron
   de purga no se agenda (decisión de costo). Ver `docs/PRIVACIDAD-PLATAFORMA.md`.
6. ARCO (Rn-07): el admin de la gestora registra y atiende solicitudes en `/rentas/<org>/privacidad`; la vista de toda la organización
   está en `/rentas/<org>/privacidad-organizacion`.
