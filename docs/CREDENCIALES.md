# Credenciales — inventario y estado de integraciones

Punto único de consulta de qué variable de entorno hace falta para que este
producto quede "100% listo, solo falta pegar APIs". Generado leyendo el código
real (`process.env.*`, `import.meta.env.*`, `requireEnv(...)`,
`checkEnvCredentials(...)`, incluidas lecturas dinámicas), no de memoria — ver
`apps/api/tests/env-inventory-guard.spec.ts` para el guard que impide que esta
lista se desactualice en silencio.

**Fuente única de verdad**: `apps/api/src/integrations-status.ts` (función pura
`computeIntegrationsStatus`). Este documento es la versión en prosa; para el
estado real de ESTE entorno (nunca imprime valores, solo nombres y booleanos):

- CLI: `npm run verify:env`
- HTTP: `GET /superadmin/integraciones` (protegida exactamente igual que el resto
  de `apps/api/src/routes/superadmin.ts` — solo superadmin de plataforma)

Convención de las tablas de abajo: **Secreta** = nunca debe verse en logs/commits.
**Arranque** = si falta, `loadApiEnv()`/`buildProductionDeps()` lanzan y la API
**entera** no arranca (no es un 503 por ruta). Sin esa marca, la variable es
opcional: su ausencia degrada esa integración a un 503/estado "no conectado"
explícito, nunca a datos falsos.

## Secretos propios (los generas tú, no los "pegas" de ningún proveedor)

| Variable | Cómo generarla | Secreta | Habilita | Sin ella | Arranque |
|---|---|:-:|---|---|:-:|
| `JWT_SECRET` | `openssl rand -hex 32` (o equivalente) | Sí | Firma/verificación de access y refresh tokens de staff (`routes/auth.ts`) | La API no arranca (`env.ts::requireEnv`) | **Sí** |
| `VOICE_TOOL_SECRET` | `openssl rand -hex 32` | Sí | Autentica llamadas ENTRANTES de ElevenLabs Server Tools (header `x-atiende-tool-secret`) en los agentes de voz de citas/hoteles/restaurantes (`routes/verticals/*/voice-tools.ts`) — **no** requiere ninguna API key de ElevenLabs, ver sección "Voz" abajo | La API no arranca | **Sí** |
| `INTERNAL_SECRET` | `openssl rand -hex 32` | Sí | Autentica las ~18 rutas `/internal/*` que Vercel Cron invoca a diario (`Authorization: Bearer $CRON_SECRET`) o que se llaman a mano (header `x-atiende-internal-secret`) — ver `http-security.ts::internalOrCronSecretMatches` | La API no arranca | **Sí** |
| `RENTAS_OWNER_JWT_SECRET` | `openssl rand -hex 32`, **nunca el mismo valor que `JWT_SECRET`** | Sí | Firma/verificación de tokens del portal de propietario de rentas — secreto DISTINTO al de staff a propósito (defensa en profundidad) | La API no arranca | **Sí** |
| `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_TTL_SECONDS` | número de segundos; default 900 / 2592000 | No | TTL de los tokens de staff | Usa el default | No |
| `RENTAS_OWNER_ACCESS_TOKEN_TTL_SECONDS` / `RENTAS_OWNER_REFRESH_TOKEN_TTL_SECONDS` | ídem, default 900 / 2592000 | No | TTL de los tokens del portal de propietario | Usa el default | No |
| `ALLOWED_ORIGINS` | lista separada por comas, p.ej. `https://app.tudominio.com` | No | Orígenes permitidos por CORS | Default `http://localhost:5173` | No |
| `APP_BASE_URL` | tu dominio real de `apps/web`, p.ej. `https://app.atiende.ai` | No | Arma el link `/aceptar-invitacion?token=...` dentro del correo de invitación de staff | Default `https://app.atiende.ai` (nunca bloquea la invitación, solo afecta el link) | No |

## Base de datos (Supabase Postgres)

| Variable | Dónde se obtiene | Secreta | Habilita | Sin ella | Arranque |
|---|---|:-:|---|---|:-:|
| `DATABASE_URL` | Supabase → Project Settings → Database → Connection string (usa el **pooler de transacción**, puerto 6543 — el modo Session/5432 se agota bajo cold starts de Vercel) | Sí | El motor Postgres completo — todas las rutas de negocio de las 6 verticales | `buildProductionDeps()` lanza al arrancar | **Sí** |

`SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` (la API
pública/administrativa de Supabase) **no aparecen** en `.env.example`: cero código
server-side de este repo las lee hoy (variable "documentada pero muerta" que se
quitó en esta pasada — ver más abajo).

## WhatsApp / Meta

| Variable | Dónde se obtiene | Secreta | Habilita | Sin ella | Arranque |
|---|---|:-:|---|---|:-:|
| `WHATSAPP_VERIFY_TOKEN` | lo eliges tú al configurar el webhook en Meta for Developers → tu App → WhatsApp → Configuration | Sí | Verificación (`hub.verify_token`) del webhook entrante | La API no arranca | **Sí** |
| `WHATSAPP_APP_SECRET` | Meta for Developers → tu App → Settings → Basic | Sí | Verifica la firma HMAC (`x-hub-signature-256`) de cada webhook entrante | La API no arranca | **Sí** |
| `WHATSAPP_ACCESS_TOKEN` | Meta for Developers → tu App → WhatsApp → API Setup | Sí | Envío SALIENTE real vía Graph API (`@atiende/whatsapp-gateway::MetaGraphWhatsAppClient`) | `deps.whatsAppDispatcher` queda `undefined`; `POST/GET /internal/whatsapp/dispatch` responde 503 explícito (`routes/internal/whatsapp-dispatch.ts`) | No |

Nota: `WHATSAPP_VERIFY_TOKEN`/`WHATSAPP_APP_SECRET` son obligatorias para
**arrancar la API entera**, aunque solo gatean el webhook ENTRANTE de 3 verticales
— así está escrito hoy en `env.ts::requireEnv`, sin fallback.

## Google

| Variable | Dónde se obtiene | Secreta | Habilita | Sin ella | Arranque |
|---|---|:-:|---|---|:-:|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud Console → APIs & Services → Credentials (un solo proyecto OAuth para toda la plataforma) | Sí (secret) | "Iniciar sesión con Google" de staff (`routes/auth-google.ts`) **y** sincronización de citas con Google Calendar (`packages/domain-citas/src/google-calendar-factory.ts`) — mismo proyecto OAuth para ambos usos | Login con Google deshabilitado; el resolver de Calendar devuelve "sin conectar" de inmediato (nunca error) y las rutas de conexión responden 503 | No |
| `GOOGLE_OAUTH_REDIRECT_BASE_URL` | tu dominio real (debe registrarse como redirect URI válida en el proyecto OAuth) | No | ídem | ídem | No |
| `GOOGLE_STAFF_AUTH_BASE_URL` / `GOOGLE_STAFF_TOKEN_URL` / `GOOGLE_STAFF_JWKS_URL` / `GOOGLE_STAFF_ISSUER` | no se tocan en desarrollo/producción real | No | Overrides de las 4 URLs de Google — solo existen para apuntar las pruebas de integración a un servidor OAuth FALSO local (`tests/support/fakeGoogleOAuth.ts`) | Usa las URLs reales de Google (default) | No |

Estas 4 URLs override **estaban leídas** por `env.ts` pero **no documentadas** en
`.env.example` antes de esta pasada — ya se agregaron.

## Resend (correo transaccional)

| Variable | Dónde se obtiene | Secreta | Habilita | Sin ella | Arranque |
|---|---|:-:|---|---|:-:|
| `RESEND_API_KEY` | Resend → API Keys | Sí | Envío real de correo — drena el canal `email` de `messaging_outbox` de citas/hoteles/restaurantes/despachos/licitaciones/rentas (`dispatchPendingEmailJobs` de cada dominio) | Cada job de correo falla explícito (nunca se marca `sent` sin que Resend lo haya aceptado) | No |
| `RESEND_FROM_EMAIL` | tu remitente verificado en Resend | No | Encabezado `From:` de esos correos | Default `atiende <notificaciones@atiende.ai>` | No |

## Stripe (suscripción SaaS de Atiende + cobro a huésped en hoteles)

Dos productos reales y distintos, **misma cuenta/key**:

| Variable | Dónde se obtiene | Secreta | Habilita | Sin ella | Arranque |
|---|---|:-:|---|---|:-:|
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys | Sí | (1) Checkout/webhook de la suscripción SaaS de Atiende a sus organizaciones clientes (`POST /billing/checkout`, `routes/billing.ts`) **y** (2) cobro con tarjeta al huésped de un folio de hoteles, PaymentIntents (`hotelesPaymentsPort`) | Ambos quedan `notProductionReady`/`undefined` — las rutas responden 503 honesto, nunca fingen un cobro | No |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Developers → Webhooks → tu endpoint (`whsec_...`, un secreto POR endpoint configurado, distinto de `STRIPE_SECRET_KEY` y que NO rota junto con ella) | Sí | Verifica la firma del webhook de (1) (`verificarFirmaWebhookStripe`) | `POST /billing/webhook` responde 503 explícito, nunca procesa un evento sin firma verificada | No |

## PACs de CFDI (timbrado fiscal de hospedaje, hoteles)

Basta con configurar **uno de los dos** (o ambos) para que timbrar/cancelar un
CFDI de hospedaje real funcione — `DualPacCfdiPort` ya conecta ambos adaptadores
reales desde `apps/api/src/production/deps.ts`. Sin ninguna de las dos, `timbrar`/
`cancelar`/`consultarEstado` lanzan `PortUnavailableError` incondicional, y
`apps/api/src/routes/verticals/hoteles/cfdi.ts` lo traduce a **503
`service_unavailable`** explícito (nunca un 500 genérico, nunca un timbrado
falso).

### Finkok

| Variable | Dónde se obtiene | Secreta |
|---|---|:-:|
| `FINKOK_USERNAME` / `FINKOK_PASSWORD` | cuenta de Finkok (facturacion.finkok.com) | Sí |
| `FINKOK_CSD_CERT_PATH` / `FINKOK_CSD_KEY_PATH` | **rutas de archivo** (no el contenido) al `.cer`/`.key` del Certificado de Sello Digital del SAT — el archivo debe existir en el filesystem del runtime que arranca `apps/api` | Sí (el archivo, no la ruta en sí) |
| `FINKOK_CSD_PASSWORD` | contraseña del CSD, dada de alta con el SAT | Sí |
| `FINKOK_WEBHOOK_SECRET` | Finkok, al configurar el webhook de notificaciones | Sí |

### SW Sapien

| Variable | Dónde se obtiene | Secreta |
|---|---|:-:|
| `SW_API_TOKEN` | cuenta de SW Sapien (services.sw.com.mx) | Sí |
| `SW_CSD_CERT_PATH` / `SW_CSD_KEY_PATH` | mismo criterio que Finkok — rutas de archivo del CSD | Sí (el archivo) |
| `SW_CSD_PASSWORD` | contraseña del CSD | Sí |
| `SW_WEBHOOK_SECRET` | SW Sapien, al configurar el webhook | Sí |

## Proveedores de LLM (Anthropic / OpenAI / OpenRouter)

Alimentan `LlmGateway` (compartido por los turn handlers de WhatsApp de
citas/hoteles/restaurantes y por la extracción de requisitos de licitaciones,
`apps/api/src/production/llm-gateway.ts`). Cada proveedor entra a la escalera
**solo si API key Y modelo están ambos configurados** — nunca se inventa un
modelo por defecto. Sin ningún proveedor configurado, los 3 turn handlers quedan
`notProductionReady` (503 honesto) y la extracción de licitaciones cae a solo
reglas deterministas.

| Variable | Dónde se obtiene | Secreta |
|---|---|:-:|
| `ANTHROPIC_API_KEY` | console.anthropic.com | Sí |
| `ANTHROPIC_MODEL` | id del modelo, p.ej. el que uses en producción | No |
| `OPENAI_API_KEY` | platform.openai.com | Sí |
| `OPENAI_MODEL` | id del modelo | No |
| `OPENROUTER_API_KEY` | openrouter.ai | Sí |
| `OPENROUTER_MODEL` | id del modelo enrutado | No |
| `OPENROUTER_COUNTRY_OF_RESIDENCE` | ISO 3166-1 alpha-2 del país de residencia legal del modelo pineado | No |

`OPENROUTER_COUNTRY_OF_RESIDENCE` alimentaría un **gate de residencia de datos**
(`packages/agent-core/src/gateway/residency.ts`, `DEFAULT_RESIDENCY_POLICY.enabled
= false`) pensado para requisitos de licitación de gobierno mexicano —
**verificado: ningún caller real de este repo lo activa hoy** (ni los turn
handlers de WhatsApp ni `LlmRequirementExtractor` de licitaciones). Configurarla o
no es indistinto para el comportamiento actual; no cuenta como "faltante" en
`computeIntegrationsStatus`.

## Voz (ElevenLabs)

Dos direcciones distintas que es fácil confundir:

1. **ENTRANTE** (ElevenLabs → nuestra API): `VOICE_TOOL_SECRET` (ver "Secretos
   propios" arriba) autentica las llamadas de las Server Tools que ElevenLabs
   invoca contra `routes/verticals/*/voice-tools.ts`. **No requiere ninguna API
   key de ElevenLabs** — nosotros somos el servicio siendo llamado.
2. **SALIENTE** (nuestro backend → API de ElevenLabs, para leer/actualizar la
   config del agente o listar voces): `packages/voice-gateway` ya tiene el
   provider real implementado (`ElevenLabsVoiceProvider`), pero **verificado: NO
   está conectado a ningún router de `apps/api` todavía** (cero imports reales
   del paquete fuera de comentarios). `ELEVENLABS_API_KEY` **no se lee en ningún
   código ejecutable de este repo** — solo se la menciona dentro de un
   comentario de `packages/voice-gateway/src/providers/elevenlabs-provider.ts`
   como ejemplo de "cómo la leería un script de desarrollo"; en producción el
   diseño real pasa la key vía `apiKeyProvider` inyectado, pensado para
   `supabase.rpc('get_secret', { secret_name: 'ELEVENLABS_API_KEY' })` (Supabase
   Vault), nunca una variable de entorno estática.

`ELEVENLABS_API_KEY` se deja en `.env.example` como placeholder para cuando ese
wiring exista, pero no aparece en `computeIntegrationsStatus`/el test guard
porque hoy no gatea ningún comportamiento real.

## Cal.com / CalDAV (citas)

**No aplica a este inventario de variables de entorno de plataforma.** Ambos son
credenciales **por-proveedor** (cada profesional conecta su propia cuenta de
Cal.com o su propio servidor CalDAV) almacenadas en Postgres
(`provider_calendar_accounts`/tablas equivalentes), nunca en una variable de
entorno global — ver `packages/domain-citas/src/calcom-port.ts` y
`caldav-port.ts`. Ambos adaptadores son código real de producción (no un stub),
listos para conectarse en cuanto el profesional dé de alta su cuenta desde la UI.

## Redis distribuido (Upstash) — infraestructura opcional

| Variable | Dónde se obtiene | Habilita | Sin ella |
|---|---|---|---|
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash console → tu base de datos Redis → REST API | Rate limiting **compartido** entre instancias serverless (`packages/core-ratelimit`, sí conectado — varias rutas llaman `rateLimit()`) | Cada instancia cuenta en memoria local (sigue protegiendo, no globalmente) |
| `UPSTASH_REDIS_URL` / `UPSTASH_REDIS_TOKEN` | mismo Upstash, mismo par de credenciales | Candado distribuido de conversación de WhatsApp (`packages/core-conversation::RedisLockStore`) | **HOY no tiene ningún efecto**: `apps/api/src/production/deps.ts::citasConversationGuard` usa el guard en memoria fijo, nunca instancia `RedisLockStore` |

**Hallazgo real** — inconsistencia de nombre entre dos paquetes que deberían
compartir el mismo Redis de Upstash: `core-ratelimit` lee
`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` (la convención oficial del
SDK REST de Upstash) pero `core-conversation` lee `UPSTASH_REDIS_URL`/
`UPSTASH_REDIS_TOKEN` (sin `_REST_`). Configurar solo el primer par (lo que
documenta la mayoría de guías de Upstash) deja el rate limiting distribuido
activo pero el candado de conversación se queda fail-open sin aviso — aunque
hoy es además discutible, porque `RedisLockStore` ni siquiera está conectado en
`apps/api` (ver fila de arriba). No se corrigió el nombre en este PR (no hay
comportamiento roto que arreglar sin antes decidir si vale la pena cablear
`RedisLockStore`) — queda documentado para que quien lo conecte use el nombre
correcto o unifique ambos pares.

## Mensajería de partners de rentas (Airbnb / Vrbo / Booking.com)

| Variable | Dónde se obtiene | Secreta |
|---|---|:-:|
| `AIRBNB_MESSAGING_API_TOKEN` | acuerdo de partner API con Airbnb (no una API key pública) | Sí |
| `VRBO_MESSAGING_API_TOKEN` | acuerdo de partner API con Vrbo | Sí |
| `BOOKING_MESSAGING_API_TOKEN` | acuerdo de partner API con Booking.com | Sí |

**Importante — configurar la credencial NO habilita el envío real todavía.**
`CanalMensajeriaPartnerPendiente.obtenerEstadoConexion()` pasa de
`"partner_pendiente"` a `"sandbox"` con la credencial presente, pero
`enviarMensajeAprobado()` **sigue lanzando siempre**: no existe todavía ningún
cliente HTTP real de la Messaging API de ninguno de los 3 partners en este
monorepo (a diferencia de `MetaGraphWhatsAppClient` para WhatsApp). Ver
`packages/domain-rentas/src/mensajeria/canalMensajeria.ts`.

Estas 3 variables **ya tienen nombre real en el código** — una versión anterior
de `.env.example`/`docs/DEPLOY.md` afirmaba "ningún nombre de variable definido
aún", lo cual dejó de ser cierto en algún momento sin que la documentación se
actualizara (corregido en esta pasada).

## Licitaciones — agregador comercial (Fase 9, "API por pegar")

| Variable | Dónde se obtiene | Secreta |
|---|---|:-:|
| `LICITACIONES_AGGREGATOR_API_KEY` | proveedor de agregación de licitaciones que se elija (sin elegir todavía) | Sí |
| `LICITACIONES_AGGREGATOR_BASE_URL` | URL base de la API de ese proveedor | No |

**Sin proveedor elegido todavía.** Las fuentes OCDS reales de este vertical
(Nuevo León, CDMX) no necesitan credenciales — son APIs/recursos públicos.
Este par de variables gatea únicamente `connectors/aggregator.ts`, la vía
para ampliar la cobertura más allá de Nuevo León/CDMX el día que se
contrate un agregador comercial (cobertura nacional). Sin AMBAS presentes,
el conector lanza `SourceNotConfiguredError` de inmediato — nunca intenta
una petición real ni finge cobertura que no existe. Ver
`packages/domain-licitaciones/src/connectors/aggregator.ts` para el
contrato de entrada documentado (`AggregatorTenderItem`) que espera el día
que se conecte un proveedor real, y el `README.md` de
`apps/worker/src/jobs/licitaciones/` para la tabla completa de estado por
fuente.

## apps/web (Vite, build-time)

| Variable | Habilita | Sin ella |
|---|---|---|
| `VITE_API_BASE_URL` | Base URL que el bundle usa para llamar a `apps/api` | Default `http://localhost:8787` en dev; `""` en producción cuando `apps/web`/`apps/api` comparten dominio de Vercel (rutas relativas) |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Supabase Realtime del panel de Agenda de citas (actualización en vivo) | El panel sigue funcionando con fetch manual (`getRealtimeClient()` → `null`, no rompe nada) |

Nota sobre el endpoint `GET /superadmin/integraciones`: estas 2 últimas variables
las lee **Vite en build time** del bundle de `apps/web`, no el proceso Node de
`apps/api` en cada request. El endpoint reporta el env del proyecto de Vercel al
momento de la consulta, que es el mismo que usará el **próximo build** — no
garantiza que el bundle YA DESPLEGADO las tenga si se configuraron después del
último build.

## Vercel (dashboard, no leído por el código)

| Variable | Dónde se da de alta | Notas |
|---|---|---|
| `CRON_SECRET` | Vercel → Project → Settings → Environment Variables — **con el MISMO valor que `INTERNAL_SECRET`** | **No la lee ningún código de este repo** (`grep` no encuentra `process.env.CRON_SECRET`) — es pura convención de Vercel: sus Cron Jobs invocan con `Authorization: Bearer $CRON_SECRET` automáticamente cuando esa variable existe en el proyecto. Sin ella (o con un valor distinto a `INTERNAL_SECRET`), los ~18 crons de `vercel.json` disparan pero cada corrida recibe 401. |

`scripts/verify-real-postgres-ci/run-gate.mjs` (fuera del alcance `apps/`/
`packages/` de este inventario) lee `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD` para
levantar un Postgres efímero de CI — config de la herramienta de CI, no de esta
app; no aparece en `.env.example`.

---

## Resultado del barrido: qué estaba mal antes de este PR

**53 variables de entorno reales** (leídas de verdad por código de `apps/` o
`packages/`) quedaron registradas en `apps/api/src/integrations-status.ts` y
`.env.example` coincide 1:1 con esa lista (más `ELEVENLABS_API_KEY`, dejada a
propósito como placeholder no funcional — ver sección "Voz").

**Sin documentar antes de este PR** (leídas por el código, ausentes de
`.env.example`):
- `GOOGLE_STAFF_AUTH_BASE_URL` / `GOOGLE_STAFF_TOKEN_URL` / `GOOGLE_STAFF_JWKS_URL` / `GOOGLE_STAFF_ISSUER`
- `AIRBNB_MESSAGING_API_TOKEN` / `VRBO_MESSAGING_API_TOKEN` / `BOOKING_MESSAGING_API_TOKEN` (el propio `.env.example` afirmaba que no tenían nombre todavía)

**Documentadas pero muertas** (en `.env.example`, cero código las lee):
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — quitadas de `.env.example` en este PR.

**Comentarios desactualizados corregidos** (afirmaban un estado que ya no era
cierto): la sección de Stripe decía que `packages/billing`/`STRIPE_WEBHOOK_SECRET`
"todavía no tenían caller real" — sí lo tienen (`routes/billing.ts`,
`production/saas-billing-stripe-port.ts`).

---

## Crons de Vercel — qué depende SOLO de la corrida diaria

`vercel.json` dispara sus ~18 crons **una vez al día** (plan Hobby). Verificado
leyendo el código si el envío real de WhatsApp/correo depende únicamente de esa
corrida diaria o si además hay un disparo inline al encolar:

### SÍ tienen disparo inline (no dependen solo del cron)

| Cron diario | Disparo inline (best-effort, en el mismo request que encoló) |
|---|---|
| `/internal/citas/email-dispatch` (14:05) | `triggerCitasEmailDispatchInline` — llamado desde `appointments.ts`, `appointments-lifecycle.ts` (×6), `whatsapp.ts` |
| `/internal/hoteles/email-dispatch` (14:15) | `triggerHotelesEmailDispatchInline` — llamado desde `folios.ts`, `reservas.ts`, `cfdi.ts` |
| `/internal/restaurantes/email-dispatch` (14:20) | `triggerRestaurantesEmailDispatchInline` — llamado desde `whatsapp.ts`, `public.ts` |
| `/internal/whatsapp/dispatch` (14:55) | `triggerCitasWhatsAppDispatchInline` / `triggerHotelesWhatsAppDispatchInline` / `triggerRestaurantesWhatsAppDispatchInline` (`routes/internal/whatsapp-dispatch.ts`) — cada webhook de WhatsApp de esas 3 verticales dispara su propio drenado inline justo después de encolar la respuesta |

Todas las 4 filas de arriba: el cron diario sigue existiendo como **red de
seguridad de respaldo** (recoge lo que el disparo inline no pudo enviar —
`WHATSAPP_ACCESS_TOKEN` caído, rate-limit de Graph API, el propio request
muriendo antes de disparar el drenado), pero un mensaje real casi siempre se
envía en segundos, no en hasta 24h.

### SOLO dependen del cron diario (sin disparo inline)

| Cron diario | Archivo:línea | Por qué importa |
|---|---|---|
| `/internal/despachos/email-dispatch` (14:30) | `apps/api/src/routes/verticals/despachos/notifications.ts:61` | Despachos no tiene agente de WhatsApp — solo correo. Sin disparo inline: un correo de despachos (p.ej. recordatorio de cobranza) puede tardar hasta ~24h en salir. |
| `/internal/rentas/email-dispatch` (14:35) | `apps/api/src/routes/verticals/rentas/email-dispatch.ts:22` | Mismo caso: rentas no tiene agente de WhatsApp, y esta ruta no tiene ningún `triggerRentasEmailDispatchInline` en todo el repo (verificado: cero resultados de `Inline` en `routes/verticals/rentas/*.ts`). |
| `/internal/licitaciones/email-dispatch` (08:00) | `apps/api/src/routes/verticals/licitaciones/alertNotifications.ts:68` | Mismo caso — cero `Inline` en `routes/verticals/licitaciones/*.ts`. |
| `/internal/licitaciones/discover-tenders`, `deadline-reminders`, `alert-notifications` (05:00/06:00/07:00) | `apps/worker/src/jobs/licitaciones/*.ts` | Por diseño son barridos de una vez al día (descubrir licitaciones nuevas, recordatorios de plazo), no colas de mensajes en tiempo real — un disparo inline no aplicaría aquí de la misma forma. |
| `/internal/hoteles/night-audit`, `/internal/citas/confirmacion-cita`, `/internal/despachos/cobranza-reminders`, `/internal/rentas/checkin-recordatorio`/`checkout-sweep`, `/internal/citas/google-calendar-sync`, `/internal/rentas/ical-sync` | varios | Mismo caso: barridos por-tiempo (auditoría nocturna, recordatorios, sincronización periódica), no colas de "algo que un usuario acaba de encolar" — el concepto de "disparo inline" no aplica igual que a un mensaje de WhatsApp/correo. |

**Conclusión accionable**: el envío real de correo de **despachos, rentas y
licitaciones** depende HOY únicamente de una corrida diaria (hasta ~24h de
demora en el peor caso) — a diferencia de citas/hoteles/restaurantes, que ya
tienen disparo inline best-effort. Si Javier quiere correo casi-inmediato para
esos 3 verticales (p.ej. confirmaciones al huésped/cliente), hace falta agregar
su propio `triggerXEmailDispatchInline` con el mismo patrón que
`hoteles/email-dispatch.ts`/`citas/email-dispatch.ts` — cambio de código, no de
credenciales, fuera de alcance de este PR. Esto **no** cambia la conclusión
sobre el límite de cron jobs del plan Hobby de Vercel (ver `docs/DEPLOY.md`): los
~18 crons ya existentes no se tocan aquí.
