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
| `VOICE_TOOL_SECRET` | `openssl rand -hex 32` | Sí | Autentica las llamadas ENTRANTES del worker de voz (header `x-atiende-tool-secret`) a las herramientas de voz de citas y restaurantes (`routes/verticals/*/voice-tools.ts`; hoteles usa un secreto por property) — ninguna vertical requiere ya una API key de ElevenLabs, ver sección "Voz" abajo | La API no arranca | **Sí** |
| `VOICE_REQUIRE_CALL_TOKEN` | `true` (opcional; vacío = apagado) | No | Las tools de voz de restaurantes exigen el token por llamada (`x-atiende-call-token`) y los secretos solo sirven para emitirlo. Actívalo DESPUÉS de aplicar la migración 026 y configurar la herramienta de voz (ver docs/DEPLOY.md) | Sigue aceptándose el secreto global sin token | No |
| `INTERNAL_SECRET` | `openssl rand -hex 32` | Sí | Autentica las ~18 rutas `/internal/*` que Vercel Cron invoca a diario (`Authorization: Bearer $CRON_SECRET`) o que se llaman a mano (header `x-atiende-internal-secret`) — ver `http-security.ts::internalOrCronSecretMatches` | La API no arranca | **Sí** |
| `RENTAS_OWNER_JWT_SECRET` | `openssl rand -hex 32`, **nunca el mismo valor que `JWT_SECRET`** | Sí | Firma/verificación de tokens del portal de propietario de rentas — secreto DISTINTO al de staff a propósito (defensa en profundidad) | La API no arranca | **Sí** |
| `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_TTL_SECONDS` | número de segundos; default 900 / 2592000 | No | TTL de los tokens de staff | Usa el default | No |
| `RENTAS_OWNER_ACCESS_TOKEN_TTL_SECONDS` / `RENTAS_OWNER_REFRESH_TOKEN_TTL_SECONDS` | ídem, default 900 / 2592000 | No | TTL de los tokens del portal de propietario | Usa el default | No |
| `SUPERADMIN_MFA_REQUIRED` | `1` o `true` | No | MFA TOTP obligatoria del superadmin: las acciones sensibles (`/superadmin/*` que mueven acceso, dinero, interruptores u organizaciones) exigen step-up verificado aunque el superadmin aun no haya enrolado (403 `mfa_enrollment_required`), y fallan cerrado si la migracion `0025` no esta aplicada. **No activarla hasta que cada superadmin haya enrolado su factor y la migracion este aplicada.** | Step-up solo para quien ya tiene un factor activo | No |
| `SUPERADMIN_MFA_ENCRYPTION_KEY` | `openssl rand -hex 32`, **distinta de `JWT_SECRET`** | Sí | Cifra (AES-256-GCM) el secreto TOTP de cada superadmin en la base | Se deriva de `JWT_SECRET`; rotar `JWT_SECRET` obliga a re-enrolar la MFA | No |
| `ALLOWED_ORIGINS` | lista separada por comas, p.ej. `https://app.tudominio.com` | No | Orígenes permitidos por CORS y por la guarda de Origin de `/auth/*` y `/superadmin/*` (el mismo origen del `Host`, y el de `APP_BASE_URL`, siempre pasan) | Default `http://localhost:5173` | No |
| `APP_BASE_URL` | tu dominio real de `apps/web`, p.ej. `https://app.atiende.ai` | No | Arma el link `/aceptar-invitacion?token=...` dentro del correo de invitación de staff | Default `https://app.atiende.ai` (nunca bloquea la invitación, solo afecta el link) | No |
| `TRUSTED_PROXY_IP_HEADER` | nombre de un header, p.ej. `cf-connecting-ip` (minúsculas) | No | Declara qué header de IP confiar como PRIMARIO en `http-security.ts::requestActor` (usado por todo rate-limit por IP de este repo) — solo tiene efecto si un proxy real y confiable (ej. Cloudflare) está delante de Vercel y garantiza que ESE header no lo puede escribir el cliente final. Hoy este despliegue es Vercel directo (sin evidencia de ningún proxy así en `vercel.json`), así que se deja SIN configurar a propósito. | Sin ella, se usa el último salto de `X-Forwarded-For` (el que Vercel mismo agrega, no falsificable) con `X-Real-IP` como respaldo — nunca `cf-connecting-ip` por defecto (ver hallazgo de revisión del PR #167: ese header, sin un proxy real delante, lo escribe el cliente). | No |

## Demostraciones públicas de agentes

`PUBLIC_DEMO_AGENTS_ENABLED=true` habilita `/v1/demo-agentes/:solution` para los nueve perfiles ficticios de marketing. Es una bandera no secreta, opcional y desactivada por defecto. Reutiliza `OPENROUTER_API_KEY` (chat), `GEMINI_API_KEY` (voz) y `DATABASE_URL` (límites atómicos); no requiere una organización real ni herramientas de negocio. Si falta un proveedor o falla el contador, el canal falla cerrado. Límites y contrato en [demo-agents/README.md](../apps/api/src/demo-agents/README.md).

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
| `WHATSAPP_APPROVED_TEMPLATES` | Nombres de las plantillas HSM que ya aprobó Meta (Business Manager → Plantillas de mensajes), separados por comas; las de estado de pedido están en `PLANTILLAS_ESTADO_PEDIDO` (`packages/domain-restaurantes/src/order-notifications.ts`) | No | Permite enviar el aviso proactivo de estado del pedido como `type: "template"` fuera de la ventana de 24 h (R-27) | Vacía: todo sale como texto libre (fuera de la ventana de 24 h Meta lo rechaza y el mensaje queda `dead`) | No |
| `LICITACIONES_WHATSAPP_PHONE_NUMBER_ID` | Meta for Developers → tu App → WhatsApp → API Setup (`phone_number_id` del número remitente) | No | Remitente de los avisos y botones go/no-go de licitaciones (L-05); el webhook entrante es `/v1/licitaciones/whatsapp/webhook` | El webhook acusa recibo sin procesar y el envío de licitaciones se omite (sin error) | No |
| `RENTAS_ACCESS_KEY` | La generas tú: `openssl rand -base64 32` (32 bytes en base64) y la guardas en un gestor de secretos con respaldo (no la reutilices de otra llave) | Sí | Cifrado AES-256-GCM en reposo de la dirección exacta, el código de acceso y las indicaciones de cada unidad de rentas (`@atiende/domain-rentas::acceso/cipher`, migración rentas 028) | Leer o guardar instrucciones (`/rentas/:propertyId/unidades/:unidadId/acceso-instrucciones`) responde 503 «no disponible: falta RENTAS_ACCESS_KEY»; la liberación al huésped no envía nada y queda como error del cron (`/internal/rentas/acceso-huesped`); nunca se guarda ni se muestra texto plano. Perder la llave vuelve ilegibles las instrucciones ya cifradas | No |
| `RENTAS_ICAL_FEED_UUID_LEGACY` | No es una credencial: interruptor que tú pones en Vercel (Production y Preview de la API) | No | Apaga la URL de exportación iCal por UUID (deprecada, `GET /rentas/:propertyId/unidades/:unidadId/canales/:canal/feed.ics`) cuando vale `off` (también `0` o `false`): responde 410. La URL nueva con token (`/rentas/feed/<token>.ics`) no depende de ella | Sin ella (o con cualquier otro valor) la URL por UUID sigue respondiendo con el encabezado `Deprecation`. La fecha de apagado la decide Javier: apagarla obliga a cada gestora a pegar la URL nueva en cada canal (ver `docs/DEPLOY.md`, «Rentas — conectividad de canales») | No |
| `HOTELES_IDENTITY_KEY` | La generas tú: `openssl rand -base64 32` (32 bytes en base64) y la guardas en un gestor de secretos con respaldo | Sí | Cifrado AES-256-GCM de la bóveda de identidad de hoteles (`@atiende/domain-hoteles::identity`, migración 031): captura y revelación de documentos | `POST /hoteles/:propertyId/identidad` y `.../revelar` responden 503 explícito (nunca se guarda un documento en claro); la lista avisa `llaveConfigurada:false`. Perder la llave vuelve ilegibles las identidades ya capturadas | No |

Estados de entrega (restaurantes): la app de Meta debe estar suscrita al campo **`messages`** del webhook (Meta for Developers → tu App → WhatsApp →
Configuration → Webhook fields → `messages` → Subscribe). Los `statuses` de entrega y lectura (`delivered`, `read`, `failed`) llegan por ese mismo campo al
mismo webhook firmado (`/v1/restaurantes/whatsapp/webhook`); sin la suscripcion los avisos fallidos no se detectan. No hay una variable nueva: usa
`WHATSAPP_APP_SECRET` y requiere aplicar la migracion `066_whatsapp_estados_entrega.sql` (ver `docs/PLANTILLAS-WHATSAPP.md`, "Estados de entrega").

#### WhatsApp multinúmero: variables opcionales (paquete 01)

Todas opcionales y `null`/vacías si no existen; ninguna bloquea el arranque. Las consumen la verificación de solo lectura y los paquetes de alta de números.

| Variable | De dónde sale | Para qué sirve | Si falta |
|---|---|---|---|
| `WHATSAPP_GRAPH_API_VERSION` | Versión de Graph API, formato `v23.0` (`^v\d{2}\.0$`) | Versión con la que envía `MetaGraphWhatsAppClient`. La `v21.0` se retira el 21-ene-2027 | Se usa el default del cliente (`v21.0`); un valor con otra forma se ignora con una advertencia |
| `META_APP_ID` | Meta for Developers → tu App → Settings → Basic | Comprobar que la app está suscrita a la WABA; Embedded Signup | La verificación marca "app no verificada" |
| `WHATSAPP_WABA_IDS` | WhatsApp Manager → ID de la cuenta de WhatsApp Business (varias, separadas por comas) | WABAs a revisar por defecto | Hay que pasar `--waba` al script |
| `WHATSAPP_ES_CONFIG_ID` | Meta for Developers → Facebook Login for Business → configuración de Embedded Signup v4 | Alta de números por Embedded Signup | Esa vía no está disponible |

Verificación de solo lectura (sin enviar nada): `scripts/verificar-meta-whatsapp/` (ver su README). Lee el token únicamente de `WHATSAPP_ACCESS_TOKEN` en el entorno de tu terminal.

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

## Alertas salientes (PL-04) — todas opcionales

| Variable | Dónde se obtiene | Secreta | Habilita | Sin ella | Arranque |
|---|---|:-:|---|---|:-:|
| `ALERTAS_EMAIL_DESTINATARIOS` | tú (correos separados por comas) | No | Aviso por correo (vía Resend, reusa `RESEND_API_KEY`) cuando un cron falla o el resumen diario detecta una alerta crítica | Canal de correo apagado | No |
| `ALERTAS_WEBHOOK_URL` | tu sistema receptor (Slack/Make/n8n/propio) | Sí (la URL suele llevar el token) | POST JSON de la alerta; solo `https`, nunca hacia hosts privados/loopback | Canal de webhook apagado | No |
| `ALERTAS_WEBHOOK_SECRETO` | tú (`openssl rand -hex 32`) | Sí | Firma `X-Atiende-Signature: sha256=HMAC(secreto, "<X-Atiende-Timestamp>.<cuerpo>")` | El webhook sale sin firma | No |
| `SENTRY_DSN` | Sentry → Project Settings → Client Keys | Sí | Evento por la API HTTP de envelopes (sin SDK) | Sentry apagado | No |
| `ALERTAS_LIMITE_POR_HORA` | tú | No | Máximo de avisos por (tipo de alerta, destino) en una hora; entero 1–60 | Default 2 | No |

Los datos sensibles (correos, teléfonos, tokens, JWT, URIs con credenciales, claves por nombre) se redactan
antes de salir por cualquier canal. El piso por hora usa Upstash Redis si `UPSTASH_REDIS_REST_URL/TOKEN`
están configuradas (global entre instancias); sin Redis cuenta **por instancia serverless** (el tope real es
entonces N por hora por instancia). Si Redis falla, el aviso sale (fail-open) en vez de perderse.

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

## Voz de restaurantes (Gemini 3.8 Live, backend propio)

| Variable | Dónde se obtiene | Secreta | Habilita | Sin ella | Arranque |
|---|---|:-:|---|---|:-:|
| `GEMINI_API_KEY` | Google AI Studio → API keys | Sí | El adaptador de Gemini pide un token efímero de un solo uso para el preview de voz del panel (`POST /v1/restaurantes/:propertyId/admin/voz/preview/sesion`); la llave nunca sale del servidor | La ruta responde 503 "voz no configurada" (nunca un falso éxito); configuración de voz y conversaciones siguen disponibles | No |
| `VOICE_PREVIEW_TOKEN_SECRET` | lo generas tú (mínimo 16 caracteres, p. ej. `openssl rand -hex 32`) | Sí | Firma (HMAC-SHA256) el token efímero de preview, ligado a organización + sucursal + sesión, y verifica `POST /internal/restaurantes/voz/previews/consumir` | Mismo 503 en la emisión y en la consumición | No |

Las rutas internas del registrador de conversaciones (`/internal/restaurantes/voz/...`) usan el
secreto ya existente `INTERNAL_SECRET` (header `x-atiende-internal-secret`).

## Proveedores de LLM (OpenRouter primario)

Alimentan `LlmGateway` (data-chat de las 6 verticales, turn handlers de WhatsApp,
extractores y borradores de licitaciones, conciliación de despachos,
`apps/api/src/production/llm-gateway.ts`). **OpenRouter es el proveedor primario y
único por defecto**: basta `OPENROUTER_API_KEY`; los modelos por rol salen de la
tabla versionada `apps/api/src/production/llm-models.ts` y `LLM_MODELS_JSON` los
sobreescribe sin redeploy de código. Arquitectura, tabla rol -> modelos, privacidad
y costos: `docs/LLM-GATEWAY.md`. Sin llave, los 3 turn handlers quedan
`notProductionReady` (503 honesto), el data-chat responde en modo sin IA y la
extracción de licitaciones cae a solo reglas deterministas.

| Variable | Dónde se obtiene | Secreta |
|---|---|:-:|
| `OPENROUTER_API_KEY` | openrouter.ai (fijar un límite de gasto y la política de datos en el panel al crearla) | Sí |
| `LLM_MODELS_JSON` | opcional: JSON `{"roles": {...}}` para cambiar modelos por rol (ver docs/LLM-GATEWAY.md) | No |
| `OPENROUTER_ZDR` | opcional: `1` exige endpoints Zero Data Retention (habilitarlo antes en la cuenta de OpenRouter) | No |
| `OPENROUTER_COUNTRY_OF_RESIDENCE` | opcional: ISO 3166-1 alpha-2 SOLO si confirmaste que la ruta cumple | No |
| `OPENAI_API_KEY` + `OPENAI_MODEL` | LEGADO: solo si no hay llave de OpenRouter | Sí / No |
| `PM_URL_FACTURACION` | enlace https de facturación en línea del negocio (Los Taquitos de PM); sin ella el agente no inventa uno y escala la factura a una persona | No |

**Modelos baratos del Copiloto (CHAT-05).** No hay variables nuevas: el modelo barato del chat (`*:data_chat`) y el escalado de la
cascada de cifras (`*:data_chat_retry`) se eligen con `LLM_MODELS_JSON` (validado: solo proveedores de EE.UU. con ZDR,
`data_collection: deny`, `require_parameters`; una ruta inválida se ignora con el error `llm_models_json_invalid` y ese rol conserva
su escalera actual). **Sin `LLM_MODELS_JSON` el comportamiento no cambia**: Luna -> DeepSeek V4.1 Flash -> Gemini 2.5 Flash-Lite ->
Muse Spark 1.3 y, para el reintento, DeepSeek V4 Pro. Candidatos del piloto del 1-oct-2026 (aún sin modelo que pase las puertas; no
se cambió el default): chat DeepSeek V4.1 Flash y GPT-6 Luna, respaldo Qwen3-235B-A22B y Mistral Small 3.2, reintento DeepSeek V4 Pro.
No elegibles hoy (sin ruta EE.UU./ZDR, el validador los rechaza): Qwen 3.7 Flash, Muse Spark 1.3 (contributor) y Llama 4 Maverick.
Ejemplo para el piloto (se aplica pegándolo en Vercel y redeploy de configuración; revertir = borrar la variable):

```json
{"roles":{
  "*:data_chat":{"models":[
    {"model":"deepseek/deepseek-v4.1-flash","reasoningEffort":"low","temperature":"omit","minMaxTokens":1500},
    {"model":"openai/gpt-6-luna","reasoningEffort":"low","temperature":"omit","minMaxTokens":1500},
    {"model":"mistralai/mistral-small-3.2-24b-instruct","temperature":"omit"}],
   "routing":{"allowFallbacks":true}},
  "*:data_chat_retry":{"models":[
    {"model":"deepseek/deepseek-v4-pro","reasoningEffort":"medium","temperature":"omit","minMaxTokens":3000}]}}}
```

Con Mistral Small 3.2 solo DeepInfra sirve con herramientas (Parasail no las lista): `require_parameters` excluye a Parasail del chat.
Antes de cambiar el primario, corre el eval propio (`docs/EVAL-COPILOTO.md`); la reserva de presupuesto usa la tabla de precios por modelo
(`packages/agent-core/src/gateway/prices.ts`) y el tope de salida real del escalón.

El proveedor directo de Anthropic (`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`) se
**retiró**: ignoraba las herramientas (`tools`) y no soportaba mensajes `role:tool`.
Los modelos Anthropic (Claude Sonnet 5.5 del copiloto de superadmin) pasan ahora por
OpenRouter. `OPENROUTER_MODEL` ya no se lee: el modelo sale de la tabla por rol.

`OPENROUTER_COUNTRY_OF_RESIDENCE` alimenta el **gate de residencia de datos**
(`packages/agent-core/src/gateway/residency.ts`, `DEFAULT_RESIDENCY_POLICY.enabled
= false`) pensado para requisitos de licitación de gobierno mexicano —
**verificado: ningún caller real de este repo lo activa hoy**. Configurarla o no es
indistinto para el comportamiento actual; no cuenta como "faltante" en
`computeIntegrationsStatus`.

## Voz de restaurantes, hoteles y citas (Gemini Live + LiveKit con respaldo en cascada OpenRouter, sin ElevenLabs)

Restaurantes dejó ElevenLabs el 1-oct-2026 y hoteles y citas el 3-oct-2026: los tres montan SU agente (persona, prompt, tools y guardias propias) sobre el
mismo esqueleto `packages/voice-core`, con UNA configuración de plataforma (`VOZ_PLATAFORMA`: escalera, modelos y precio por minuto), así que el costo
por minuto es el mismo en todas las verticales. Escalera híbrida: (1) Gemini Live directo (`GEMINI_API_KEY`) -> (2) cascada OpenRouter
(`OPENROUTER_API_KEY`, la misma llave del texto: STT -> Gemini por texto vía el gateway -> TTS) si Google falla o no hay llave -> (3) persona/buzón con
callback. `gpt-live-1` salió de la escalera (pedía otra llave). El costo de cada llamada se registra en `core.usage_cost_event` con el desglose por
escalon (`proveedor`). Hoteles autentica las tools del worker con el secreto POR PROPERTY (`hoteles.voice_agent_config`, rotación en el panel) y no usa
`VOICE_TOOL_SECRET`; citas usa `VOICE_TOOL_SECRET` (secreto de plataforma) y el negocio sale del `orgSlug` de la ruta `/v1/citas/:orgSlug/voz/:herramienta`. Variables, orden de activación, métricas y rollback de restaurantes están en `docs/VOZ-PM.md`. Resumen: `GEMINI_API_KEY` y `VOICE_PREVIEW_TOKEN_SECRET` (API), `VOICE_TOOL_SECRET` solo para emitir el token por
llamada, `VOICE_REQUIRE_CALL_TOKEN=true` al activar, y `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` más el trunk SIP de Twilio en el
host del worker de telefonía. Para **restaurantes** el worker existe en `apps/voice-worker` (variables `ATIENDE_API_URL`, `INTERNAL_SECRET`, `VOICE_DNIS_MAP` con un secreto por sucursal,
`VOICE_TOPE_MENSUAL_USD`, `VOICE_COSTO_MAX_LLAMADA_USD`, `GEMINI_API_KEY`/`OPENROUTER_API_KEY`, y las opcionales `GEMINI_BACKEND`/`VERTEX_*` y `VOICE_VAD_*`: ver `apps/voice-worker/README.md` y el checklist de llaves de `docs/VOZ-ACTIVACION.md`; sin ellas responde 503 en `/salud` y no contesta); para hoteles y citas todavía no existe.

## Voz: sin ElevenLabs en ninguna vertical

Ninguna vertical usa ya ElevenLabs y el repo nunca inició una llamada saliente hacia ellos: solo existen las rutas ENTRANTES que ejecuta el worker de
`voice-core` (`routes/verticals/<vertical>/voice-tools.ts`). `ELEVENLABS_API_KEY` no se lee en ningún código ni está en `.env.example`.

**`packages/voice-gateway` (retirado del árbol) — por qué se deprecó, no se conectó.** Ese paquete resolvía la dirección SALIENTE (nuestro backend -> API
de ElevenLabs/GPT-Live-1: signed URL de sesión, listado de voces, config de agente): cero imports reales fuera de comentarios/docs, ningún endpoint ni UI
lo consumía. El código quedó en el historial de git.

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
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash console → tu base de datos Redis → REST API | (1) Rate limiting **compartido** entre instancias serverless (`packages/core-ratelimit`, conectado — varias rutas llaman `rateLimit()`). (2) Candado distribuido de conversación de WhatsApp del vertical de **citas** (`packages/core-conversation::RedisLockStore`, conectado en `apps/api/src/production/deps.ts::citasConversationGuard` vía `createDefaultConversationGuard()`) — evita que 2 mensajes casi-simultáneos del mismo cliente disparen 2 llamadas al LLM en paralelo entre instancias de Vercel Fluid Compute. **UNA sola credencial activa las dos.** | Rate limiting: cada instancia cuenta en memoria local (sigue protegiendo, no globalmente). Lock de conversación de citas: `citasConversationGuard` degrada a un lock en memoria — sigue serializando DENTRO de una instancia, nunca entre instancias. |

**Corrección aplicada (fix/conversation-lock-upstash)** — antes había un
segundo par, `UPSTASH_REDIS_URL`/`UPSTASH_REDIS_TOKEN` (sin `_REST_`), que
SOLO `core-conversation` leía y que nadie tenía configurado (verificado contra
este mismo inventario); además `RedisLockStore` ni siquiera se instanciaba en
`apps/api` — pegar cualquiera de los dos pares no tenía ningún efecto en el
lock. Se unificó: `RedisLockStore` ahora lee las MISMAS
`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` que `core-ratelimit` (y
usa el mismo patrón de cliente, REST crudo por `fetch`, en vez del SDK
`@upstash/redis`) y `createDefaultConversationGuard()` lo conecta de verdad:
con las credenciales configuradas, usa `RedisLockStore`; sin ellas, usa
`InMemoryLockStore` (degradación explícita, no un fail-open silencioso).

**Por qué solo el vertical de citas necesita este lock** — restaurantes y
hoteles ya serializan mensajes casi-simultáneos del mismo cliente con una
lease atómica REAL en Postgres (`claim_whatsapp_conversation`, 120s, ver
`packages/domain-restaurantes/migrations/004_whatsapp_atomic_append_and_rate_limit.sql`
y el equivalente de hoteles), que protege entre instancias serverless por sí
sola — conectarles además el lock de Redis sería redundante. `citas` nunca
construyó esa lease (adoptó `@atiende/core-conversation` en su lugar, ver
`packages/domain-citas/src/whatsapp/inbound.ts`), así que ahí el lock de Redis
sí es la única defensa real contra 2 llamadas al LLM en paralelo por la misma
conversación entre instancias distintas. El `EXCLUDE USING gist` de
`citas.appointments` (Fase 1 §0.7) es una defensa en profundidad DISTINTA —
evita que 2 citas con horario traslapado lleguen a coexistir — pero no evita
la llamada doble al LLM ni una respuesta duplicada cuando el traslape de
horario no aplica (el cliente solo está platicando, cancelando o preguntando
disponibilidad).

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

**Actualización 19-sep-2026 (PR de deprecación de `packages/voice-gateway`):**
`ELEVENLABS_API_KEY` se retiró de `.env.example` — el placeholder existía solo
para el día en que `voice-gateway` se conectara, y ese paquete se retiró del
árbol (ver sección "Voz: sin ElevenLabs en ninguna vertical" arriba). El resto de
esta sección queda como registro histórico de la auditoría original.

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
corrida diaria o si además hay un disparo inline al encolar.

**Corregido en el barrido de documentación del 19-sep-2026: esta sección
afirmaba que despachos/rentas/licitaciones "SOLO dependen del cron diario, sin
disparo inline" — eso dejó de ser cierto con las mismas fases que agregaron
`triggerDespachosEmailDispatchInline`/`triggerRentasEmailDispatchInline`/
`triggerLicitacionesEmailDispatchInline` (ya en `main`; verificado de nuevo con
`git grep -n "EmailDispatchInline" -- apps/api/src`). Las 3 filas se movieron
abajo.**

### Tienen disparo inline desde una acción real de negocio (no dependen solo del cron)

| Cron diario | Disparo inline (best-effort, en el mismo request que encoló) |
|---|---|
| `/internal/citas/email-dispatch` (14:05) | `triggerCitasEmailDispatchInline` — llamado desde `appointments.ts`, `appointments-lifecycle.ts` (×6), `whatsapp.ts` |
| `/internal/hoteles/email-dispatch` (14:15) | `triggerHotelesEmailDispatchInline` — llamado desde `folios.ts`, `reservas.ts`, `cfdi.ts` |
| `/internal/restaurantes/email-dispatch` (14:20) | `triggerRestaurantesEmailDispatchInline` — llamado desde `whatsapp.ts`, `public.ts` |
| `/internal/despachos/email-dispatch` (14:30) | `triggerDespachosEmailDispatchInline` — llamado desde `vencimientos.ts` (`POST .../vencimientos/:id/escalar`, staff real) y desde el propio cron de `cobranza-reminders` (`notifications.ts`) |
| `/internal/rentas/email-dispatch` (14:35) | `triggerRentasEmailDispatchInline` — llamado desde `reservas.ts` (`POST .../reservas`, confirmación real al huésped) y desde el propio cron de `checkin-recordatorio.ts` |
| `/internal/whatsapp/dispatch` (14:55) | `triggerCitasWhatsAppDispatchInline` / `triggerHotelesWhatsAppDispatchInline` / `triggerRestaurantesWhatsAppDispatchInline` (`routes/internal/whatsapp-dispatch.ts`) — cada webhook de WhatsApp de esas 3 verticales dispara su propio drenado inline justo después de encolar la respuesta |

Todas las filas de arriba: el cron diario sigue existiendo como **red de
seguridad de respaldo** (recoge lo que el disparo inline no pudo enviar —
`WHATSAPP_ACCESS_TOKEN` caído, rate-limit de Graph API, el propio request
muriendo antes de disparar el drenado), pero un mensaje real casi siempre se
envía en segundos, no en hasta 24h.

### Disparo inline solo dentro de su propio cron (matiz, no "sin disparo inline")

| Cron diario | Detalle |
|---|---|
| `/internal/licitaciones/alert-notifications` (07:00) | `triggerLicitacionesEmailDispatchInline` — llamado DENTRO de esta misma ruta, justo después de encolar recordatorios de plazo/renovación/facturas vencidas (`runAlertNotificationSweep`). Corta la espera de hasta 1h (esperar al cron `/internal/licitaciones/email-dispatch` de las 08:00) a segundos, pero sigue acotado a la corrida diaria de las 07:00 — a diferencia de despachos/rentas arriba, licitaciones no tiene ninguna ruta de staff/usuario que dispare este drenado desde una acción real (no tiene WhatsApp ni un flujo equivalente a "escalar"/"reservar"). |

### Genuinamente solo dependen del cron diario (sin ningún disparo inline)

| Cron diario | Por qué importa |
|---|---|
| `/internal/licitaciones/discover-tenders`, `deadline-reminders` (05:00/06:00) | `apps/worker/src/jobs/licitaciones/*.ts` — barridos de una vez al día (descubrir licitaciones nuevas), no colas de mensajes; un disparo inline no aplicaría aquí de la misma forma. |
| `/internal/hoteles/night-audit`, `/internal/citas/confirmacion-cita`, `/internal/despachos/cobranza-reminders`, `/internal/rentas/checkin-recordatorio`/`checkout-sweep`, `/internal/citas/google-calendar-sync`, `/internal/rentas/ical-sync` | varios | Barridos por-tiempo (auditoría nocturna, recordatorios, sincronización periódica), no colas de "algo que un usuario acaba de encolar" — el concepto de "disparo inline" no aplica igual que a un mensaje de WhatsApp/correo. |
| `/internal/superadmin/resumen-diario` (09:00 local / 15:00 UTC) | Resumen diario automático de plataforma (`apps/api/src/resumen-diario/*`) — corre una vez al día, después de los demás crons, para reflejar el día ya asentado; no es una cola de mensajes de un tenant. |

**Conclusión actualizada**: las 6 verticales con canal de correo ya tienen
algún disparo inline best-effort hoy — citas/hoteles/restaurantes/despachos/
rentas desde una acción real de negocio (o desde su propio cron secundario),
licitaciones desde su propio cron de alertas. Ningún vertical depende ya
únicamente de la corrida diaria de `/internal/<vertical>/email-dispatch` para
su correo principal — lo que sí sigue acotado a una corrida diaria son los
barridos de descubrimiento/recordatorio de la tabla de arriba, por diseño (no
son colas de mensajes). Esto **no** cambia la conclusión sobre el límite de
cron jobs del plan Hobby de Vercel (ver `docs/DEPLOY.md`): los ~18 crons ya
existentes no se tocan aquí.
